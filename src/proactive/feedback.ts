/**
 * Proactive engagement detection (feedback loop).
 *
 * Pure function that identifies which recently-fired agent items
 * should be marked as 'acted' because the user engaged within
 * the engagement window.
 *
 * The caller is responsible for:
 * - Fetching items from DB (getScheduledItemsByUser)
 * - Calling markScheduledItemActed for each returned ID
 */

import type { ScheduledItem } from '../memory/db.js';

// ============ Constants ============

/** Default engagement window: 15 minutes in milliseconds */
export const DEFAULT_ENGAGEMENT_WINDOW_MS = 15 * 60 * 1000;

// ============ Functions ============

/**
 * Detect which fired agent items should be marked as 'acted'.
 *
 * Filters items where:
 * - source === 'agent'
 * - status === 'fired'
 * - firedAt exists (not null)
 * - (now - firedAt) < engagementWindowMs
 *
 * @param userId - User ID (for signature consistency; filtering is done by caller)
 * @param recentFiredItems - Pre-filtered items from the database
 * @param engagementWindowMs - Window in ms to consider engagement (default: 15 min)
 * @param now - Injectable timestamp for testing (default: Date.now())
 * @returns Array of item IDs that should be marked as 'acted'
 */
export function detectProactiveEngagement(
  userId: string,
  recentFiredItems: ScheduledItem[],
  engagementWindowMs: number = DEFAULT_ENGAGEMENT_WINDOW_MS,
  now: number = Date.now(),
): string[] {
  return recentFiredItems
    .filter((item) =>
      item.source === 'agent' &&
      item.status === 'fired' &&
      item.firedAt != null &&
      (now - item.firedAt) < engagementWindowMs,
    )
    .map((item) => item.id);
}
