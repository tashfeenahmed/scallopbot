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
  const currentHour = new Date(now).getHours();

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
