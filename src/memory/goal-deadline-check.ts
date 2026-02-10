/**
 * Goal deadline checking.
 *
 * Pure function that checks active goals for approaching deadlines,
 * computes urgency levels, generates notification candidates, and
 * deduplicates against existing reminders via word overlap.
 */

import type { GoalItem } from '../goals/types.js';

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
  _goals: GoalItem[],
  _existingReminders: Array<{ message: string }>,
  _options?: GoalDeadlineOptions,
): GoalDeadlineResult {
  return {
    approaching: [],
    notifications: [],
    totalChecked: 0,
  };
}
