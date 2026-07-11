/**
 * Shared utilities for the proactive system.
 *
 * Extracts duplicated logic from inner-thoughts.ts, gap-pipeline.ts,
 * gardener-scheduling.ts, and gardener-sleep-steps.ts.
 */

import { stripThinkTags } from '../utils/output-safety.js';

export { stripThinkTags } from '../utils/output-safety.js';

// ============ LLM Response Parsing ============

/**
 * Extract response text from LLM CompletionResponse content blocks.
 * Handles both ContentBlock[] and string responses. Thinking markup is
 * stripped so downstream JSON parsing sees only the actual answer.
 */
export function extractResponseText(content: unknown): string {
  const raw = Array.isArray(content)
    ? content
        .map((block: Record<string, unknown>) => 'text' in block ? block.text : '')
        .join('')
    : String(content);
  return stripThinkTags(raw);
}

/**
 * Extract the first JSON object from a string response.
 * Handles markdown wrapping (```json ... ```).
 * Returns null if no valid JSON found.
 */
export function extractJSON<T = Record<string, unknown>>(response: string): T | null {
  if (!response || response.trim().length === 0) return null;

  // Prefer an explicitly fenced ```json block when present.
  const fenced = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // fall through to brace scanning
    }
  }

  // Balanced-brace scan: try each top-level {...} candidate. The previous
  // greedy /\{[\s\S]*\}/ regex broke whenever surrounding prose (e.g. leaked
  // reasoning) contained a stray brace after the real JSON object.
  for (let start = response.indexOf('{'); start !== -1; start = response.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < response.length; i++) {
      const ch = response[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(response.slice(start, i + 1)) as T;
          } catch {
            break; // malformed candidate — try the next opening brace
          }
        }
      }
    }
  }

  return null;
}

// ============ Timezone Helpers ============

/**
 * Get the current hour (0-23) in the given IANA timezone.
 * Falls back to server local time if timezone is not provided or invalid.
 */
export function getHourInTimezone(nowMs: number, timezone?: string): number {
  if (!timezone) return new Date(nowMs).getHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const hourPart = parts.find(p => p.type === 'hour');
    // Intl hour12:false returns '24' for midnight in some locales — normalize to 0
    const h = parseInt(hourPart?.value ?? '', 10);
    return isNaN(h) ? new Date(nowMs).getHours() : h % 24;
  } catch {
    return new Date(nowMs).getHours();
  }
}

/** Get the local minute (0-59) for minute-accurate proactive timing. */
export function getMinuteInTimezone(nowMs: number, timezone?: string): number {
  if (!timezone) return new Date(nowMs).getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: 'numeric',
    }).formatToParts(new Date(nowMs));
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '', 10);
    return Number.isFinite(minute) ? minute : new Date(nowMs).getMinutes();
  } catch {
    return new Date(nowMs).getMinutes();
  }
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedDateTimeParts(
  formatter: Intl.DateTimeFormat,
  instantMs: number,
): ZonedDateTimeParts {
  const parts = formatter.formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const parsed = Number(parts.find(part => part.type === type)?.value);
    if (!Number.isFinite(parsed)) throw new Error(`Missing ${type} timezone part`);
    return parsed;
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    // Some ICU builds represent midnight as 24:00 even with a 24-hour
    // formatter. It denotes the same local date for offset calculation here.
    hour: value('hour') % 24,
    minute: value('minute'),
    second: value('second'),
  };
}

function timezoneOffsetMs(formatter: Intl.DateTimeFormat, instantMs: number): number {
  const local = zonedDateTimeParts(formatter, instantMs);
  const localFieldsAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const instantAtWholeSecond = Math.floor(instantMs / 1000) * 1000;
  return localFieldsAsUtc - instantAtWholeSecond;
}

/**
 * Get the start of the current local calendar day as epoch milliseconds.
 *
 * The timezone offset is resolved at local midnight, rather than subtracting
 * the current wall-clock hour. That distinction matters on DST transition
 * days, when midnight and "now" can have different UTC offsets.
 */
export function getTodayStartMs(timezone: string, nowMs?: number): number {
  try {
    const currentMs = nowMs ?? Date.now();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const localNow = zonedDateTimeParts(formatter, currentMs);
    const localMidnightFieldsAsUtc = Date.UTC(
      localNow.year,
      localNow.month - 1,
      localNow.day,
    );

    // Resolve the offset iteratively because the UTC-shaped initial guess can
    // lie on the other side of a DST boundary from local midnight.
    let midnightMs = localMidnightFieldsAsUtc;
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = localMidnightFieldsAsUtc - timezoneOffsetMs(formatter, midnightMs);
      if (next === midnightMs) break;
      midnightMs = next;
    }
    return midnightMs;
  } catch {
    // Fallback: midnight in server local time
    const now = new Date(nowMs ?? Date.now());
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
}
