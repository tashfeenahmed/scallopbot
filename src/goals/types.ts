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

/** Runtime state for an autonomous, verified goal execution. */
export type GoalExecutionState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'budget_exhausted'
  | 'completed';

/** A deterministic acceptance check. Qualitative checks can be delegated to a judge. */
export interface GoalAcceptanceCriterion {
  /** Stable identifier used when supplying manual evidence. */
  id: string;
  /** Human-readable statement of the condition that must hold. */
  description: string;
  /** How to evaluate the final worker output. */
  kind: 'contains' | 'regex' | 'equals' | 'manual';
  /** Expected text or regular expression (not used for manual criteria). */
  expected?: string;
  /** Defaults to true. Optional criteria are reported but do not block completion. */
  required?: boolean;
}

/** Completion contract that prevents an agent from declaring success without evidence. */
export interface GoalContract {
  acceptanceCriteria: GoalAcceptanceCriterion[];
  constraints?: string[];
  /** If true (the default), every required criterion must pass. */
  requireAll?: boolean;
}

/** Hard execution limits. These counters are persisted with the goal. */
export interface GoalBudget {
  maxTurns: number;
  maxCostUsd?: number;
  /** Absolute epoch-ms deadline for execution. */
  deadlineAt?: number;
}

export interface GoalCriterionResult {
  id: string;
  passed: boolean;
  required: boolean;
  reason: string;
}

export interface GoalVerification {
  passed: boolean;
  criteria: GoalCriterionResult[];
  judgedAt: number;
  judgeReason?: string;
}

/** Persistent execution journal embedded in goal metadata. */
export interface GoalExecutionMetadata {
  state: GoalExecutionState;
  turnsUsed: number;
  costUsedUsd: number;
  startedAt?: number;
  updatedAt: number;
  parkedAt?: number;
  resumeAt?: number;
  parkReason?: string;
  blockedReason?: string;
  lastOutput?: string;
  lastVerification?: GoalVerification;
}

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
  /** Optional acceptance contract for verified autonomous execution. */
  contract?: GoalContract;
  /** Optional hard turn/cost/time limits for autonomous execution. */
  budget?: GoalBudget;
  /** Durable execution state and counters. */
  execution?: GoalExecutionMetadata;
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
  /** Acceptance contract for autonomous execution. */
  contract?: GoalContract;
  /** Hard execution limits (defaults to 10 turns when a contract is supplied). */
  budget?: GoalBudget;
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
  /** Replace the verified-execution contract. */
  contract?: GoalContract;
  /** Replace the verified-execution budget. */
  budget?: GoalBudget;
}

/** Input supplied to one autonomous goal turn. */
export interface GoalTurnContext {
  goal: GoalItem;
  contract: GoalContract;
  budget: GoalBudget;
  turnNumber: number;
  previousOutput?: string;
}

/** Result from one autonomous goal turn. */
export interface GoalTurnOutcome {
  output: string;
  /** Evidence for manual criteria, keyed by criterion id. */
  evidence?: Record<string, boolean>;
  costUsd?: number;
  /** False when the worker stopped without a natural or explicit completion. */
  taskComplete?: boolean;
  failureReason?: string;
  /** Park the goal until an external condition or time is ready. */
  parkUntil?: number;
  parkReason?: string;
}

export type GoalTurnRunner = (context: GoalTurnContext) => Promise<GoalTurnOutcome>;

export type GoalJudge = (input: {
  goal: GoalItem;
  output: string;
  deterministicResults: GoalCriterionResult[];
}) => Promise<{ passed: boolean; reason?: string }>;

export interface GoalRunResult {
  goal: GoalItem;
  state: GoalExecutionState;
  turnsThisRun: number;
  verification?: GoalVerification;
  reason: string;
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
