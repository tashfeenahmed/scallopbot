/**
 * Read-only ICS feeds (Google "secret address", iCloud public calendars,
 * Outlook published calendars, Fastmail, Nextcloud export links, ...).
 *
 * Expands recurring events (RRULE/RDATE/EXDATE and RECURRENCE-ID overrides)
 * into concrete occurrences inside a window. Times are resolved from the
 * feed's VTIMEZONE blocks when present, otherwise from the TZID as an IANA
 * zone, otherwise (floating times) in the owner's timezone.
 */
import ICAL from 'ical.js';
import { isValidTimeZone, zonedTimeToUtc, type CalendarEvent } from './types.js';

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;

export interface IcsWindow {
  from: Date;
  to: Date;
  /** Zone for floating times and unknown TZIDs. Default UTC. */
  timeZone?: string;
}

const MAX_ITERATIONS = 20_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateOnly(time: IcalTime): string {
  return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
}

function toInstant(time: IcalTime, tzid: string | null, fallbackZone: string): Date {
  const zoneId = time.zone?.tzid;
  if (zoneId && zoneId !== 'floating') return new Date(time.toUnixTime() * 1000);
  if (tzid && ICAL.TimezoneService.has(tzid)) {
    const zoned = time.clone();
    zoned.zone = ICAL.TimezoneService.get(tzid)!;
    return new Date(zoned.toUnixTime() * 1000);
  }
  const zone = isValidTimeZone(tzid) ? tzid : fallbackZone;
  return zonedTimeToUtc(
    { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second },
    zone,
  );
}

function tzidOf(component: IcalComponent, property: string): string | null {
  const value = component.getFirstProperty(property)?.getParameter('tzid');
  return typeof value === 'string' ? value : null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

interface Occurrence {
  start: IcalTime;
  end: IcalTime;
  item: InstanceType<typeof ICAL.Event>;
}

function toEvent(
  occurrence: Occurrence,
  master: InstanceType<typeof ICAL.Event>,
  zone: string,
  recurring: boolean,
): { event: CalendarEvent; startMs: number; endMs: number } {
  const { item } = occurrence;
  const allDay = occurrence.start.isDate;
  const startTzid = tzidOf(item.component, 'dtstart') ?? tzidOf(master.component, 'dtstart');
  const endTzid = tzidOf(item.component, 'dtend') ?? startTzid;
  let start: string;
  let end: string;
  let startMs: number;
  let endMs: number;
  if (allDay) {
    start = dateOnly(occurrence.start);
    end = dateOnly(occurrence.end);
    if (end <= start) {
      const next = occurrence.start.clone();
      next.day += 1;
      end = dateOnly(next);
    }
    // All-day spans are compared in the owner's zone.
    startMs = zonedTimeToUtc({ year: occurrence.start.year, month: occurrence.start.month, day: occurrence.start.day }, zone).getTime();
    const [ey, em, ed] = end.split('-').map(Number);
    endMs = zonedTimeToUtc({ year: ey, month: em, day: ed }, zone).getTime();
  } else {
    const startDate = toInstant(occurrence.start, startTzid, zone);
    const endDate = toInstant(occurrence.end, endTzid, zone);
    startMs = startDate.getTime();
    endMs = Math.max(endDate.getTime(), startMs);
    start = startDate.toISOString();
    end = new Date(endMs).toISOString();
  }
  const status = text(item.component.getFirstPropertyValue('status'))?.toLowerCase();
  const url = text(item.component.getFirstPropertyValue('url'));
  const attendees = item.attendees
    .map(attendee => String(attendee.getFirstValue() ?? '').replace(/^mailto:/i, ''))
    .filter(Boolean);
  const event: CalendarEvent = {
    id: recurring ? `${master.uid}/${start}` : master.uid || `${start}:${item.summary}`,
    title: item.summary || '(no title)',
    start,
    end,
    allDay,
    source: 'ics',
  };
  if (text(item.location)) event.location = text(item.location);
  if (text(item.description)) event.description = text(item.description)!.slice(0, 500);
  if (url) event.url = url;
  if (status) event.status = status;
  if (attendees.length > 0) event.attendees = attendees.slice(0, 20);
  if (recurring) event.recurring = true;
  return { event, startMs, endMs };
}

/** Parse an ICS document and return events overlapping [from, to), sorted by start. */
export function parseIcsEvents(ics: string, window: IcsWindow): CalendarEvent[] {
  const zone = isValidTimeZone(window.timeZone) ? window.timeZone : 'UTC';
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid');
    if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(vtimezone);
  }

  const masters = new Map<string, IcalComponent>();
  const exceptions = new Map<string, IcalComponent[]>();
  const standalone: IcalComponent[] = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const uid = String(vevent.getFirstPropertyValue('uid') ?? '');
    if (vevent.hasProperty('recurrence-id')) {
      exceptions.set(uid, [...(exceptions.get(uid) ?? []), vevent]);
    } else if (uid && !masters.has(uid)) {
      masters.set(uid, vevent);
    } else {
      standalone.push(vevent);
    }
  }
  for (const [uid, list] of exceptions) {
    if (!masters.has(uid)) standalone.push(...list);
  }

  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const results: Array<{ event: CalendarEvent; startMs: number }> = [];
  const consider = (built: { event: CalendarEvent; startMs: number; endMs: number }) => {
    if (built.event.status === 'cancelled') return;
    const overlaps = built.endMs > fromMs && built.startMs < toMs
      || (built.endMs === built.startMs && built.startMs >= fromMs && built.startMs < toMs);
    if (overlaps) results.push(built);
  };

  for (const [uid, component] of masters) {
    const master = new ICAL.Event(component);
    for (const exception of exceptions.get(uid) ?? []) master.relateException(exception);
    if (!master.isRecurring()) {
      consider(toEvent({ start: master.startDate, end: master.endDate ?? master.startDate, item: master }, master, zone, false));
      continue;
    }
    const iterator = master.iterator();
    const startTzid = tzidOf(component, 'dtstart');
    for (let i = 0, next = iterator.next(); next && i < MAX_ITERATIONS; i++, next = iterator.next()) {
      const details = master.getOccurrenceDetails(next);
      const built = toEvent({ start: details.startDate, end: details.endDate, item: details.item }, master, zone, true);
      // The recurrence id (not the possibly moved start) decides when to stop.
      const recurrenceMs = next.isDate ? built.startMs : toInstant(next, startTzid, zone).getTime();
      if (recurrenceMs >= toMs && built.startMs >= toMs) break;
      consider(built);
    }
  }
  for (const component of standalone) {
    const event = new ICAL.Event(component);
    consider(toEvent({ start: event.startDate, end: event.endDate ?? event.startDate, item: event }, event, zone, false));
  }

  return results.sort((a, b) => a.startMs - b.startMs).map(entry => entry.event);
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchIcs(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const target = url.trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(target)) throw new Error('CALENDAR_ICS_URL must be an http(s) or webcal URL');
  const response = await fetchImpl(target, {
    headers: { accept: 'text/calendar, */*;q=0.5' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ICS feed returned HTTP ${response.status}`);
  const body = await response.text();
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error('ICS feed did not return a calendar (no BEGIN:VCALENDAR)');
  return body;
}
