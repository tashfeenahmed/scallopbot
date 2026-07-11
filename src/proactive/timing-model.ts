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

import {
  DEFAULT_ACTIVE_HOURS,
  MIN_GAP_MS,
  MAX_DEFERRAL_MS,
  URGENT_DELAY_MS,
  ACTIVE_DELAY_MS,
} from './proactive-config.js';

// Re-export for backward compatibility
export { DEFAULT_ACTIVE_HOURS, MIN_GAP_MS, MAX_DEFERRAL_MS, URGENT_DELAY_MS, ACTIVE_DELAY_MS };

/** Fallback delivery delay: 30 minutes (legacy behavior) */
const FALLBACK_DELAY_MS = 30 * 60 * 1000;

// ============ Interfaces ============

export interface TimingContext {
  userActiveHours: number[];
  quietHours: { start: number; end: number };
  lastProactiveAt: number | null;
  currentHour: number;
  /** Minute in the same local timezone as currentHour. */
  currentMinute?: number;
  urgency: 'low' | 'medium' | 'high';
  now: number;
  /** Stable intent/item seed. When present, adds bounded natural timing jitter. */
  jitterSeed?: string;
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
 * 2. next_morning: in quiet hours -> first hour after quiet end, with bounded jitter
 * 3. active_hours: currentHour in activeHours -> now + 15 min
 * 4. next_active: outside active hours -> next active hour at :00
 * 5. Fallback: now + 30 min (legacy behavior)
 *
 * Minimum gap enforcement: if lastProactiveAt is set and the candidate is too
 * close, push to the centralized minimum gap. Inferred urgency does not create
 * bursts; explicit user reminders bypass this model at delivery.
 *
 * Maximum deferral: if deliverAt > now + 24h, cap at now + 24h.
 */
export function computeDeliveryTime(context: TimingContext): DeliveryTiming {
  const { now, currentHour, urgency, quietHours, lastProactiveAt } = context;
  const currentMinute = context.currentMinute ?? 0;
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
  }

  // Strategy 2: next_morning (in quiet hours)
  else if (inQuiet) {
    const minutesUntilEnd = computeMinutesUntil(currentHour, currentMinute, quietHours.end);
    result = {
      deliverAt: now + minutesUntilEnd * 60_000 + deliveryJitterMs(context.jitterSeed, 5, 20),
      reason: 'Deferred past quiet hours',
      strategy: 'next_morning',
    };
  }
  // Strategy 3: active_hours
  else if (activeHours.includes(currentHour)) {
    result = {
      deliverAt: now + ACTIVE_DELAY_MS + deliveryJitterMs(context.jitterSeed, -5, 10),
      reason: 'Within active hours',
      strategy: 'active_hours',
    };
  }
  // Strategy 4: next_active
  else {
    const minutesUntilActive = computeNextActiveMinutesUntil(currentHour, currentMinute, activeHours);
    if (minutesUntilActive !== null) {
      result = {
        deliverAt: now + minutesUntilActive * 60_000 + deliveryJitterMs(context.jitterSeed, 5, 20),
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

  // Minimum gap enforcement applies to inferred outreach at every urgency.
  // Explicit user reminders bypass this model at the scheduler boundary.
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
function computeMinutesUntil(currentHour: number, currentMinute: number, targetHour: number): number {
  const current = currentHour * 60 + currentMinute;
  const target = targetHour * 60;
  const delta = (target - current + 24 * 60) % (24 * 60);
  return delta === 0 ? 24 * 60 : delta;
}

/**
 * Find the number of hours until the next active hour.
 * Returns null if activeHours is empty.
 */
function computeNextActiveMinutesUntil(
  currentHour: number,
  currentMinute: number,
  activeHours: number[],
): number | null {
  if (activeHours.length === 0) return null;

  // Sort active hours
  const sorted = [...activeHours].sort((a, b) => a - b);

  // Find the first active hour after currentHour
  for (const hour of sorted) {
    if (hour > currentHour) {
      return hour * 60 - (currentHour * 60 + currentMinute);
    }
  }

  // Wrap around: first active hour tomorrow
  return 24 * 60 - (currentHour * 60 + currentMinute) + sorted[0] * 60;
}

/** Deterministic jitter avoids clockwork sends while remaining testable. */
function deliveryJitterMs(seed: string | undefined, minMinutes: number, maxMinutes: number): number {
  if (!seed || maxMinutes < minMinutes) return 0;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const span = maxMinutes - minMinutes + 1;
  const minutes = minMinutes + ((hash >>> 0) % span);
  return minutes * 60_000;
}
