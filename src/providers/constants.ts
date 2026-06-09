/** Shared constants across all LLM providers.
 *  Operational knobs (retries, backoff) are env-overridable so they can be tuned
 *  in one place without touching provider code: PROVIDER_MAX_RETRIES, PROVIDER_RETRY_DELAY_MS. */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Maximum number of retry attempts for transient errors */
export const DEFAULT_MAX_RETRIES = envInt('PROVIDER_MAX_RETRIES', 6);

/** HTTP status codes that trigger automatic retry with backoff */
export const RETRY_STATUS_CODES = [429, 500, 503];

/** Base delay in ms between retries (doubled each attempt via exponential backoff) */
export const RETRY_DELAY_MS = envInt('PROVIDER_RETRY_DELAY_MS', 1000);
