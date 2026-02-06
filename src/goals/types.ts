/**
 * Goal Tracking Types
 *
 * Hierarchical goal system: Goal -> Milestone -> Task
 * Uses existing memory infrastructure with goal-specific metadata.
 */

import type { ScallopMemoryEntry } from '../memory/db.js';

/**
 * Goal types in the hierarchy
 */
export type GoalType = 'goal' | 'milestone' | 'task';

/**
 * Simple kanban status workflow
 */
export type GoalStatus = 'backlog' | 'active' | 'completed';

/**
 * Check-in frequency for proactive triggers
 */
export type CheckinFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

/**
 * Goal-specific metadata stored in memory.metadata
 */
export interface GoalMetadata {
  /** Type in hierarchy */
  goalType: GoalType;
  /** Kanban status */
  status: GoalStatus;
  /** Parent ID (goal for milestone, milestone for task) */
  parentId?: string;
  /** Target completion date (epoch ms) */
  dueDate?: number;
  /** When completed (epoch ms) */
  completedAt?: number;
  /** Progress percentage (0-100, auto-calculated for goals/milestones) */
  progress?: number;
  /** How often to check in on this goal */
  checkinFrequency?: CheckinFrequency;
  /** Last proactive check-in (epoch ms) */
  lastCheckin?: number;
  /** User-defined tags */
  tags?: string[];
  /** Allow additional properties for compatibility */
  [key: string]: unknown;
}

/**
 * A goal item (extends memory entry with typed metadata)
 */
export interface GoalItem extends Omit<ScallopMemoryEntry, 'metadata'> {
  metadata: GoalMetadata;
}

/**
 * Hierarchical goal tree
 */
export interface GoalTree {
  goal: GoalItem;
  milestones: Array<{
    milestone: GoalItem;
    tasks: GoalItem[];
  }>;
  totalProgress: number;
}

/**
 * Filter options for querying goals
 */
export interface GoalFilter {
  /** Filter by goal type */
  type?: GoalType;
  /** Filter by status */
  status?: GoalStatus;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Minimum progress */
  minProgress?: number;
  /** Maximum progress */
  maxProgress?: number;
  /** Due before this date */
  dueBefore?: number;
  /** Due after this date */
  dueAfter?: number;
  /** Include completed goals */
  includeCompleted?: boolean;
  /** Limit results */
  limit?: number;
}

/**
 * Options for creating a goal
 */
export interface CreateGoalOptions {
  /** Goal title/description */
  title: string;
  /** Target completion date */
  dueDate?: number;
  /** Check-in frequency for proactive triggers */
  checkinFrequency?: CheckinFrequency;
  /** Initial status (default: 'backlog') */
  status?: GoalStatus;
  /** Tags for organization */
  tags?: string[];
}

/**
 * Options for creating a milestone
 */
export interface CreateMilestoneOptions {
  /** Milestone title/description */
  title: string;
  /** Target completion date */
  dueDate?: number;
  /** Initial status (default: 'backlog') */
  status?: GoalStatus;
  /** Tags for organization */
  tags?: string[];
}

/**
 * Options for creating a task
 */
export interface CreateTaskOptions {
  /** Task title/description */
  title: string;
  /** Target completion date */
  dueDate?: number;
  /** Initial status (default: 'backlog') */
  status?: GoalStatus;
  /** Tags for organization */
  tags?: string[];
}

/**
 * Options for updating a goal item
 */
export interface UpdateGoalOptions {
  /** New title */
  title?: string;
  /** New status */
  status?: GoalStatus;
  /** New due date */
  dueDate?: number;
  /** New check-in frequency */
  checkinFrequency?: CheckinFrequency;
  /** New tags */
  tags?: string[];
}

/**
 * Progress summary for a goal
 */
export interface GoalProgress {
  goalId: string;
  title: string;
  status: GoalStatus;
  progress: number;
  totalMilestones: number;
  completedMilestones: number;
  totalTasks: number;
  completedTasks: number;
  dueDate?: number;
  isOverdue: boolean;
}

/**
 * Check if metadata is goal metadata
 */
export function isGoalMetadata(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return (
    metadata !== null &&
    metadata !== undefined &&
    typeof metadata === 'object' &&
    'goalType' in metadata &&
    'status' in metadata
  );
}

/**
 * Check if a memory entry is a goal item
 */
export function isGoalItem(entry: ScallopMemoryEntry): boolean {
  return isGoalMetadata(entry.metadata as Record<string, unknown> | null);
}
