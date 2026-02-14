/**
 * Shared scheduling helpers for gardener pipeline steps.
 * Used by inner thoughts (deepTick) and gap scanner (sleepTick).
 */

import type { ScallopDatabase } from './db.js';
import { computeDeliveryTime, type TimingContext, type DeliveryTiming } from '../proactive/timing-model.js';

export interface ScheduleProactiveItemInput {
  db: ScallopDatabase;
  userId: string;
  message: string;
  context: string | null;
  type: string;
  quietHours: { start: number; end: number };
  activeHours: number[];
  lastProactiveAt: number | null;
  urgency: 'low' | 'medium' | 'high';
  sourceMemoryId?: string | null;
  /** Injectable now for deterministic timing in tests */
  now?: number;
  /** IANA timezone for the user (e.g. 'Europe/Dublin'). Falls back to server local time. */
  timezone?: string;
}

export interface ScheduleProactiveItemResult {
  timing: DeliveryTiming;
  itemId: string;
}

/**
 * Computes delivery time via computeDeliveryTime() and inserts a scheduled item.
 */
export function scheduleProactiveItem(input: ScheduleProactiveItemInput): ScheduleProactiveItemResult {
  const now = input.now ?? Date.now();
  const currentHour = getHourInTimezone(now, input.timezone);

  const timing = computeDeliveryTime({
    userActiveHours: input.activeHours,
    quietHours: input.quietHours,
    lastProactiveAt: input.lastProactiveAt,
    currentHour,
    urgency: input.urgency,
    now,
  });

  const item = input.db.addScheduledItem({
    userId: input.userId,
    sessionId: null,
    source: 'agent',
    type: input.type as 'follow_up',
    message: input.message,
    context: input.context,
    triggerAt: timing.deliverAt,
    recurring: null,
    sourceMemoryId: input.sourceMemoryId ?? null,
  });

  return { timing, itemId: item.id };
}

/**
 * Finds the most recent firedAt timestamp from agent-sourced scheduled items.
 * Returns null when no fired agent items exist.
 */
export function getLastProactiveAt(db: ScallopDatabase, userId: string): number | null {
  const scheduledItems = db.getScheduledItemsByUser(userId);
  const lastFiredAgent = scheduledItems
    .filter(i => i.source === 'agent' && i.firedAt != null)
    .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0));
  return lastFiredAgent.length > 0 ? lastFiredAgent[0].firedAt : null;
}

/**
 * Get the current hour (0-23) in the given IANA timezone.
 * Falls back to server local time if timezone is not provided or invalid.
 */
function getHourInTimezone(nowMs: number, timezone?: string): number {
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
