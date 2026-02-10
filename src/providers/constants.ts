/** Shared constants across all LLM providers */

/** Maximum number of retry attempts for transient errors */
export const DEFAULT_MAX_RETRIES = 3;

/** HTTP status codes that trigger automatic retry with backoff */
export const RETRY_STATUS_CODES = [429, 500, 503];

/** Base delay in ms between retries (doubled each attempt via exponential backoff) */
export const RETRY_DELAY_MS = 1000;
