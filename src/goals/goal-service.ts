/**
 * Goal Service
 *
 * Core service for hierarchical goal tracking.
 * Uses existing memory infrastructure with goal-specific operations.
 */

import type { Logger } from 'pino';
import type { ScallopDatabase, ScallopMemoryEntry } from '../memory/db.js';
import type {
  GoalItem,
  GoalTree,
  GoalFilter,
  GoalMetadata,
  GoalType,
  GoalStatus,
  CheckinFrequency,
  CreateGoalOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  UpdateGoalOptions,
  GoalProgress,
} from './types.js';
import { isGoalItem } from './types.js';

/**
 * Options for GoalService
 */
export interface GoalServiceOptions {
  db: ScallopDatabase;
  logger: Logger;
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

/**
 * GoalService - Manages hierarchical goal tracking
 */
export class GoalService {
  private db: ScallopDatabase;
  private logger: Logger;

  constructor(options: GoalServiceOptions) {
    this.db = options.db;
    this.logger = options.logger.child({ component: 'goal-service' });
  }

  // ============ CRUD Operations ============

  /**
   * Create a new goal
   */
  async createGoal(userId: string, options: CreateGoalOptions): Promise<GoalItem> {
    const metadata: GoalMetadata = {
      goalType: 'goal',
      status: options.status ?? 'backlog',
      dueDate: options.dueDate,
      checkinFrequency: options.checkinFrequency,
      tags: options.tags,
      progress: 0,
    };

    const memory = this.db.addMemory({
      userId,
      content: options.title,
      category: 'insight',
      memoryType: 'regular',
      importance: 8, // Goals are high importance
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
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

    const memory = this.db.addMemory({
      userId: goal.userId,
      content: options.title,
      category: 'insight',
      memoryType: 'regular',
      importance: 7,
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
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
   * Create a task under a milestone
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

    const memory = this.db.addMemory({
      userId: milestone.userId,
      content: options.title,
      category: 'insight',
      memoryType: 'regular',
      importance: 6,
      confidence: 1.0,
      isLatest: true,
      documentDate: Date.now(),
      eventDate: options.dueDate ?? null,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: metadata as Record<string, unknown>,
    });

    // Create EXTENDS relation to parent milestone
    this.db.addRelation(memory.id, milestoneId, 'EXTENDS');

    const task = this.memoryToGoalItem(memory);
    this.logger.info(
      { taskId: task.id, milestoneId, title: options.title },
      'Task created'
    );

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
    const memory = this.db.getMemory(id);
    if (!memory || !isGoalItem(memory)) {
      return null;
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

    // Delete the goal itself
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

  // ============ Queries ============

  /**
   * List goals by filter
   */
  async listGoals(userId: string, filter: GoalFilter = {}): Promise<GoalItem[]> {
    // Get all insight memories for user
    const memories = this.db.getMemoriesByUser(userId, {
      category: 'insight',
      isLatest: true,
      limit: filter.limit ?? 100,
    });

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

    return goals;
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
    const activeGoals = await this.getActiveGoals(userId);
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
      goalKeywords.some((kw) => userMessage.toLowerCase().includes(kw));

    if (!isRelevant) {
      // Minimal injection
      return `\n[You have ${activeGoals.length} active goal(s)]`;
    }

    // Full injection with hierarchy
    let context = '\n\n## ACTIVE GOALS\n';

    for (const goal of activeGoals.slice(0, 3)) {
      const tree = await this.getGoalHierarchy(goal.id);
      if (!tree) continue;

      context += `\n### ${goal.content}\n`;
      context += `Progress: ${tree.totalProgress}%`;
      if (goal.metadata.dueDate) {
        const due = new Date(goal.metadata.dueDate).toLocaleDateString();
        const isOverdue = goal.metadata.dueDate < Date.now();
        context += ` | Due: ${due}${isOverdue ? ' (OVERDUE)' : ''}`;
      }
      context += '\n';

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
