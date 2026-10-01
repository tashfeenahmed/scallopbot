/**
 * Google Calendar over plain REST (no googleapis package).
 *
 * Auth is an OAuth2 refresh token from `scallopbot google-auth`; the access
 * token is minted per process and refreshed shortly before it expires.
 */
import type { CalendarEvent } from './types.js';
import type { FetchLike } from './ics.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
}

export function loadGoogleCalendarConfig(env: Record<string, string | undefined> = process.env): GoogleCalendarConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, calendarId: env.GOOGLE_CALENDAR_ID?.trim() || 'primary' };
}

export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
}

interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  recurringEventId?: string;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-10-02" -> all-day, "...Z"/"+01:00" -> instant, naive -> wall time in `timeZone`. */
export function toGoogleTime(value: string, timeZone: string, allDay?: boolean): GoogleTime {
  const trimmed = value.trim();
  if (allDay || DATE_ONLY.test(trimmed)) {
    const date = trimmed.slice(0, 10);
    if (!DATE_ONLY.test(date)) throw new Error(`Invalid all-day date "${value}" (use YYYY-MM-DD)`);
    return { date };
  }
  if (HAS_OFFSET.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return { dateTime: trimmed };
  const local = trimmed.match(LOCAL_DATETIME);
  if (local) return { dateTime: `${local[1]}T${local[2]}:${local[3]}:${local[4] ?? '00'}`, timeZone };
  throw new Error(`Invalid time "${value}". Use YYYY-MM-DD for all-day or YYYY-MM-DDTHH:MM (owner's timezone) or an ISO time with offset.`);
}

/** Default end: +1 hour for timed events, +1 day for all-day events. */
export function defaultEnd(start: GoogleTime): GoogleTime {
  if (start.date) {
    const next = new Date(`${start.date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { date: next.toISOString().slice(0, 10) };
  }
  const dateTime = start.dateTime!;
  if (start.timeZone) {
    // Naive wall time: add an hour on the wall clock and keep the zone.
    const shifted = new Date(`${dateTime}Z`);
    shifted.setUTCHours(shifted.getUTCHours() + 1);
    return { dateTime: shifted.toISOString().slice(0, 19), timeZone: start.timeZone };
  }
  return { dateTime: new Date(Date.parse(dateTime) + 3_600_000).toISOString() };
}

export function fromGoogleEvent(event: GoogleEvent): CalendarEvent {
  const allDay = Boolean(event.start?.date);
  const start = allDay ? event.start!.date! : new Date(event.start?.dateTime ?? 0).toISOString();
  const end = allDay
    ? event.end?.date ?? start
    : new Date(event.end?.dateTime ?? event.start?.dateTime ?? 0).toISOString();
  const result: CalendarEvent = {
    id: event.id,
    title: event.summary || '(no title)',
    start,
    end,
    allDay,
    source: 'google',
  };
  if (event.location) result.location = event.location;
  if (event.description) result.description = event.description.slice(0, 500);
  if (event.htmlLink) result.url = event.htmlLink;
  if (event.status) result.status = event.status;
  if (event.recurringEventId) result.recurring = true;
  const attendees = (event.attendees ?? []).map(attendee => attendee.email).filter((email): email is string => Boolean(email));
  if (attendees.length > 0) result.attendees = attendees.slice(0, 20);
  return result;
}

export class GoogleCalendarClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: GoogleCalendarConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !payload.access_token) {
      const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
      throw new Error(`Google token refresh failed: ${detail}. If the token was revoked or expired, run "scallopbot google-auth" again.`);
    }
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = this.now() + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${GOOGLE_CALENDAR_API}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`Google Calendar ${method} ${path} failed: HTTP ${response.status}${payload.error?.message ? ` ${payload.error.message}` : ''}`);
    }
    return payload as T;
  }

  private eventsPath(eventId?: string): string {
    const base = `/calendars/${encodeURIComponent(this.config.calendarId)}/events`;
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  async listEvents(options: { from: Date; to: Date; query?: string; limit?: number }): Promise<CalendarEvent[]> {
    const query: Record<string, string> = {
      timeMin: options.from.toISOString(),
      timeMax: options.to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(Math.max(options.limit ?? 25, 1), 250)),
    };
    if (options.query?.trim()) query.q = options.query.trim();
    const payload = await this.request<{ items?: GoogleEvent[] }>('GET', this.eventsPath(), { query });
    return (payload.items ?? []).filter(item => item.status !== 'cancelled').map(fromGoogleEvent);
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    return fromGoogleEvent(await this.request<GoogleEvent>('GET', this.eventsPath(eventId)));
  }

  async createEvent(input: EventInput, timeZone: string, notifyAttendees = false): Promise<CalendarEvent> {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.start?.trim()) throw new Error('start is required');
    const start = toGoogleTime(input.start, timeZone, input.all_day);
    const end = input.end?.trim() ? toGoogleTime(input.end, timeZone, input.all_day) : defaultEnd(start);
    const body: Record<string, unknown> = { summary: input.title.trim(), start, end };
    if (input.location) body.location = input.location;
    if (input.description) body.description = input.description;
    if (input.attendees?.length) body.attendees = input.attendees.map(email => ({ email }));
    const created = await this.request<GoogleEvent>('POST', this.eventsPath(), {
      query: { sendUpdates: notifyAttendees ? 'all' : 'none' },
      body,
    });
    return fromGoogleEvent(created);
  }

  async updateEvent(eventId: string, input: EventInput, timeZone: string, notifyAttendees = false): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.summary = input.title;
    if (input.location !== undefined) body.location = input.location;
    if (input.description !== undefined) body.description = input.description;
    if (input.attendees !== undefined) body.attendees = input.attendees.map(email => ({ email }));
    if (input.start) {
      const start = toGoogleTime(input.start, timeZone, input.all_day);
      body.start = start;
      body.end = input.end ? toGoogleTime(input.end, timeZone, input.all_day) : defaultEnd(start);
    } else if (input.end) {
      body.end = toGoogleTime(input.end, timeZone, input.all_day);
    }
    if (Object.keys(body).length === 0) throw new Error('Nothing to update: pass title, start, end, location, description or attendees');
    const updated = await this.request<GoogleEvent>('PATCH', this.eventsPath(eventId), {
      query: { sendUpdates: notifyAttendees ? 'all' : 'none' },
      body,
    });
    return fromGoogleEvent(updated);
  }

  async deleteEvent(eventId: string, notifyAttendees = false): Promise<void> {
    await this.request<void>('DELETE', this.eventsPath(eventId), {
      query: { sendUpdates: notifyAttendees ? 'all' : 'none' },
    });
  }
}
