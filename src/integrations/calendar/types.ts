export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO instant for timed events, YYYY-MM-DD for all-day events. */
  start: string;
  /** ISO instant for timed events, exclusive YYYY-MM-DD for all-day events. */
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
  status?: string;
  attendees?: string[];
  recurring?: boolean;
  source: 'google' | 'ics';
}

/** Wall-clock time in an IANA zone -> UTC instant. */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  let guess = naive;
  // Two passes settle DST transitions.
  for (let i = 0; i < 2; i++) guess = naive - timeZoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Offset of `timeZone` from UTC at `date`, in ms (positive east of UTC). */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string | undefined | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "Thu 2 Oct, 10:00-11:00" / "Fri 3 Oct (all day)" in the owner's zone. */
export function describeWhen(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>, timeZone: string): string {
  if (event.allDay) {
    const day = new Date(`${event.start}T12:00:00Z`);
    const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(day);
    return `${label} (all day)`;
  }
  const start = new Date(event.start);
  const end = new Date(event.end);
  const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const sameDay = dayFmt.format(start) === dayFmt.format(end);
  return sameDay
    ? `${dayFmt.format(start)}, ${timeFmt.format(start)}-${timeFmt.format(end)}`
    : `${dayFmt.format(start)} ${timeFmt.format(start)} - ${dayFmt.format(end)} ${timeFmt.format(end)}`;
}
