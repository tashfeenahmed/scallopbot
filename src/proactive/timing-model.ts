/**
 * Timing model for proactive message delivery.
 *
 * Pure functions that determine the optimal delivery time for proactive
 * messages, respecting quiet hours, preferring user active hours, and
 * handling urgency levels.
 *
 * Follows trust-score.ts pattern: constants at top, exported interfaces,
 * pure functions with injectable `now` for deterministic testing.
 */

// ============ Constants ============

/** Default active hours when behavioral data is unavailable (9 AM - 9 PM) */
export const DEFAULT_ACTIVE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

/** Minimum gap between proactive messages: 2 hours in milliseconds */
export const MIN_GAP_MS = 2 * 60 * 60 * 1000;

/** Maximum deferral: never defer more than 24 hours */
export const MAX_DEFERRAL_MS = 24 * 60 * 60 * 1000;

/** Urgent delivery delay: 5 minutes */
export const URGENT_DELAY_MS = 5 * 60 * 1000;

/** Active hours delivery delay: 15 minutes */
export const ACTIVE_DELAY_MS = 15 * 60 * 1000;

/** Fallback delivery delay: 30 minutes (legacy behavior) */
const FALLBACK_DELAY_MS = 30 * 60 * 1000;

/** Milliseconds per hour */
const HOUR_MS = 60 * 60 * 1000;

// ============ Interfaces ============

export interface TimingContext {
  userActiveHours: number[];
  quietHours: { start: number; end: number };
  lastProactiveAt: number | null;
  currentHour: number;
  urgency: 'low' | 'medium' | 'high';
  now: number;
}

export interface DeliveryTiming {
  deliverAt: number;
  reason: string;
  strategy: 'urgent_now' | 'active_hours' | 'next_active' | 'next_morning';
}

// ============ Functions ============

/**
 * Check if a given hour falls within quiet hours.
 *
 * Handles wrap-around (e.g., start: 23, end: 5 means 23,0,1,2,3,4 are quiet).
 * If start === end, there are no quiet hours (returns false).
 */
export function isInQuietHours(
  hour: number,
  quiet: { start: number; end: number },
): boolean {
  if (quiet.start === quiet.end) return false;

  if (quiet.start < quiet.end) {
    // Simple range: e.g., 2-5
    return hour >= quiet.start && hour < quiet.end;
  }

  // Wrap-around: e.g., 23-5 means 23,0,1,2,3,4 are quiet
  return hour >= quiet.start || hour < quiet.end;
}

/**
 * Compute the optimal delivery time for a proactive message.
 *
 * Strategy priority (evaluated in order):
 * 1. urgent_now: urgency === 'high' AND NOT in quiet hours -> now + 5 min
 * 2. next_morning: in quiet hours -> first hour after quiet end, at :00
 * 3. active_hours: currentHour in activeHours -> now + 15 min
 * 4. next_active: outside active hours -> next active hour at :00
 * 5. Fallback: now + 30 min (legacy behavior)
 *
 * Minimum gap enforcement: if lastProactiveAt is set and deliverAt - lastProactiveAt < 2h,
 * push deliverAt to lastProactiveAt + 2h. Exception: high urgency bypasses gap.
 *
 * Maximum deferral: if deliverAt > now + 24h, cap at now + 24h.
 */
export function computeDeliveryTime(context: TimingContext): DeliveryTiming {
  const { now, currentHour, urgency, quietHours, lastProactiveAt } = context;
  const activeHours = context.userActiveHours.length > 0
    ? context.userActiveHours
    : DEFAULT_ACTIVE_HOURS;

  const inQuiet = isInQuietHours(currentHour, quietHours);

  let result: DeliveryTiming;

  // Strategy 1: urgent_now
  if (urgency === 'high' && !inQuiet) {
    result = {
      deliverAt: now + URGENT_DELAY_MS,
      reason: 'High urgency, active hours',
      strategy: 'urgent_now',
    };
    // High urgency bypasses minimum gap — apply max deferral cap and return
    result.deliverAt = Math.min(result.deliverAt, now + MAX_DEFERRAL_MS);
    return result;
  }

  // Strategy 2: next_morning (in quiet hours)
  if (inQuiet) {
    const hoursUntilEnd = computeHoursUntil(currentHour, quietHours.end);
    result = {
      deliverAt: now + hoursUntilEnd * HOUR_MS,
      reason: 'Deferred past quiet hours',
      strategy: 'next_morning',
    };
  }
  // Strategy 3: active_hours
  else if (activeHours.includes(currentHour)) {
    result = {
      deliverAt: now + ACTIVE_DELAY_MS,
      reason: 'Within active hours',
      strategy: 'active_hours',
    };
  }
  // Strategy 4: next_active
  else {
    const hoursUntilActive = computeNextActiveHoursUntil(currentHour, activeHours);
    if (hoursUntilActive !== null) {
      result = {
        deliverAt: now + hoursUntilActive * HOUR_MS,
        reason: 'Deferred to next active period',
        strategy: 'next_active',
      };
    } else {
      // Fallback: no active hours match (shouldn't happen with defaults, but safety net)
      result = {
        deliverAt: now + FALLBACK_DELAY_MS,
        reason: 'Fallback — no active hours matched',
        strategy: 'active_hours',
      };
    }
  }

  // Minimum gap enforcement (bypassed by high urgency, already returned above)
  if (lastProactiveAt != null) {
    const minDeliverAt = lastProactiveAt + MIN_GAP_MS;
    if (result.deliverAt < minDeliverAt) {
      result.deliverAt = minDeliverAt;
      result.reason += ' (gap enforced)';
    }
  }

  // Maximum deferral cap
  result.deliverAt = Math.min(result.deliverAt, now + MAX_DEFERRAL_MS);

  return result;
}

// ============ Helpers ============

/**
 * Compute hours from currentHour to targetHour, wrapping around midnight.
 * Always returns a positive number (1-24 range for wrap-around).
 */
function computeHoursUntil(currentHour: number, targetHour: number): number {
  if (targetHour > currentHour) {
    return targetHour - currentHour;
  }
  // Wrap around midnight
  return 24 - currentHour + targetHour;
}

/**
 * Find the number of hours until the next active hour.
 * Returns null if activeHours is empty.
 */
function computeNextActiveHoursUntil(
  currentHour: number,
  activeHours: number[],
): number | null {
  if (activeHours.length === 0) return null;

  // Sort active hours
  const sorted = [...activeHours].sort((a, b) => a - b);

  // Find the first active hour after currentHour
  for (const hour of sorted) {
    if (hour > currentHour) {
      return hour - currentHour;
    }
  }

  // Wrap around: first active hour tomorrow
  return 24 - currentHour + sorted[0];
}
