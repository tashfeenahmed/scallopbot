/**
 * The `calendar` skill's actions and a source-agnostic "upcoming events"
 * reader shared with the proactive heads-up trigger.
 */
import { fetchIcs, parseIcsEvents, type FetchLike } from './ics.js';
import { GoogleCalendarClient, loadGoogleCalendarConfig, type EventInput } from './google.js';
import { describeWhen, isValidTimeZone, type CalendarEvent } from './types.js';

export interface CalendarArgs extends EventInput {
  action?: string;
  days?: number;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
  event_id?: string;
  notify_attendees?: boolean;
}

export interface CalendarDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeZone?: string;
  now?: () => Date;
}

export type CalendarSource =
  | { kind: 'google'; client: GoogleCalendarClient; calendarId: string }
  | { kind: 'ics'; url: string; fetchImpl: FetchLike }
  | { kind: 'none' };

export function resolveCalendarSource(deps: CalendarDeps = {}): CalendarSource {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const google = loadGoogleCalendarConfig(env);
  if (google) return { kind: 'google', client: new GoogleCalendarClient(google, fetchImpl), calendarId: google.calendarId };
  const url = env.CALENDAR_ICS_URL?.trim();
  if (url) return { kind: 'ics', url, fetchImpl };
  return { kind: 'none' };
}

export async function readEvents(
  source: CalendarSource,
  window: { from: Date; to: Date; query?: string; limit?: number; timeZone: string },
): Promise<CalendarEvent[]> {
  const limit = Math.min(Math.max(window.limit ?? 25, 1), 250);
  if (source.kind === 'google') {
    return source.client.listEvents({ from: window.from, to: window.to, query: window.query, limit });
  }
  if (source.kind === 'ics') {
    const events = parseIcsEvents(await fetchIcs(source.url, source.fetchImpl), {
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
    });
    const needle = window.query?.trim().toLowerCase();
    const filtered = needle
      ? events.filter(event => [event.title, event.location, event.description]
        .some(value => value?.toLowerCase().includes(needle)))
      : events;
    return filtered.slice(0, limit);
  }
  throw new Error('No calendar configured: set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN or CALENDAR_ICS_URL');
}

function parseBound(value: string | undefined, fallback: Date, label: string): Date {
  if (!value?.trim()) return fallback;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value.trim());
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${label} "${value}"`);
  return parsed;
}

function present(events: CalendarEvent[], timeZone: string) {
  return events.map(event => ({ ...event, when: describeWhen(event, timeZone) }));
}

const READ_ONLY_ICS = 'This calendar is a read-only ICS feed (CALENDAR_ICS_URL). Creating or changing events needs Google Calendar (GOOGLE_* settings).';

export async function executeCalendar(args: CalendarArgs, deps: CalendarDeps = {}): Promise<unknown> {
  const timeZone = isValidTimeZone(deps.timeZone) ? deps.timeZone : 'UTC';
  const now = deps.now?.() ?? new Date();
  const source = resolveCalendarSource(deps);
  const action = (args.action ?? '').trim().toLowerCase();
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 366);

  switch (action) {
    case 'upcoming':
    case 'search': {
      if (action === 'search' && !args.query?.trim()) throw new Error('query is required for search');
      const from = parseBound(args.from, action === 'search' ? new Date(now.getTime() - 30 * 86_400_000) : now, 'from');
      const to = parseBound(args.to, new Date(from.getTime() + (action === 'search' && !args.days ? 365 : days) * 86_400_000), 'to');
      const events = await readEvents(source, { from, to, query: args.query, limit: args.limit, timeZone });
      return {
        source: source.kind,
        timezone: timeZone,
        from: from.toISOString(),
        to: to.toISOString(),
        count: events.length,
        events: present(events, timeZone),
      };
    }
    case 'get': {
      if (source.kind !== 'google') throw new Error('get needs Google Calendar; use upcoming/search for ICS feeds');
      if (!args.event_id) throw new Error('event_id is required');
      const event = await source.client.getEvent(args.event_id);
      return { source: 'google', event: present([event], timeZone)[0] };
    }
    case 'create':
    case 'update':
    case 'delete': {
      if (source.kind === 'ics') throw new Error(READ_ONLY_ICS);
      if (source.kind !== 'google') throw new Error('No writable calendar configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN');
      const notify = args.notify_attendees === true;
      if (action === 'create') {
        const event = await source.client.createEvent(args, timeZone, notify);
        return { created: true, event: present([event], timeZone)[0] };
      }
      if (!args.event_id) throw new Error(`event_id is required for ${action}`);
      if (action === 'update') {
        const event = await source.client.updateEvent(args.event_id, args, timeZone, notify);
        return { updated: true, event: present([event], timeZone)[0] };
      }
      await source.client.deleteEvent(args.event_id, notify);
      return { deleted: true, event_id: args.event_id };
    }
    default:
      throw new Error(`Unknown action "${args.action ?? ''}". Use upcoming, search, get, create, update or delete.`);
  }
}
