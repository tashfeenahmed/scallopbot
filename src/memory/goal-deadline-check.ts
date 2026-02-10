/**
 * Goal deadline checking.
 *
 * Pure function that checks active goals for approaching deadlines,
 * computes urgency levels, generates notification candidates, and
 * deduplicates against existing reminders via word overlap.
 */

import type { GoalItem } from '../goals/types.js';

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARNING_WINDOW_DAYS = 7;
const DEDUP_OVERLAP_THRESHOLD = 0.8;

// ============ Types ============

export interface ApproachingGoal {
  goalId: string;
  goalTitle: string;
  dueDate: number;
  daysRemaining: number;
  urgency: 'warning' | 'urgent' | 'overdue';
}

export interface GoalNotification {
  userId: string;
  message: string;
  goalId: string;
}

export interface GoalDeadlineResult {
  approaching: ApproachingGoal[];
  notifications: GoalNotification[];
  totalChecked: number;
}

export interface GoalDeadlineOptions {
  warningWindowDays?: number;
  now?: number;
}

// ============ Helpers ============

/**
 * Map days remaining to urgency level.
 * - daysRemaining < 0 -> 'overdue'
 * - daysRemaining <= 2 -> 'urgent'
 * - daysRemaining <= warningWindowDays -> 'warning'
 */
function mapUrgency(daysRemaining: number): 'warning' | 'urgent' | 'overdue' {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= 2) return 'urgent';
  return 'warning';
}

/**
 * Generate notification message for a goal.
 */
function formatMessage(title: string, daysRemaining: number): string {
  if (daysRemaining < 0) {
    return `Goal approaching deadline: ${title} \u2014 overdue by ${Math.abs(daysRemaining)} days`;
  }
  return `Goal approaching deadline: ${title} \u2014 due in ${daysRemaining} days`;
}

/**
 * Compute word overlap ratio between two messages.
 * Splits both into word sets, computes |intersection| / |smaller set|.
 * Returns a value between 0 and 1.
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersectionCount = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionCount++;
  }

  const smallerSize = Math.min(wordsA.size, wordsB.size);
  return intersectionCount / smallerSize;
}

/**
 * Check if a message is a duplicate of any existing reminder
 * based on word overlap >= threshold.
 */
function isDuplicate(
  message: string,
  existingReminders: Array<{ message: string }>,
): boolean {
  for (const reminder of existingReminders) {
    if (wordOverlap(message, reminder.message) >= DEDUP_OVERLAP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// ============ Main Function ============

/**
 * Check goals for approaching deadlines and generate deduped notifications.
 *
 * @param goals - Active goals to check (pre-filtered by caller)
 * @param existingReminders - Pending scheduled items for deduplication
 * @param options - Optional configuration
 * @returns GoalDeadlineResult with approaching goals and notifications
 */
export function checkGoalDeadlines(
  goals: GoalItem[],
  existingReminders: Array<{ message: string }>,
  options?: GoalDeadlineOptions,
): GoalDeadlineResult {
  const now = options?.now ?? Date.now();
  const warningWindowDays =
    options?.warningWindowDays ?? DEFAULT_WARNING_WINDOW_DAYS;

  const approaching: ApproachingGoal[] = [];
  const notifications: GoalNotification[] = [];

  for (const goal of goals) {
    const dueDate = goal.metadata.dueDate;

    // Skip goals without a dueDate
    if (dueDate == null) continue;

    const daysRemaining = Math.floor((dueDate - now) / DAY_MS);

    // Skip goals outside the warning window (future goals not yet approaching)
    // Overdue goals (daysRemaining < 0) are always included
    if (daysRemaining > warningWindowDays) continue;

    const urgency = mapUrgency(daysRemaining);
    const goalTitle = goal.content;

    approaching.push({
      goalId: goal.id,
      goalTitle,
      dueDate,
      daysRemaining,
      urgency,
    });

    // Generate notification and deduplicate
    const message = formatMessage(goalTitle, daysRemaining);
    if (!isDuplicate(message, existingReminders)) {
      notifications.push({
        userId: goal.userId,
        message,
        goalId: goal.id,
      });
    }
  }

  return {
    approaching,
    notifications,
    totalChecked: goals.length,
  };
}
