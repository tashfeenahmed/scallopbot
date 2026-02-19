/**
 * Centralized configuration for the proactive system.
 *
 * All timing constants, budget caps, and thresholds in one place.
 * Import from here instead of scattering magic numbers across files.
 */

// ============ Timing ============

/** Scheduler check interval (main heartbeat) */
export const HEARTBEAT_MS = 30 * 1000;

/** Deep tick interval (~72 minutes) */
export const DEEP_TICK_MS = 72 * 60 * 1000;

/** Sleep tick interval (~20 hours) */
export const SLEEP_TICK_MS = 20 * 60 * 60 * 1000;

/** Default quiet hours (10 PM - 8 AM for scheduler, 2-5 AM for gardener sleep tick) */
export const DEFAULT_QUIET_HOURS = { start: 22, end: 8 } as const;

/** Default gardener quiet hours (tighter window for sleep tick) */
export const DEFAULT_GARDENER_QUIET_HOURS = { start: 2, end: 5 } as const;

// ============ Delivery ============

/** Minimum gap between proactive messages: 2 hours */
export const MIN_GAP_MS = 2 * 60 * 60 * 1000;

/** Maximum deferral: never defer more than 24 hours */
export const MAX_DEFERRAL_MS = 24 * 60 * 60 * 1000;

/** Urgent delivery delay: 5 minutes */
export const URGENT_DELAY_MS = 5 * 60 * 1000;

/** Active hours delivery delay: 15 minutes */
export const ACTIVE_DELAY_MS = 15 * 60 * 1000;

/** Default active hours when behavioral data is unavailable (9 AM - 9 PM) */
export const DEFAULT_ACTIVE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

/** Engagement window: mark proactive items as 'acted' if user responds within this */
export const ENGAGEMENT_WINDOW_MS = 15 * 60 * 1000;

// ============ Budgets ============

/** Per-dial daily notification budget caps */
export const DIAL_BUDGETS = {
  conservative: 1,
  moderate: 3,
  eager: 5,
} as const;

/** Hard cap: max items per evaluator run */
export const MAX_ITEMS_PER_EVAL = 3;

/** Cooldown between proactive evaluations: 6 hours */
export const PROACTIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Minimum session messages to warrant inner thoughts evaluation */
export const MIN_SESSION_MESSAGES = 3;

// ============ Queue ============

/** Outbound queue drain interval (safety net) */
export const DRAIN_INTERVAL_MS = 30 * 1000;

/** Maximum outbound queue size */
export const MAX_QUEUE_SIZE = 20;

// ============ Gap Scanner Thresholds ============

/** Days without update before a goal is considered stale */
export const STALE_GOAL_DAYS = 14;

/** Max age in days for scanning unresolved threads */
export const UNRESOLVED_MAX_AGE_DAYS = 7;

/** Follow-up window for unresolved threads: 48 hours */
export const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Hours before in_progress board items are considered stale */
export const STALE_IN_PROGRESS_HOURS = 48;

/** Hours before waiting board items are considered stale */
export const STALE_WAITING_HOURS = 72;

/** Check-in missed ratio threshold */
export const CHECKIN_RATIO_THRESHOLD = 3.0;

// ============ Scheduler ============

/** Default max age for expired scheduled items: 24 hours */
export const DEFAULT_MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;

/** Periodic dedup consolidation: every ~10 minutes (20 ticks at 30s) */
export const DEDUP_TICK_INTERVAL = 20;
