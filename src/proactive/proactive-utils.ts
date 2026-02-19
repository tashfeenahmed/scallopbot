/**
 * Shared utilities for the proactive system.
 *
 * Extracts duplicated logic from inner-thoughts.ts, gap-pipeline.ts,
 * gardener-scheduling.ts, and gardener-sleep-steps.ts.
 */

// ============ LLM Response Parsing ============

/**
 * Extract response text from LLM CompletionResponse content blocks.
 * Handles both ContentBlock[] and string responses.
 */
export function extractResponseText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => 'text' in block ? block.text : '')
      .join('');
  }
  return String(content);
}

/**
 * Extract the first JSON object from a string response.
 * Handles markdown wrapping (```json ... ```).
 * Returns null if no valid JSON found.
 */
export function extractJSON<T = Record<string, unknown>>(response: string): T | null {
  if (!response || response.trim().length === 0) return null;

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
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

/**
 * Get the start of today (midnight) in the given timezone, as epoch ms.
 * Approximation: uses Intl to find the current local hour, then subtracts
 * that many hours from the current time (rounded down to the hour).
 */
export function getTodayStartMs(timezone: string, nowMs?: number): number {
  try {
    const now = new Date(nowMs ?? Date.now());
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    return now.getTime() - (hour * 3600_000 + minute * 60_000) - (now.getSeconds() * 1000) - now.getMilliseconds();
  } catch {
    // Fallback: midnight in server local time
    const now = new Date(nowMs ?? Date.now());
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
}
