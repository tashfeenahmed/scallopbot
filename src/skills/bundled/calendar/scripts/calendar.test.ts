import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseIcsEvents } from '../../../../integrations/calendar/ics.js';
import { executeCalendar } from '../../../../integrations/calendar/actions.js';
import { defaultEnd, toGoogleTime } from '../../../../integrations/calendar/google.js';
import { buildAuthUrl, codeFromRedirect, createPkcePair, exchangeCode } from '../../../../integrations/calendar/google-auth.js';
import { describeWhen, zonedTimeToUtc } from '../../../../integrations/calendar/types.js';
import { parseFrontmatter } from '../../../parser.js';
import { checkGates } from '../../../loader.js';
import { buildSkillSubprocessEnv } from '../../../executor.js';
import { assessToolCallForTurn } from '../../../../agent/tool-safety.js';
import { grantPatternFor } from '../../../../agent/approvals.js';
import type { Skill } from '../../../types.js';
import type { ToolUseContent } from '../../../../providers/types.js';

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body.trim().split('\n').map(l => l.trim()).join('\r\n')}\r\nEND:VCALENDAR\r\n`;

const VTIMEZONE_LONDON = `
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

describe('ICS parsing', () => {
  it('expands a weekly series with a TZID (no VTIMEZONE) across a DST change, honouring EXDATE', () => {
    const feed = ics(`
BEGIN:VEVENT
UID:standup
DTSTART;TZID=America/New_York:20261026T090000
DTEND;TZID=America/New_York:20261026T093000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=America/New_York:20261109T090000
SUMMARY:Standup
END:VEVENT`);
    const events = parseIcsEvents(feed, { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') });
    // New York leaves DST on 1 Nov 2026: 09:00 EDT = 13:00Z, 09:00 EST = 14:00Z.
    expect(events.map(e => e.start)).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-16T14:00:00.000Z',
    ]);
    expect(events[0]).toMatchObject({ title: 'Standup', end: '2026-10-26T13:30:00.000Z', recurring: true, allDay: false, source: 'ics' });
    expect(new Set(events.map(e => e.id)).size).toBe(3);
  });

  it('uses VTIMEZONE definitions and applies RECURRENCE-ID overrides and cancellations', () => {
    const feed = ics(`${VTIMEZONE_LONDON}
BEGIN:VEVENT
UID:gym
DTSTART;TZID=Europe/London:20261020T180000
DTEND;TZID=Europe/London:20261020T190000
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:Gym
END:VEVENT
BEGIN:VEVENT
UID:gym
RECURRENCE-ID;TZID=Europe/London:20261027T180000
DTSTART;TZID=Europe/London:20261028T070000
DTEND;TZID=Europe/London:20261028T080000
SUMMARY:Gym (moved)
END:VEVENT
BEGIN:VEVENT
UID:gym
RECURRENCE-ID;TZID=Europe/London:20261103T180000
DTSTART;TZID=Europe/London:20261103T180000
DTEND;TZID=Europe/London:20261103T190000
STATUS:CANCELLED
SUMMARY:Gym
END:VEVENT`);
    const events = parseIcsEvents(feed, { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') });
    expect(events.map(e => [e.title, e.start])).toEqual([
      ['Gym', '2026-10-20T17:00:00.000Z'], // BST
      ['Gym (moved)', '2026-10-28T07:00:00.000Z'], // GMT after 25 Oct
      ['Gym', '2026-11-10T18:00:00.000Z'],
    ]);
  });

  it('keeps all-day events as dates (end exclusive) and filters by window in the owner zone', () => {
    const feed = ics(`
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261007
DTEND;VALUE=DATE:20261009
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:bday
DTSTART;VALUE=DATE:20261012
SUMMARY:Birthday
RRULE:FREQ=YEARLY
END:VEVENT`);
    const events = parseIcsEvents(feed, { from: new Date('2026-10-08T00:00:00Z'), to: new Date('2027-10-13T00:00:00Z'), timeZone: 'Asia/Karachi' });
    expect(events.map(e => [e.title, e.start, e.end, e.allDay])).toEqual([
      ['Holiday', '2026-10-07', '2026-10-09', true],
      ['Birthday', '2026-10-12', '2026-10-13', true],
      ['Birthday', '2027-10-12', '2027-10-13', true],
    ]);
    expect(describeWhen(events[0], 'Asia/Karachi')).toBe('Wed 7 Oct (all day)');
  });

  it('reads UTC times as instants and floating times in the owner timezone', () => {
    const feed = ics(`
BEGIN:VEVENT
UID:utc
DTSTART:20261005T150000Z
DTEND:20261005T160000Z
SUMMARY:Call
LOCATION:Zoom
END:VEVENT
BEGIN:VEVENT
UID:floating
DTSTART:20261005T090000
DTEND:20261005T100000
SUMMARY:Breakfast
END:VEVENT`);
    const events = parseIcsEvents(feed, { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z'), timeZone: 'Asia/Tokyo' });
    expect(events.map(e => [e.title, e.start])).toEqual([
      ['Breakfast', '2026-10-05T00:00:00.000Z'],
      ['Call', '2026-10-05T15:00:00.000Z'],
    ]);
    expect(events[1].location).toBe('Zoom');
  });

  it('converts wall time to UTC around DST gaps', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 12 }, 'Europe/Dublin').toISOString()).toBe('2026-07-01T11:00:00.000Z');
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 12 }, 'Europe/Dublin').toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });
});

describe('calendar skill via ICS feed', () => {
  const feed = ics(`
BEGIN:VEVENT
UID:a
DTSTART:20261002T100000Z
DTEND:20261002T110000Z
SUMMARY:Dentist
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART:20261003T100000Z
DTEND:20261003T110000Z
SUMMARY:Team lunch
END:VEVENT`);
  const fetchImpl = vi.fn(async (url: string) => {
    expect(url).toBe('https://cal.example.com/feed.ics');
    return new Response(feed, { status: 200 });
  });
  const deps = { env: { CALENDAR_ICS_URL: 'webcal://cal.example.com/feed.ics' }, fetchImpl, timeZone: 'Europe/Dublin', now: () => new Date('2026-10-01T12:00:00Z') };

  it('lists upcoming events with a human "when" in the owner zone', async () => {
    const result = await executeCalendar({ action: 'upcoming', days: 7 }, deps) as any;
    expect(result.source).toBe('ics');
    expect(result.events.map((e: any) => [e.title, e.when])).toEqual([
      ['Dentist', 'Fri 2 Oct, 11:00-12:00'],
      ['Team lunch', 'Sat 3 Oct, 11:00-12:00'],
    ]);
  });

  it('searches by text', async () => {
    const result = await executeCalendar({ action: 'search', query: 'lunch' }, deps) as any;
    expect(result.events.map((e: any) => e.title)).toEqual(['Team lunch']);
  });

  it('refuses writes on a read-only feed', async () => {
    await expect(executeCalendar({ action: 'create', title: 'x', start: '2026-10-05' }, deps)).rejects.toThrow(/read-only ICS feed/);
  });
});

describe('Google Calendar (mocked HTTP)', () => {
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh', GOOGLE_CALENDAR_ID: 'me@example.com' };

  function googleFetch() {
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, body: init?.body as string | undefined, auth: headers.authorization });
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'access-1', expires_in: 3600 });
      }
      if (method === 'GET') {
        return Response.json({ items: [
          { id: 'ev1', summary: 'Standup', start: { dateTime: '2026-10-02T09:00:00+01:00' }, end: { dateTime: '2026-10-02T09:15:00+01:00' }, recurringEventId: 'series' },
          { id: 'ev2', summary: 'Off', start: { date: '2026-10-03' }, end: { date: '2026-10-04' } },
          { id: 'ev3', status: 'cancelled', summary: 'Gone', start: { date: '2026-10-03' }, end: { date: '2026-10-04' } },
        ] });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const sent = JSON.parse(String(init?.body ?? '{}'));
      return Response.json({ id: 'new1', htmlLink: 'https://calendar.google.com/x', ...sent });
    });
    return { calls, impl };
  }

  it('refreshes the token once and lists single events in a window', async () => {
    const { calls, impl } = googleFetch();
    const result = await executeCalendar({ action: 'upcoming', days: 3 }, { env, fetchImpl: impl, timeZone: 'Europe/Dublin', now: () => new Date('2026-10-01T12:00:00Z') }) as any;
    expect(calls[0].body).toContain('grant_type=refresh_token');
    const list = new URL(calls[1].url);
    expect(list.pathname).toBe('/calendar/v3/calendars/me%40example.com/events');
    expect(list.searchParams.get('singleEvents')).toBe('true');
    expect(list.searchParams.get('timeMin')).toBe('2026-10-01T12:00:00.000Z');
    expect(list.searchParams.get('timeMax')).toBe('2026-10-04T12:00:00.000Z');
    expect(calls[1].auth).toBe('Bearer access-1');
    expect(result.events.map((e: any) => [e.id, e.start, e.allDay, e.when])).toEqual([
      ['ev1', '2026-10-02T08:00:00.000Z', false, 'Fri 2 Oct, 09:00-09:15'],
      ['ev2', '2026-10-03', true, 'Sat 3 Oct (all day)'],
    ]);
    expect(result.events[0].recurring).toBe(true);
  });

  it('creates an event in the owner timezone with a default 1h end and no invite emails', async () => {
    const { calls, impl } = googleFetch();
    const result = await executeCalendar(
      { action: 'create', title: 'Dentist', start: '2026-10-08T09:30', location: 'Main St' },
      { env, fetchImpl: impl, timeZone: 'Europe/Dublin' },
    ) as any;
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/events'))!;
    expect(new URL(post.url).searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(post.body!)).toEqual({
      summary: 'Dentist',
      start: { dateTime: '2026-10-08T09:30:00', timeZone: 'Europe/Dublin' },
      end: { dateTime: '2026-10-08T10:30:00', timeZone: 'Europe/Dublin' },
      location: 'Main St',
    });
    expect(result.created).toBe(true);
  });

  it('patches and deletes by event id', async () => {
    const { calls, impl } = googleFetch();
    await executeCalendar({ action: 'update', event_id: 'ev1', title: 'Standup (short)' }, { env, fetchImpl: impl, timeZone: 'UTC' });
    const deleted = await executeCalendar({ action: 'delete', event_id: 'ev1' }, { env, fetchImpl: impl, timeZone: 'UTC' }) as any;
    expect(calls.filter(c => c.url.includes('/events/ev1')).map(c => c.method)).toEqual(['PATCH', 'DELETE']);
    expect(JSON.parse(calls.find(c => c.method === 'PATCH')!.body!)).toEqual({ summary: 'Standup (short)' });
    expect(deleted).toEqual({ deleted: true, event_id: 'ev1' });
  });

  it('explains a revoked refresh token', async () => {
    const impl = vi.fn(async () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }));
    await expect(executeCalendar({ action: 'upcoming' }, { env, fetchImpl: impl, timeZone: 'UTC' }))
      .rejects.toThrow(/expired or revoked.*google-auth/);
  });

  it('parses times: all-day, offset, naive', () => {
    expect(toGoogleTime('2026-10-08', 'UTC')).toEqual({ date: '2026-10-08' });
    expect(toGoogleTime('2026-10-08T09:00:00+02:00', 'UTC')).toEqual({ dateTime: '2026-10-08T09:00:00+02:00' });
    expect(toGoogleTime('2026-10-08 23:30', 'Asia/Tokyo')).toEqual({ dateTime: '2026-10-08T23:30:00', timeZone: 'Asia/Tokyo' });
    expect(defaultEnd({ dateTime: '2026-10-08T23:30:00', timeZone: 'Asia/Tokyo' })).toEqual({ dateTime: '2026-10-09T00:30:00', timeZone: 'Asia/Tokyo' });
    expect(defaultEnd({ date: '2026-12-31' })).toEqual({ date: '2027-01-01' });
    expect(() => toGoogleTime('next tuesday', 'UTC')).toThrow(/Invalid time/);
  });
});

describe('google-auth helper', () => {
  it('builds an offline PKCE consent URL and validates the redirect state', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).not.toBe(challenge);
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', scope: 's', state: 'st', challenge }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(codeFromRedirect('http://127.0.0.1:5555/?state=st&code=abc', 'st')).toBe('abc');
    expect(() => codeFromRedirect('/?state=other&code=abc', 'st')).toThrow(/State mismatch/);
    expect(() => codeFromRedirect('/?error=access_denied&state=st', 'st')).toThrow(/access_denied/);
  });

  it('exchanges the code for a refresh token', async () => {
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('code_verifier=v');
      return Response.json({ refresh_token: 'r1', scope: 'https://www.googleapis.com/auth/calendar.events' });
    });
    await expect(exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1', fetchImpl: impl }))
      .resolves.toEqual({ refreshToken: 'r1', scope: 'https://www.googleapis.com/auth/calendar.events' });
  });
});

describe('calendar skill gating and approval', () => {
  const frontmatter = parseFrontmatter(readFileSync(join(__dirname, '..', 'SKILL.md'), 'utf8')).frontmatter;
  const skill = { name: 'calendar', frontmatter } as unknown as Skill;
  const create = (title = 'Dentist'): ToolUseContent => ({
    type: 'tool_use', id: 'c1', name: 'calendar', input: { action: 'create', title, start: '2026-10-08T09:30' },
  });

  it('is available with either Google or an ICS URL, and passes the optional Google vars through', () => {
    const saved = { ...process.env };
    try {
      delete process.env.GOOGLE_REFRESH_TOKEN;
      delete process.env.CALENDAR_ICS_URL;
      expect(checkGates(frontmatter.metadata).available).toBe(false);
      process.env.CALENDAR_ICS_URL = 'https://example.com/a.ics';
      expect(checkGates(frontmatter.metadata).available).toBe(true);
      process.env.GOOGLE_CLIENT_ID = 'cid';
      process.env.OPENAI_API_KEY = 'must-not-leak';
      const env = buildSkillSubprocessEnv({ ...skill, scriptsDir: '/tmp/x/scripts' } as Skill, { args: {} } as any);
      expect(env.CALENDAR_ICS_URL).toBe('https://example.com/a.ics');
      expect(env.GOOGLE_CLIENT_ID).toBe('cid');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it('blocks writes until approved; reads pass', () => {
    const turn = { userMessage: 'Add my dentist appointment on 8 Oct at 9:30', timezone: 'UTC' };
    expect(assessToolCallForTurn(create(), turn, skill).allowed).toBe(false);
    const upcoming = { type: 'tool_use', id: 'u', name: 'calendar', input: { action: 'upcoming', days: 2 } } as ToolUseContent;
    expect(assessToolCallForTurn(upcoming, turn, skill).allowed).toBe(true);
    const pattern = grantPatternFor(create())!;
    expect(pattern).toMatch(/^calendar:create#/);
    const grants = (p: string) => p === pattern;
    expect(assessToolCallForTurn(create(), { ...turn, userMessage: 'yes', grants }, skill).allowed).toBe(true);
    expect(assessToolCallForTurn(create('Something else'), { ...turn, userMessage: 'yes', grants }, skill).allowed).toBe(false);
  });
});
