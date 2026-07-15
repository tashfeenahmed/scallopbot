/**
 * Goal Service
 *
 * Core service for hierarchical goal tracking.
 * Uses existing memory infrastructure with goal-specific operations.
 */

import type { Logger } from 'pino';
import type { ScallopDatabase, ScallopMemoryEntry } from '../memory/db.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';
import type {
  GoalItem,
  GoalTree,
  GoalFilter,
  GoalMetadata,
  GoalStatus,
  CheckinFrequency,
  CreateGoalOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  UpdateGoalOptions,
  GoalProgress,
  GoalContract,
  GoalBudget,
  GoalExecutionMetadata,
  GoalVerification,
  GoalCriterionResult,
  GoalTurnRunner,
  GoalJudge,
  GoalRunResult,
} from './types.js';
import { isGoalItem } from './types.js';
import {
  hasRequestContentOverlap,
  isGoalLiveForContext,
} from '../memory/state-relevance.js';

/**
 * Options for GoalService
 */
export interface GoalServiceOptions {
  db: ScallopDatabase;
  logger: Logger;
  /** Optional embedding provider for semantic search of goals */
  embedder?: EmbeddingProvider;
}

/**
 * Calculate next check-in time based on frequency
 */
function calculateNextCheckin(frequency: CheckinFrequency): number {
  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  switch (frequency) {
    case 'daily':
      return now + MS_PER_DAY;
    case 'weekly':
      return now + 7 * MS_PER_DAY;
    case 'biweekly':
      return now + 14 * MS_PER_DAY;
    case 'monthly':
      return now + 30 * MS_PER_DAY;
    default:
      return now + 7 * MS_PER_DAY;
  }
}

const DEFAULT_GOAL_BUDGET: GoalBudget = { maxTurns: 10 };
const MAX_PERSISTED_OUTPUT_CHARS = 4_000;

function validateContract(contract: GoalContract): void {
  if (!Array.isArray(contract.acceptanceCriteria) || contract.acceptanceCriteria.length === 0) {
    throw new Error('A verified goal requires at least one acceptance criterion');
  }
  if (contract.acceptanceCriteria.length > 25) {
    throw new Error('A verified goal supports at most 25 acceptance criteria');
  }

  const ids = new Set<string>();
  for (const criterion of contract.acceptanceCriteria) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(criterion.id ?? '') || !criterion.description?.trim()) {
      throw new Error('Every acceptance criterion requires an id and description');
    }
    if (criterion.description.length > 500) {
      throw new Error(`Acceptance criterion ${criterion.id} has an overlong description`);
    }
    if (ids.has(criterion.id)) {
      throw new Error(`Duplicate acceptance criterion id: ${criterion.id}`);
    }
    ids.add(criterion.id);
    if (!['contains', 'regex', 'equals', 'manual'].includes(criterion.kind)) {
      throw new Error(`Acceptance criterion ${criterion.id} has an invalid kind`);
    }
    if (criterion.kind !== 'manual' && !criterion.expected?.length) {
      throw new Error(`Acceptance criterion ${criterion.id} requires an expected value`);
    }
    if ((criterion.expected?.length ?? 0) > 2_000) {
      throw new Error(`Acceptance criterion ${criterion.id} has an overlong expected value`);
    }
    if (criterion.kind === 'regex') {
      if (
        criterion.expected!.length > 256 ||
        /\([^)]*(?:[+*]|\{\d+(?:,\d*)?\})[^)]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(criterion.expected!)
      ) {
        throw new Error(`Acceptance criterion ${criterion.id} has a potentially unsafe regular expression`);
      }
      try {
        // Validate once at configuration time rather than failing mid-run.
        new RegExp(criterion.expected!, 'i');
      } catch {
        throw new Error(`Acceptance criterion ${criterion.id} has an invalid regular expression`);
      }
    }
  }
}

function validateBudget(budget: GoalBudget): void {
  if (!Number.isInteger(budget.maxTurns) || budget.maxTurns < 1) {
    throw new Error('Goal budget maxTurns must be a positive integer');
  }
  if (budget.maxCostUsd !== undefined && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) {
    throw new Error('Goal budget maxCostUsd must be a non-negative number');
  }
  if (budget.deadlineAt !== undefined && !Number.isFinite(budget.deadlineAt)) {
    throw new Error('Goal budget deadlineAt must be an epoch-millisecond timestamp');
  }
}

function initialExecution(now: number = Date.now()): GoalExecutionMetadata {
  return {
    state: 'idle',
    turnsUsed: 0,
    costUsedUsd: 0,
    updatedAt: now,
  };
}

/**
 * GoalService - Manages hierarchical goal tracking
 */
export class GoalService {
  private db: ScallopDatabase;
  private logger: Logger;
  private embedder?: EmbeddingProvider;

  constructor(options: GoalServiceOptions) {
    this.db = options.db;
    this.logger = options.logger.child({ component: 'goal-service' });
    this.embedder = options.embedder;
  }

  /** Generate embedding for goal content, swallowing errors */
  private async generateEmbedding(content: string): Promise<number[] | null> {
    if (!this.embedder) return null;
    try {
      return await this.embedder.embed(content);
    } catch {
      return null;
    }
  }

  // ============ CRUD Operations ============

  /**
   * Create a new goal
   */
  async createGoal(userId: string, options: CreateGoalOptions): Promise<GoalItem> {
    if (options.contract) validateContract(options.contract);
    if (options.budget) validateBudget(options.budget);

    const metadata: GoalMetadata = {
      goalType: 'goal',
      status: options.status ?? 'backlog',
      dueDate: options.dueDate,
      checkinFrequency: options.checkinFrequency,
      tags: options.tags,
      progress: 0,
      contract: options.contract,
      budget: options.contract ? (options.budget ?? DEFAULT_GOAL_BUDGET) : options.budget,
      execution: options.contract ? initialExecution() : undefined,
    };

    const embedding = await this.generateEmbedding(options.title);

    const memory = this.db.addMemory({
      userId,
      content: options.title,
      category: 'insight',
      // Goal hierarchy is durable application state, not a decaying recollection.
      memoryType: 'static_profile',
      importance: 8, // Goals are high importance
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding,
      metadata: metadata as Record<string, unknown>,
    });

    const goal = this.memoryToGoalItem(memory);

    // Schedule check-in if frequency is set and goal is active
    if (options.checkinFrequency && options.status === 'active') {
      await this.scheduleCheckin(goal.id);
    }

    this.logger.info({ goalId: goal.id, title: options.title }, 'Goal created');
    return goal;
  }

  /**
   * Create a milestone under a goal
   */
  async createMilestone(
    goalId: string,
    options: CreateMilestoneOptions
  ): Promise<GoalItem> {
    const goal = await this.getGoal(goalId);
    if (!goal) {
      throw new Error(`Goal ${goalId} not found`);
    }
    if (goal.metadata.goalType !== 'goal') {
      throw new Error(`Cannot add milestone to ${goal.metadata.goalType}`);
    }

    const metadata: GoalMetadata = {
      goalType: 'milestone',
      status: options.status ?? 'backlog',
      parentId: goalId,
      dueDate: options.dueDate,
      tags: options.tags,
      progress: 0,
    };

    const embedding = await this.generateEmbedding(options.title);

    const memory = this.db.addMemory({
      userId: goal.userId,
      content: options.title,
      category: 'insight',
      memoryType: 'static_profile',
      importance: 7,
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding,
      metadata: metadata as Record<string, unknown>,
    });

    // Create EXTENDS relation to parent goal
    this.db.addRelation(memory.id, goalId, 'EXTENDS');

    const milestone = this.memoryToGoalItem(memory);
    this.logger.info(
      { milestoneId: milestone.id, goalId, title: options.title },
      'Milestone created'
    );

    // Update parent goal progress
    await this.updateProgress(goalId);

    return milestone;
  }

  /**
   * Create a task under a milestone.
   * Also creates a board item (scheduled_item) linked via goal_id.
   */
  async createTask(
    milestoneId: string,
    options: CreateTaskOptions
  ): Promise<GoalItem> {
    const milestone = await this.getGoal(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }
    if (milestone.metadata.goalType !== 'milestone') {
      throw new Error(`Cannot add task to ${milestone.metadata.goalType}`);
    }

    const metadata: GoalMetadata = {
      goalType: 'task',
      status: options.status ?? 'backlog',
      parentId: milestoneId,
      dueDate: options.dueDate,
      tags: options.tags,
    };

    const embedding = await this.generateEmbedding(options.title);

    const memory = this.db.addMemory({
      userId: milestone.userId,
      content: options.title,
      category: 'insight',
      memoryType: 'static_profile',
      importance: 6,
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding,
      metadata: metadata as Record<string, unknown>,
    });

    // Create EXTENDS relation to parent milestone
    this.db.addRelation(memory.id, milestoneId, 'EXTENDS');

    const task = this.memoryToGoalItem(memory);
    this.logger.info(
      { taskId: task.id, milestoneId, title: options.title },
      'Task created'
    );

    // Also create a board item linked to this goal task
    try {
      const boardItem = this.db.addScheduledItem({
        userId: milestone.userId,
        sessionId: null,
        source: 'user',
        kind: 'task',
        type: 'reminder',
        message: options.title,
        context: JSON.stringify({ goalId: memory.id, milestoneId, source: 'goal_service' }),
        triggerAt: options.dueDate ?? 0,
        recurring: null,
        sourceMemoryId: memory.id,
        boardStatus: options.dueDate ? 'scheduled' : 'backlog',
        priority: 'medium',
        labels: null,
        dependsOn: null,
        goalId: memory.id,
        taskConfig: null,
      });
      this.logger.debug({ taskId: task.id, boardItemId: boardItem.id }, 'Board item created for goal task');
    } catch (err) {
      // Non-critical — the goal task is still created even if board item fails
      this.logger.warn({ error: (err as Error).message, taskId: task.id }, 'Failed to create board item for goal task');
    }

    // Update parent milestone and goal progress
    await this.updateProgress(milestoneId);
    if (milestone.metadata.parentId) {
      await this.updateProgress(milestone.metadata.parentId);
    }

    return task;
  }

  /**
   * Get a goal item by ID
   */
  async getGoal(id: string): Promise<GoalItem | null> {
    const registry = this.db.getGoalRegistryEntry(id);
    if (registry?.deletedAt !== null && registry?.deletedAt !== undefined) {
      return null;
    }
    let memory = this.db.getMemory(id);
    if ((!memory || !isGoalItem(memory)) && registry) {
      memory = this.db.restoreGoalMemoryFromRegistry(id);
    }
    if (!memory || !isGoalItem(memory)) {
      return null;
    }
    if (memory.metadata?.status !== 'completed'
      && (!memory.isLatest || memory.memoryType !== 'static_profile' || memory.prominence !== 1)) {
      this.db.updateMemory(id, { isLatest: true, memoryType: 'static_profile', prominence: 1 });
      memory = this.db.getMemory(id)!;
    }
    return this.memoryToGoalItem(memory);
  }

  /**
   * Update a goal item
   */
  async update(id: string, options: UpdateGoalOptions): Promise<GoalItem | null> {
    const goal = await this.getGoal(id);
    if (!goal) {
      return null;
    }

    const updates: Partial<ScallopMemoryEntry> = {};
    const metadataUpdates: Partial<GoalMetadata> = {};

    if (options.title !== undefined) {
      updates.content = options.title;
    }
    if (options.status !== undefined) {
      metadataUpdates.status = options.status;
      if (options.status === 'completed') {
        metadataUpdates.completedAt = Date.now();
      }
    }
    if (options.dueDate !== undefined) {
      metadataUpdates.dueDate = options.dueDate;
      updates.eventDate = options.dueDate;
    }
    if (options.checkinFrequency !== undefined) {
      metadataUpdates.checkinFrequency = options.checkinFrequency;
    }
    if (options.tags !== undefined) {
      metadataUpdates.tags = options.tags;
    }
    if (options.contract !== undefined) {
      if (goal.metadata.goalType !== 'goal') {
        throw new Error('Verified execution contracts can only be attached to top-level goals');
      }
      validateContract(options.contract);
      metadataUpdates.contract = options.contract;
      metadataUpdates.execution = goal.metadata.execution ?? initialExecution();
      if (!goal.metadata.budget && options.budget === undefined) {
        metadataUpdates.budget = DEFAULT_GOAL_BUDGET;
      }
    }
    if (options.budget !== undefined) {
      if (goal.metadata.goalType !== 'goal') {
        throw new Error('Execution budgets can only be attached to top-level goals');
      }
      validateBudget(options.budget);
      metadataUpdates.budget = options.budget;
    }

    const newMetadata = { ...goal.metadata, ...metadataUpdates };
    updates.metadata = newMetadata;

    this.db.updateMemory(id, updates);

    this.logger.debug({ goalId: id, updates: options }, 'Goal updated');
    return this.getGoal(id);
  }

  /**
   * Delete a goal item and its children
   */
  async delete(id: string): Promise<boolean> {
    const goal = await this.getGoal(id);
    if (!goal) {
      return false;
    }

    // Delete children first
    const children = await this.getChildren(id);
    for (const child of children) {
      await this.delete(child.id);
    }

    // Preserve board history while removing references that would otherwise
    // become dangling IDs after this explicit deletion.
    this.db.unlinkScheduledItemsFromGoal(id);

    // Keep an immutable identity/status tombstone before removing the
    // searchable projection. This distinguishes an explicit delete from
    // accidental memory cleanup, which GoalService self-heals from registry.
    this.db.markGoalRegistryDeleted(id);

    // Delete the goal's searchable memory projection; registry identity and
    // lifecycle audit remain durable.
    const result = this.db.deleteMemory(id);

    // Update parent progress if exists
    if (goal.metadata.parentId) {
      await this.updateProgress(goal.metadata.parentId);
    }

    this.logger.info({ goalId: id }, 'Goal deleted');
    return result;
  }

  // ============ Status Transitions ============

  /**
   * Move item to active status
   */
  async activate(id: string): Promise<GoalItem | null> {
    const goal = await this.getGoal(id);
    if (!goal) {
      return null;
    }

    const updated = await this.update(id, { status: 'active' });

    // Schedule check-in if this is a goal with check-in frequency
    if (updated && goal.metadata.goalType === 'goal' && goal.metadata.checkinFrequency) {
      await this.scheduleCheckin(id);
    }

    return updated;
  }

  /**
   * Mark item as completed
   */
  async complete(id: string): Promise<GoalItem | null> {
    const goal = await this.getGoal(id);
    if (!goal) {
      return null;
    }

    const updated = await this.update(id, { status: 'completed' });

    // Update parent progress
    if (goal.metadata.parentId) {
      await this.updateProgress(goal.metadata.parentId);

      // Check if we should update grandparent (goal) too
      const parent = await this.getGoal(goal.metadata.parentId);
      if (parent?.metadata.parentId) {
        await this.updateProgress(parent.metadata.parentId);
      }
    }

    this.logger.info({ goalId: id, type: goal.metadata.goalType }, 'Item completed');
    return updated;
  }

  /**
   * Reopen a completed item
   */
  async reopen(id: string): Promise<GoalItem | null> {
    const goal = await this.getGoal(id);
    if (!goal) {
      return null;
    }

    const updated = await this.update(id, { status: 'active' });

    // Update parent progress
    if (goal.metadata.parentId) {
      await this.updateProgress(goal.metadata.parentId);

      const parent = await this.getGoal(goal.metadata.parentId);
      if (parent?.metadata.parentId) {
        await this.updateProgress(parent.metadata.parentId);
      }
    }

    return updated;
  }

  // ============ Verified Persistent Execution ============

  /**
   * Attach or replace a completion contract and hard budget on a top-level goal.
   * Execution counters are retained by default so changing a contract cannot
   * silently reset spend. Pass reset=true only for an explicit fresh run.
   */
  async configureExecution(
    id: string,
    contract: GoalContract,
    budget: GoalBudget = DEFAULT_GOAL_BUDGET,
    reset: boolean = false,
  ): Promise<GoalItem> {
    const goal = await this.getGoal(id);
    if (!goal || goal.metadata.goalType !== 'goal') {
      throw new Error(`Top-level goal ${id} not found`);
    }
    validateContract(contract);
    validateBudget(budget);

    const execution = reset || !goal.metadata.execution
      ? initialExecution()
      : { ...goal.metadata.execution, updatedAt: Date.now() };
    this.db.updateMemory(id, {
      metadata: { ...goal.metadata, contract, budget, execution },
    });
    return (await this.getGoal(id))!;
  }

  /** Park execution while waiting on a person, process, or future time. */
  async parkExecution(id: string, reason: string, resumeAt?: number): Promise<GoalItem> {
    const goal = await this.requireExecutableGoal(id);
    const now = Date.now();
    const execution: GoalExecutionMetadata = {
      ...(goal.metadata.execution ?? initialExecution(now)),
      state: 'waiting',
      parkedAt: now,
      resumeAt,
      parkReason: reason,
      blockedReason: undefined,
      updatedAt: now,
    };
    return this.persistExecution(goal, execution);
  }

  /** Resume a parked or blocked goal without resetting its durable counters. */
  async resumeExecution(id: string): Promise<GoalItem> {
    const goal = await this.requireExecutableGoal(id);
    if (goal.metadata.status === 'completed') {
      throw new Error(`Goal ${id} is already completed`);
    }
    const now = Date.now();
    const execution: GoalExecutionMetadata = {
      ...(goal.metadata.execution ?? initialExecution(now)),
      state: 'idle',
      resumeAt: undefined,
      parkedAt: undefined,
      parkReason: undefined,
      blockedReason: undefined,
      updatedAt: now,
    };
    return this.persistExecution(goal, execution);
  }

  /**
   * Evaluate evidence against deterministic criteria and an optional qualitative
   * judge. Judge errors fail closed: an unavailable judge can never mark a goal
   * complete.
   */
  async verifyExecution(
    id: string,
    output: string,
    evidence: Record<string, boolean> = {},
    judge?: GoalJudge,
  ): Promise<GoalVerification> {
    const goal = await this.requireExecutableGoal(id);
    const verification = await this.evaluateVerification(goal, output, evidence, judge);
    const now = Date.now();
    const execution: GoalExecutionMetadata = {
      ...(goal.metadata.execution ?? initialExecution(now)),
      state: verification.passed ? 'completed' : (goal.metadata.execution?.state ?? 'idle'),
      updatedAt: now,
      lastOutput: output.slice(0, MAX_PERSISTED_OUTPUT_CHARS),
      lastVerification: verification,
    };

    this.db.updateMemory(id, {
      metadata: {
        ...goal.metadata,
        status: verification.passed ? 'completed' : goal.metadata.status,
        completedAt: verification.passed ? now : goal.metadata.completedAt,
        progress: verification.passed ? 100 : goal.metadata.progress,
        execution,
      },
    });
    return verification;
  }

  /**
   * Run a goal until its completion contract passes, it parks, it blocks, or a
   * hard budget is exhausted. State and counters are persisted after every turn,
   * making a subsequent call or process restart safe to resume.
   */
  async runUntilVerified(
    id: string,
    runner: GoalTurnRunner,
    options: { judge?: GoalJudge; maxTurnsThisRun?: number; now?: () => number } = {},
  ): Promise<GoalRunResult> {
    let goal = await this.requireExecutableGoal(id);
    const contract = goal.metadata.contract!;
    const budget = goal.metadata.budget ?? DEFAULT_GOAL_BUDGET;
    validateContract(contract);
    validateBudget(budget);

    const clock = options.now ?? Date.now;
    const initialNow = clock();
    let execution = goal.metadata.execution ?? initialExecution(initialNow);

    if (goal.metadata.status === 'completed' || execution.state === 'completed') {
      return {
        goal,
        state: 'completed',
        turnsThisRun: 0,
        verification: execution.lastVerification,
        reason: 'Goal was already verified and completed',
      };
    }

    if (execution.state === 'waiting' && (!execution.resumeAt || execution.resumeAt > initialNow)) {
      return {
        goal,
        state: 'waiting',
        turnsThisRun: 0,
        verification: execution.lastVerification,
        reason: execution.parkReason
          ?? (execution.resumeAt ? `Parked until ${new Date(execution.resumeAt).toISOString()}` : 'Goal is parked'),
      };
    }
    if (execution.state === 'blocked') {
      return {
        goal,
        state: 'blocked',
        turnsThisRun: 0,
        verification: execution.lastVerification,
        reason: execution.blockedReason ?? 'Goal is blocked; resume explicitly after resolving the blocker',
      };
    }

    execution = {
      ...execution,
      state: 'running',
      startedAt: execution.startedAt ?? initialNow,
      resumeAt: undefined,
      parkedAt: undefined,
      parkReason: undefined,
      blockedReason: undefined,
      updatedAt: initialNow,
    };
    goal = await this.persistExecution(goal, execution, 'active');

    const remainingTurns = Math.max(0, budget.maxTurns - execution.turnsUsed);
    const runLimit = Math.min(
      remainingTurns,
      options.maxTurnsThisRun === undefined
        ? remainingTurns
        : Math.max(0, Math.floor(options.maxTurnsThisRun)),
    );
    let turnsThisRun = 0;

    while (turnsThisRun < runLimit) {
      const now = clock();
      const budgetReason = this.getBudgetExhaustionReason(execution, budget, now);
      if (budgetReason) {
        execution = { ...execution, state: 'budget_exhausted', blockedReason: budgetReason, updatedAt: now };
        goal = await this.persistExecution(goal, execution);
        return { goal, state: execution.state, turnsThisRun, verification: execution.lastVerification, reason: budgetReason };
      }

      let outcome;
      try {
        outcome = await runner({
          goal,
          contract,
          budget,
          turnNumber: execution.turnsUsed + 1,
          previousOutput: execution.lastOutput,
        });
      } catch (error) {
        const reason = `Goal worker failed: ${(error as Error).message}`;
        execution = { ...execution, state: 'blocked', blockedReason: reason, updatedAt: clock() };
        goal = await this.persistExecution(goal, execution);
        return { goal, state: execution.state, turnsThisRun, verification: execution.lastVerification, reason };
      }

      turnsThisRun++;
      const cost = Number.isFinite(outcome.costUsd) && (outcome.costUsd ?? 0) > 0 ? outcome.costUsd! : 0;
      execution = {
        ...execution,
        turnsUsed: execution.turnsUsed + 1,
        costUsedUsd: execution.costUsedUsd + cost,
        lastOutput: outcome.output.slice(0, MAX_PERSISTED_OUTPUT_CHARS),
        updatedAt: clock(),
      };
      goal = await this.persistExecution(goal, execution);

      if (budget.maxCostUsd !== undefined && execution.costUsedUsd > budget.maxCostUsd) {
        const reason = `Cost budget exceeded ($${execution.costUsedUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})`;
        execution = { ...execution, state: 'budget_exhausted', blockedReason: reason, updatedAt: clock() };
        goal = await this.persistExecution(goal, execution);
        return { goal, state: execution.state, turnsThisRun, verification: execution.lastVerification, reason };
      }

      if (outcome.taskComplete === false) {
        const reason = outcome.failureReason ?? 'Goal worker stopped without completing its turn';
        execution = { ...execution, state: 'blocked', blockedReason: reason, updatedAt: clock() };
        goal = await this.persistExecution(goal, execution);
        return { goal, state: execution.state, turnsThisRun, verification: execution.lastVerification, reason };
      }

      if (outcome.parkUntil !== undefined || outcome.parkReason) {
        const reason = outcome.parkReason ?? 'Waiting for an external condition';
        goal = await this.parkExecution(id, reason, outcome.parkUntil);
        return { goal, state: 'waiting', turnsThisRun, verification: execution.lastVerification, reason };
      }

      const verification = await this.evaluateVerification(
        goal,
        outcome.output,
        outcome.evidence ?? {},
        options.judge,
      );
      execution = { ...execution, lastVerification: verification, updatedAt: clock() };

      if (verification.passed) {
        const completedAt = clock();
        execution = { ...execution, state: 'completed', updatedAt: completedAt };
        this.db.updateMemory(id, {
          metadata: {
            ...goal.metadata,
            status: 'completed',
            completedAt,
            progress: 100,
            execution,
          },
        });
        goal = (await this.getGoal(id))!;
        return {
          goal,
          state: 'completed',
          turnsThisRun,
          verification,
          reason: 'All required acceptance criteria passed',
        };
      }

      goal = await this.persistExecution(goal, execution);
    }

    const finalNow = clock();
    const exhausted = this.getBudgetExhaustionReason(execution, budget, finalNow);
    if (exhausted) {
      execution = { ...execution, state: 'budget_exhausted', blockedReason: exhausted, updatedAt: finalNow };
      goal = await this.persistExecution(goal, execution);
      return { goal, state: execution.state, turnsThisRun, verification: execution.lastVerification, reason: exhausted };
    }

    // A bounded invocation slice is not an external wait condition. Keep the
    // execution runnable so the next execute_goal call resumes automatically.
    const reason = 'Execution turn slice finished; goal remains runnable';
    execution = {
      ...execution,
      state: 'running',
      parkReason: undefined,
      parkedAt: undefined,
      updatedAt: finalNow,
    };
    goal = await this.persistExecution(goal, execution);
    return { goal, state: 'running', turnsThisRun, verification: execution.lastVerification, reason };
  }

  private async requireExecutableGoal(id: string): Promise<GoalItem> {
    const goal = await this.getGoal(id);
    if (!goal || goal.metadata.goalType !== 'goal') {
      throw new Error(`Top-level goal ${id} not found`);
    }
    if (!goal.metadata.contract) {
      throw new Error(`Goal ${id} has no completion contract`);
    }
    return goal;
  }

  private async persistExecution(
    goal: GoalItem,
    execution: GoalExecutionMetadata,
    status?: GoalStatus,
  ): Promise<GoalItem> {
    this.db.updateMemory(goal.id, {
      metadata: { ...goal.metadata, status: status ?? goal.metadata.status, execution },
    });
    return (await this.getGoal(goal.id))!;
  }

  private getBudgetExhaustionReason(
    execution: GoalExecutionMetadata,
    budget: GoalBudget,
    now: number,
  ): string | null {
    if (execution.turnsUsed >= budget.maxTurns) {
      return `Turn budget exhausted (${execution.turnsUsed}/${budget.maxTurns})`;
    }
    if (budget.maxCostUsd !== undefined && execution.costUsedUsd >= budget.maxCostUsd) {
      return `Cost budget exhausted ($${execution.costUsedUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})`;
    }
    if (budget.deadlineAt !== undefined && now >= budget.deadlineAt) {
      return `Execution deadline reached (${new Date(budget.deadlineAt).toISOString()})`;
    }
    return null;
  }

  private async evaluateVerification(
    goal: GoalItem,
    output: string,
    evidence: Record<string, boolean>,
    judge?: GoalJudge,
  ): Promise<GoalVerification> {
    const contract = goal.metadata.contract!;
    const criteria: GoalCriterionResult[] = contract.acceptanceCriteria.map((criterion) => {
      const required = criterion.required !== false;
      let passed = false;
      let reason: string;
      switch (criterion.kind) {
        case 'contains':
          passed = output.toLocaleLowerCase().includes(criterion.expected!.toLocaleLowerCase());
          reason = passed ? 'Expected text was present' : `Missing expected text: ${criterion.expected}`;
          break;
        case 'equals':
          passed = output.trim() === criterion.expected!.trim();
          reason = passed ? 'Output matched exactly' : 'Output did not match the expected value';
          break;
        case 'regex':
          passed = new RegExp(criterion.expected!, 'i').test(output);
          reason = passed ? 'Output matched the required pattern' : `Output did not match /${criterion.expected}/i`;
          break;
        case 'manual':
          passed = evidence[criterion.id] === true;
          reason = passed ? 'Required evidence was supplied' : 'Required evidence was not supplied';
          break;
      }
      return { id: criterion.id, passed, required, reason };
    });

    const required = criteria.filter((criterion) => criterion.required);
    let passed = contract.requireAll === false
      ? required.some((criterion) => criterion.passed)
      : required.every((criterion) => criterion.passed);
    let judgeReason: string | undefined;

    if (passed && judge) {
      try {
        const judgment = await judge({ goal, output, deterministicResults: criteria });
        passed = judgment.passed;
        judgeReason = judgment.reason;
      } catch (error) {
        passed = false;
        judgeReason = `Judge failed closed: ${(error as Error).message}`;
      }
    }

    return { passed, criteria, judgedAt: Date.now(), judgeReason };
  }

  // ============ Queries ============

  /**
   * List goals by filter
   */
  async listGoals(userId: string, filter: GoalFilter = {}): Promise<GoalItem[]> {
    // Goals are durable state and therefore bypass ordinary memory decay and
    // `is_latest` filtering. The database migration repairs legacy rows too.
    let memories = this.db.getGoalMemoriesByUser(userId);
    let repaired = false;
    for (const memory of memories) {
      const metadata = memory.metadata as unknown as GoalMetadata;
      if (metadata.status !== 'completed'
        && (!memory.isLatest || memory.memoryType !== 'static_profile' || memory.prominence !== 1)) {
        this.db.updateMemory(memory.id, {
          isLatest: true,
          memoryType: 'static_profile',
          prominence: 1,
        });
        repaired = true;
      }
    }
    if (repaired) memories = this.db.getGoalMemoriesByUser(userId);

    // Filter to goal items
    let goals = memories.filter(isGoalItem).map((m) => this.memoryToGoalItem(m));

    // Apply filters
    if (filter.type) {
      goals = goals.filter((g) => g.metadata.goalType === filter.type);
    }
    if (filter.status) {
      goals = goals.filter((g) => g.metadata.status === filter.status);
    }
    if (!filter.includeCompleted && !filter.status) {
      goals = goals.filter((g) => g.metadata.status !== 'completed');
    }
    if (filter.tags && filter.tags.length > 0) {
      goals = goals.filter(
        (g) =>
          g.metadata.tags &&
          filter.tags!.some((tag) => g.metadata.tags!.includes(tag))
      );
    }
    if (filter.minProgress !== undefined) {
      goals = goals.filter(
        (g) => (g.metadata.progress ?? 0) >= filter.minProgress!
      );
    }
    if (filter.maxProgress !== undefined) {
      goals = goals.filter(
        (g) => (g.metadata.progress ?? 0) <= filter.maxProgress!
      );
    }
    if (filter.dueBefore !== undefined) {
      goals = goals.filter(
        (g) => g.metadata.dueDate && g.metadata.dueDate <= filter.dueBefore!
      );
    }
    if (filter.dueAfter !== undefined) {
      goals = goals.filter(
        (g) => g.metadata.dueDate && g.metadata.dueDate >= filter.dueAfter!
      );
    }

    return goals.slice(0, filter.limit ?? 100);
  }

  /**
   * Get all active goals
   */
  async getActiveGoals(userId: string): Promise<GoalItem[]> {
    return this.listGoals(userId, { type: 'goal', status: 'active' });
  }

  /**
   * Get all active tasks (across all goals)
   */
  async getActiveTasks(userId: string): Promise<GoalItem[]> {
    return this.listGoals(userId, { type: 'task', status: 'active' });
  }

  /**
   * Get children of a goal item
   */
  async getChildren(parentId: string): Promise<GoalItem[]> {
    const parent = await this.getGoal(parentId);
    if (!parent) {
      return [];
    }

    // Get incoming EXTENDS relations (children point to parent)
    const relations = this.db.getIncomingRelations(parentId, 'EXTENDS');
    const children: GoalItem[] = [];

    for (const relation of relations) {
      const child = await this.getGoal(relation.sourceId);
      if (child) {
        children.push(child);
      }
    }

    return children;
  }

  /**
   * Get milestones for a goal
   */
  async getMilestones(goalId: string): Promise<GoalItem[]> {
    const children = await this.getChildren(goalId);
    return children.filter((c) => c.metadata.goalType === 'milestone');
  }

  /**
   * Get tasks for a milestone
   */
  async getTasks(milestoneId: string): Promise<GoalItem[]> {
    const children = await this.getChildren(milestoneId);
    return children.filter((c) => c.metadata.goalType === 'task');
  }

  /**
   * Get full goal hierarchy
   */
  async getGoalHierarchy(goalId: string): Promise<GoalTree | null> {
    const goal = await this.getGoal(goalId);
    if (!goal || goal.metadata.goalType !== 'goal') {
      return null;
    }

    const milestones = await this.getMilestones(goalId);
    const milestonesWithTasks = await Promise.all(
      milestones.map(async (milestone) => ({
        milestone,
        tasks: await this.getTasks(milestone.id),
      }))
    );

    // Calculate total progress
    const totalProgress = await this.calculateProgress(goalId);

    return {
      goal,
      milestones: milestonesWithTasks,
      totalProgress,
    };
  }

  // ============ Progress ============

  /**
   * Calculate progress for a goal or milestone
   */
  async calculateProgress(id: string): Promise<number> {
    const item = await this.getGoal(id);
    if (!item) {
      return 0;
    }

    if (item.metadata.status === 'completed') {
      return 100;
    }

    const children = await this.getChildren(id);
    if (children.length === 0) {
      // No children and not completed (already checked above), so 0%
      return 0;
    }

    const completedCount = children.filter(
      (c) => c.metadata.status === 'completed'
    ).length;

    return Math.round((completedCount / children.length) * 100);
  }

  /**
   * Update progress for an item and store it
   */
  private async updateProgress(id: string): Promise<void> {
    const progress = await this.calculateProgress(id);
    const goal = await this.getGoal(id);
    if (goal) {
      this.db.updateMemory(id, {
        metadata: { ...goal.metadata, progress },
      });
    }
  }

  /**
   * Get progress summary for all active goals
   */
  async getProgressSummary(userId: string): Promise<GoalProgress[]> {
    const activeGoals = await this.getActiveGoals(userId);
    const now = Date.now();

    return Promise.all(
      activeGoals.map(async (goal) => {
        const tree = await this.getGoalHierarchy(goal.id);
        const milestones = tree?.milestones ?? [];

        const totalTasks = milestones.reduce(
          (sum, m) => sum + m.tasks.length,
          0
        );
        const completedTasks = milestones.reduce(
          (sum, m) =>
            sum + m.tasks.filter((t) => t.metadata.status === 'completed').length,
          0
        );
        const completedMilestones = milestones.filter(
          (m) => m.milestone.metadata.status === 'completed'
        ).length;

        return {
          goalId: goal.id,
          title: goal.content,
          status: goal.metadata.status,
          progress: goal.metadata.progress ?? 0,
          totalMilestones: milestones.length,
          completedMilestones,
          totalTasks,
          completedTasks,
          dueDate: goal.metadata.dueDate,
          isOverdue: goal.metadata.dueDate ? goal.metadata.dueDate < now : false,
        };
      })
    );
  }

  // ============ Proactive Check-ins ============

  /**
   * Schedule a proactive check-in for a goal
   */
  async scheduleCheckin(goalId: string): Promise<void> {
    const goal = await this.getGoal(goalId);
    if (!goal || goal.metadata.goalType !== 'goal') {
      return;
    }

    const frequency = goal.metadata.checkinFrequency;
    if (!frequency) {
      return;
    }

    const message = `Goal check-in: ${goal.content}`;

    // Check for existing similar scheduled item
    if (this.db.hasSimilarPendingScheduledItem(goal.userId, message)) {
      return;
    }

    const triggerAt = calculateNextCheckin(frequency);

    this.db.addScheduledItem({
      userId: goal.userId,
      sessionId: null,
      source: 'agent',
      type: 'goal_checkin',
      message,
      context: JSON.stringify({
        goalId,
        goalTitle: goal.content,
        progress: goal.metadata.progress ?? 0,
      }),
      triggerAt,
      recurring: null,
      sourceMemoryId: goalId,
      boardStatus: 'scheduled',
    });

    this.logger.info(
      { goalId, frequency, triggerAt: new Date(triggerAt).toISOString() },
      'Goal check-in scheduled'
    );
  }

  /**
   * Reschedule check-in after one fires
   */
  async rescheduleCheckin(goalId: string): Promise<void> {
    const goal = await this.getGoal(goalId);
    if (!goal) {
      return;
    }

    // Update lastCheckin
    this.db.updateMemory(goalId, {
      metadata: { ...goal.metadata, lastCheckin: Date.now() },
    });

    // Schedule next one if not completed
    if (goal.metadata.status !== 'completed') {
      await this.scheduleCheckin(goalId);
    }
  }

  // ============ Search ============

  /**
   * Search goals by text
   */
  async searchGoals(
    userId: string,
    query: string,
    filter: GoalFilter = {}
  ): Promise<GoalItem[]> {
    const goals = await this.listGoals(userId, filter);
    const lowerQuery = query.toLowerCase();

    return goals.filter((goal) => {
      const content = goal.content.toLowerCase();
      const tags = goal.metadata.tags?.join(' ').toLowerCase() ?? '';
      return content.includes(lowerQuery) || tags.includes(lowerQuery);
    });
  }

  // ============ Context for Agent ============

  /**
   * Get goal context for agent system prompt
   */
  async getGoalContext(userId: string, userMessage?: string): Promise<string> {
    const activeGoals = (await this.listGoals(userId, { type: 'goal' })).filter(goal =>
      isGoalLiveForContext(goal, userMessage ?? '')
    );
    if (activeGoals.length === 0) {
      return '';
    }

    // Check if message is goal-relevant
    const goalKeywords = [
      'goal', 'goals', 'task', 'tasks', 'progress', 'milestone',
      'working on', 'todo', 'to do', 'done', 'complete', 'finish',
      'target', 'objective', 'plan', 'planning'
    ];
    const isRelevant =
      !userMessage ||
      goalKeywords.some((kw) => userMessage.toLowerCase().includes(kw)) ||
      activeGoals.some(goal => hasRequestContentOverlap(userMessage, goal.content));

    if (!isRelevant) {
      // Minimal injection
      return `\n[You have ${activeGoals.length} active goal(s)]`;
    }

    // Full injection with hierarchy
    let context = '\n\n## RELEVANT GOAL STATE\n';

    for (const goal of activeGoals.slice(0, 3)) {
      const tree = await this.getGoalHierarchy(goal.id);
      if (!tree) continue;

      context += `\n### ${goal.content}\n`;
      context += `Status: ${goal.metadata.status} | Progress: ${tree.totalProgress}%`;
      if (goal.metadata.dueDate) {
        const due = new Date(goal.metadata.dueDate).toLocaleDateString();
        const isOverdue = goal.metadata.dueDate < Date.now();
        context += ` | Due: ${due}${isOverdue ? ' (OVERDUE)' : ''}`;
      }
      context += '\n';

      if (goal.metadata.contract && goal.metadata.execution) {
        const execution = goal.metadata.execution;
        const budget = goal.metadata.budget ?? DEFAULT_GOAL_BUDGET;
        context += `Execution: ${execution.state} · turns ${execution.turnsUsed}/${budget.maxTurns}`;
        if (budget.maxCostUsd !== undefined) {
          context += ` · cost $${execution.costUsedUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)}`;
        }
        context += '\n';
        context += 'Acceptance contract:\n';
        for (const criterion of goal.metadata.contract.acceptanceCriteria) {
          const latest = execution.lastVerification?.criteria.find((result) => result.id === criterion.id);
          const marker = latest?.passed ? '[x]' : '[ ]';
          context += `  ${marker} ${criterion.description}\n`;
        }
        if (execution.parkReason || execution.blockedReason) {
          context += `Execution note: ${execution.parkReason ?? execution.blockedReason}\n`;
        }
      }

      for (const { milestone, tasks } of tree.milestones) {
        const status = milestone.metadata.status === 'completed' ? '[x]' : '[ ]';
        context += `  ${status} ${milestone.content}\n`;

        for (const task of tasks) {
          const taskStatus = task.metadata.status === 'completed' ? '[x]' : '[ ]';
          context += `    ${taskStatus} ${task.content}\n`;
        }
      }
    }

    if (activeGoals.length > 3) {
      context += `\n...and ${activeGoals.length - 3} more goal(s)\n`;
    }

    return context;
  }

  // ============ Helpers ============

  /**
   * Convert memory entry to goal item
   */
  private memoryToGoalItem(memory: ScallopMemoryEntry): GoalItem {
    return {
      ...memory,
      metadata: memory.metadata as unknown as GoalMetadata,
    };
  }

  /**
   * Get the underlying database (for trigger evaluator)
   */
  getDatabase(): ScallopDatabase {
    return this.db;
  }
}
