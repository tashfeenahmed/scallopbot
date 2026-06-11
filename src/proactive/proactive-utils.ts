/**
 * Shared utilities for the proactive system.
 *
 * Extracts duplicated logic from inner-thoughts.ts, gap-pipeline.ts,
 * gardener-scheduling.ts, and gardener-sleep-steps.ts.
 */

// ============ LLM Response Parsing ============

/**
 * Strip inline thinking/reasoning markup that local models (qwen3.6 via
 * llama.cpp, GLM, DeepSeek-style) emit in their visible text. Handles both
 * closed `<think>...</think>` blocks and an unterminated leading `<think>`
 * (which happens when max_tokens cuts the response off mid-reasoning).
 */
export function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unterminated think block: everything after the orphan tag is reasoning.
  const orphan = out.search(/<think>/i);
  if (orphan !== -1) out = out.slice(0, orphan);
  // Some models close a block they never opened (prefix reasoning).
  const orphanClose = out.search(/<\/think>/i);
  if (orphanClose !== -1) out = out.slice(orphanClose + '</think>'.length);
  return out.trim();
}

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
