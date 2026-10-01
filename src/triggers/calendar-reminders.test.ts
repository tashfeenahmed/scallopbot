import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { resolveCalendarSource } from '../integrations/calendar/actions.js';
import { CalendarReminders } from './calendar-reminders.js';

const feed = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:soon', 'DTSTART:20261001T091000Z', 'DTEND:20261001T100000Z', 'SUMMARY:Standup', 'LOCATION:Room 2', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:later', 'DTSTART:20261001T120000Z', 'DTEND:20261001T130000Z', 'SUMMARY:Lunch', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:allday', 'DTSTART;VALUE=DATE:20261001', 'SUMMARY:Holiday', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('calendar heads-up', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cal-reminders-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function reminders(now: Date) {
    const notifyOwner = vi.fn(async () => true);
    const source = resolveCalendarSource({
      env: { CALENDAR_ICS_URL: 'https://example.com/c.ics' },
      fetchImpl: async () => new Response(feed),
    });
    const instance = new CalendarReminders({
      source,
      leadMinutes: 15,
      timeZone: () => 'Europe/Dublin',
      notifyOwner,
      logger: pino({ level: 'silent' }),
      stateFile: join(dir, 'state.json'),
      now: () => now,
    });
    return { instance, notifyOwner };
  }

  it('announces timed events inside the lead window once, skipping all-day and later events', async () => {
    const { instance, notifyOwner } = reminders(new Date('2026-10-01T09:00:00Z'));
    expect(await instance.checkOnce()).toBe(1);
    expect(notifyOwner).toHaveBeenCalledWith('Coming up in 10 min: Standup at 10:10 (Room 2)');
    expect(await instance.checkOnce()).toBe(0);
  });

  it('remembers announcements across restarts', async () => {
    const now = new Date('2026-10-01T09:00:00Z');
    await reminders(now).instance.checkOnce();
    const second = reminders(now);
    expect(await second.instance.checkOnce()).toBe(0);
    expect(second.notifyOwner).not.toHaveBeenCalled();
  });
});
