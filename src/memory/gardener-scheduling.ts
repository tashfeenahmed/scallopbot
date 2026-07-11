/**
 * Shared scheduling helpers for gardener pipeline steps.
 * Used by inner thoughts (deepTick) and gap scanner (sleepTick).
 */

import type { ScallopDatabase, ScheduledItemKind, TaskConfig } from './db.js';
import { computeDeliveryTime, type DeliveryTiming } from '../proactive/timing-model.js';
import { getHourInTimezone, getMinuteInTimezone } from '../proactive/proactive-utils.js';

export interface ScheduleProactiveItemInput {
  db: ScallopDatabase;
  userId: string;
  /** Conversation that supplied the context for this proactive item. */
  sessionId?: string | null;
  message: string;
  context: string | null;
  type: string;
  kind?: ScheduledItemKind;
  taskConfig?: TaskConfig | null;
  quietHours: { start: number; end: number };
  activeHours: number[];
  lastProactiveAt: number | null;
  urgency: 'low' | 'medium' | 'high';
  sourceMemoryId?: string | null;
  /** Board item whose stale/blocked state caused this generated nudge. */
  sourceItemId?: string | null;
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
    currentMinute: getMinuteInTimezone(now, input.timezone),
    urgency: input.urgency,
    now,
    jitterSeed: `${input.userId}:${input.sourceMemoryId ?? input.type}:${input.message}`,
  });

  let sourceItemId = input.sourceItemId ?? null;
  if (!sourceItemId && input.context) {
    try {
      const context = JSON.parse(input.context) as Record<string, unknown>;
      if (
        (context.gapType === 'stale_board_item' || context.gapType === 'blocked_item')
        && typeof context.sourceId === 'string'
      ) {
        sourceItemId = context.sourceId;
      }
    } catch {
      // Legacy/free-form context has no first-class source-item provenance.
    }
  }

  const item = input.db.addScheduledItem({
    userId: input.userId,
    sessionId: input.sessionId ?? null,
    source: 'agent',
    kind: input.kind ?? 'nudge',
    type: input.type as 'follow_up',
    message: input.message,
    context: input.context,
    triggerAt: timing.deliverAt,
    recurring: null,
    sourceMemoryId: input.sourceMemoryId ?? null,
    sourceItemId,
    taskConfig: input.taskConfig ?? null,
    boardStatus: 'scheduled',
  });

  return { timing, itemId: item.id };
}

/** Input for createProactiveItem — same as ScheduleProactiveItemInput */
export type CreateProactiveItemInput = ScheduleProactiveItemInput;

export type CreateProactiveItemResult =
  | { created: false }
  | { created: true; itemId: string; timing: DeliveryTiming };

/**
 * Deduplicate-then-schedule: checks hasSimilarPendingScheduledItem
 * before inserting, so callers don't have to repeat the pattern.
 */
export function createProactiveItem(input: CreateProactiveItemInput): CreateProactiveItemResult {
  if (input.db.hasSimilarPendingScheduledItem(input.userId, input.message)) {
    return { created: false };
  }
  const { timing, itemId } = scheduleProactiveItem(input);
  return { created: true, itemId, timing };
}

/**
 * Finds the most recent actual inferred delivery. Scheduler state alone is not
 * evidence that a message reached the user: suppressed/cancelled work may be
 * archived or completed without an outbound send.
 */
export function getLastProactiveAt(db: ScallopDatabase, userId: string): number | null {
  const recentWindow = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const latest = db.getRecentProactiveSends(recentWindow)
    .filter(send => send.userId === userId && send.source === 'agent')
    .reduce((value, send) => Math.max(value, send.sentAt), 0);
  return latest > 0 ? latest : null;
}
