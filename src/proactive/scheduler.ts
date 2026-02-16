/**
 * Unified Scheduler - Combines triggers and reminders into a single system
 *
 * Handles both:
 * - Nudges (kind='nudge'): Pre-written messages delivered directly
 * - Tasks (kind='task'): Background work via sub-agent, result sent to user
 *
 * Supports recurring items with kind preservation across reschedules.
 */

import type { Logger } from 'pino';
import type {
  ScallopDatabase,
  ScheduledItem,
  RecurringSchedule,
} from '../memory/db.js';
import type { CostTracker } from '../routing/cost.js';
import type { GoalService } from '../goals/index.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import type { SessionManager } from '../agent/session.js';
import { parseUserIdPrefix } from '../triggers/types.js';
import { formatProactiveMessage, type ProactiveFormatInput } from './proactive-format.js';
import { detectProactiveEngagement } from './feedback.js';

/**
 * Handler for sending messages to users
 */
export type MessageHandler = (userId: string, message: string) => Promise<boolean>;

/**
 * Options for UnifiedScheduler
 */
export interface UnifiedSchedulerOptions {
  /** Database instance */
  db: ScallopDatabase;
  /** Logger instance */
  logger: Logger;
  /** Cost tracker for recording sub-agent usage */
  costTracker?: CostTracker;
  /** Goal service for goal check-in context (optional) */
  goalService?: GoalService;
  /** Sub-agent executor for task-kind items (optional — graceful degradation if absent) */
  subAgentExecutor?: SubAgentExecutor;
  /** Session manager for creating scheduler session */
  sessionManager?: SessionManager;
  /** Check interval in milliseconds (default: 30 seconds) */
  interval?: number;
  /** Maximum age for expired items in milliseconds (default: 24 hours) */
  maxItemAge?: number;
  /** Handler to send messages to users */
  onSendMessage: MessageHandler;
  /** Callback to resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
}

/**
 * UnifiedScheduler - Handles both user reminders and agent triggers
 */
export class UnifiedScheduler {
  private db: ScallopDatabase;
  private logger: Logger;
  private goalService?: GoalService;
  private subAgentExecutor?: SubAgentExecutor;
  private sessionManager?: SessionManager;
  private costTracker?: CostTracker;
  private interval: number;
  private maxItemAge: number;
  private onSendMessage: MessageHandler;
  private getTimezone: (userId: string) => string;

  private schedulerSessionId: string | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private evaluating = false;
  private pendingEvaluation = false;

  constructor(options: UnifiedSchedulerOptions) {
    this.db = options.db;
    this.logger = options.logger.child({ component: 'unified-scheduler' });
    this.costTracker = options.costTracker;
    this.goalService = options.goalService;
    this.subAgentExecutor = options.subAgentExecutor;
    this.sessionManager = options.sessionManager;
    this.interval = options.interval ?? 30 * 1000; // 30 seconds
    this.maxItemAge = options.maxItemAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onSendMessage = options.onSendMessage;
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('UnifiedScheduler already running');
      return;
    }

    this.isRunning = true;
    this.logger.info({ intervalMs: this.interval }, 'Starting UnifiedScheduler');

    // Create a persistent scheduler session for sub-agent parenting
    if (this.sessionManager) {
      try {
        const session = await this.sessionManager.createSession({ source: 'scheduler' });
        this.schedulerSessionId = session.id;
        this.logger.debug({ sessionId: session.id }, 'Scheduler session created');
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Failed to create scheduler session — tasks will fall back to nudges');
      }
    }

    // Consolidate duplicate reminders on startup
    try {
      const removed = this.db.consolidateDuplicateScheduledItems();
      if (removed > 0) {
        this.logger.info({ duplicatesRemoved: removed }, 'Consolidated duplicate scheduled items on startup');
      }
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to consolidate duplicates on startup');
    }

    // Run immediately, then on interval
    this.evaluate().catch(err => {
      this.logger.error({ error: (err as Error).message }, 'Initial scheduler evaluation failed');
    });

    this.intervalHandle = setInterval(() => {
      this.evaluate().catch(err => {
        this.logger.error({ error: (err as Error).message }, 'Scheduler evaluation failed');
      });
    }, this.interval);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    this.logger.info('UnifiedScheduler stopped');
  }

  /**
   * Evaluate and process due items
   */
  async evaluate(): Promise<void> {
    // Prevent overlapping evaluations — if a previous tick is still processing
    // (e.g. waiting on sub-agent), defer this tick so it runs after the current one finishes
    if (this.evaluating) {
      this.pendingEvaluation = true;
      this.logger.debug('Deferring scheduler tick — previous evaluation still running');
      return;
    }
    this.evaluating = true;

    try {
      // First, expire old items
      const expiredCount = this.db.expireOldScheduledItems(this.maxItemAge);
      if (expiredCount > 0) {
        this.logger.debug({ count: expiredCount }, 'Expired old scheduled items');
      }

      // Atomically claim due items (marks them 'processing' so no other tick can grab them)
      const dueItems = this.db.claimDueScheduledItems();
      if (dueItems.length === 0) {
        return;
      }

      this.logger.info({ count: dueItems.length }, 'Found due scheduled items');

      // Separate nudges and tasks — process nudges first (fast), then tasks (may block)
      const nudges = dueItems.filter(i => i.kind !== 'task');
      const tasks = dueItems.filter(i => i.kind === 'task');

      // Process nudges first
      for (const item of nudges) {
        try {
          await this.processNudge(item);
          this.markItemFiredAndReschedule(item);
        } catch (err) {
          this.logger.error(
            { itemId: item.id, error: (err as Error).message },
            'Failed to process nudge'
          );
          this.db.resetScheduledItemToPending(item.id);
        }
      }

      // Process tasks (may involve sub-agent execution)
      for (const item of tasks) {
        try {
          await this.processTask(item);
          this.markItemFiredAndReschedule(item);
        } catch (err) {
          this.logger.error(
            { itemId: item.id, error: (err as Error).message },
            'Failed to process task'
          );
          this.db.resetScheduledItemToPending(item.id);
        }
      }
    } finally {
      this.evaluating = false;

      // If a tick was deferred while we were evaluating, run it now
      if (this.pendingEvaluation) {
        this.pendingEvaluation = false;
        this.logger.debug('Running deferred scheduler evaluation');
        // Use setImmediate to avoid deep recursion under sustained load
        setImmediate(() => {
          this.evaluate().catch(err => {
            this.logger.error({ error: (err as Error).message }, 'Deferred scheduler evaluation failed');
          });
        });
      }
    }
  }

  /**
   * Process a nudge item — send pre-written message directly
   */
  private async processNudge(item: ScheduledItem): Promise<void> {
    this.logger.debug(
      { itemId: item.id, source: item.source, type: item.type },
      'Processing nudge'
    );

    if (item.source === 'agent') {
      await this.sendFormattedMessage(item, item.message);
    } else {
      // User-sourced: send directly
      await this.onSendMessage(item.userId, item.message);
    }
  }

  /**
   * Process a task item — spawn sub-agent, send result
   * Falls back to nudge delivery if sub-agent is unavailable or fails
   */
  private async processTask(item: ScheduledItem): Promise<void> {
    this.logger.debug(
      { itemId: item.id, type: item.type, taskConfig: item.taskConfig },
      'Processing task'
    );

    // If sub-agent executor is not available, fall back to nudge
    if (!this.subAgentExecutor || !this.schedulerSessionId || !item.taskConfig) {
      this.logger.debug({ itemId: item.id }, 'Sub-agent unavailable, falling back to nudge');
      await this.processNudge(item);
      return;
    }

    try {
      // Enrich the task goal with context and guidance from the scheduled item
      // so the sub-agent understands WHY it was spawned and has enough detail
      let enrichedTask = item.taskConfig.goal;
      if (item.context) {
        try {
          const ctx = JSON.parse(item.context) as Record<string, unknown>;
          const parts: string[] = [];
          if (ctx.original_context) {
            parts.push(`Context: ${ctx.original_context}`);
          }
          if (ctx.guidance && ctx.guidance !== item.taskConfig.goal) {
            parts.push(`Guidance: ${ctx.guidance}`);
          }
          parts.push(`Task: ${item.taskConfig.goal}`);
          enrichedTask = parts.join('\n');
        } catch {
          // Context parsing failed, use goal as-is
        }
      }

      const result = await this.subAgentExecutor.spawnAndWait(
        this.schedulerSessionId,
        {
          task: enrichedTask,
          skills: item.taskConfig.tools,
          modelTier: item.taskConfig.modelTier ?? 'fast',
          timeoutSeconds: 120,
        },
      );

      if (result.response) {
        // Send the sub-agent's result through proactive formatting
        await this.sendFormattedMessage(item, result.response, 'task_result');
        this.logger.info(
          { itemId: item.id, iterations: result.iterationsUsed, taskComplete: result.taskComplete },
          'Task completed via sub-agent'
        );
      } else {
        // Sub-agent returned empty response — fall back to nudge
        this.logger.warn({ itemId: item.id }, 'Sub-agent returned empty response, sending fallback nudge');
        await this.sendFormattedMessage(item, item.message);
      }
    } catch (err) {
      // Sub-agent failed — fall back to nudge
      this.logger.warn(
        { itemId: item.id, error: (err as Error).message },
        'Sub-agent task failed, falling back to nudge'
      );
      await this.sendFormattedMessage(item, item.message);
    }
  }

  /**
   * Send a formatted message to the user.
   * For agent-sourced items, applies per-channel proactive formatting.
   */
  private async sendFormattedMessage(
    item: ScheduledItem,
    message: string,
    sourceOverride?: 'task_result' | 'inner_thoughts' | 'gap_scanner',
  ): Promise<void> {
    if (item.source === 'agent') {
      const { channel } = parseUserIdPrefix(item.userId);

      if (channel === 'telegram' || channel === 'api' || !channel) {
        // Parse gapType from item context if available
        let gapType: string | undefined;
        let urgency: 'low' | 'medium' | 'high' = 'low';
        let source: 'inner_thoughts' | 'gap_scanner' | 'task_result' = sourceOverride ?? 'gap_scanner';
        if (item.context) {
          try {
            const ctx = JSON.parse(item.context) as Record<string, unknown>;
            gapType = ctx.gapType as string | undefined;
            if (ctx.urgency === 'high' || ctx.urgency === 'medium' || ctx.urgency === 'low') {
              urgency = ctx.urgency as 'low' | 'medium' | 'high';
            }
            if (!sourceOverride && ctx.source === 'inner_thoughts') {
              source = 'inner_thoughts';
            }
          } catch {
            // Context parsing failed, use defaults
          }
        }

        const formatInput: ProactiveFormatInput = {
          message,
          gapType,
          urgency,
          source,
        };

        const formatted = formatProactiveMessage((channel ?? 'telegram') as 'telegram' | 'api', formatInput);
        const formattedStr = typeof formatted === 'string'
          ? formatted
          : JSON.stringify(formatted);

        await this.onSendMessage(item.userId, formattedStr);
        return;
      }
    }

    // User-sourced items or unknown channels: send as-is
    await this.onSendMessage(item.userId, message);
  }

  /**
   * Mark item as fired and reschedule if recurring
   */
  private markItemFiredAndReschedule(item: ScheduledItem): void {
    this.db.markScheduledItemFired(item.id);
    this.logger.info(
      { itemId: item.id, userId: item.userId, source: item.source, type: item.type, kind: item.kind },
      'Scheduled item fired'
    );

    // Handle recurring items
    if (item.recurring) {
      const nextTriggerAt = this.calculateNextOccurrence(item.recurring, item.userId);
      if (nextTriggerAt) {
        // Skip reschedule if a similar item already exists (prevents duplication)
        if (this.db.hasSimilarPendingScheduledItem(item.userId, item.message)) {
          this.logger.debug({ itemId: item.id }, 'Skipping reschedule - similar item already pending');
          return;
        }
        // Create a new item for the next occurrence
        this.db.addScheduledItem({
          userId: item.userId,
          sessionId: item.sessionId,
          source: item.source,
          kind: item.kind,
          type: item.type,
          message: item.message,
          context: item.context,
          triggerAt: nextTriggerAt,
          recurring: item.recurring,
          sourceMemoryId: item.sourceMemoryId,
          taskConfig: item.taskConfig,
        });
        this.logger.debug(
          { itemId: item.id, nextTrigger: new Date(nextTriggerAt).toISOString() },
          'Rescheduled recurring item'
        );
      }
    }

    // Reschedule goal check-ins through goal service
    if (item.type === 'goal_checkin' && item.context && this.goalService) {
      try {
        const context = JSON.parse(item.context);
        if (context.goalId) {
          this.goalService.rescheduleCheckin(context.goalId).catch(err => {
            this.logger.error({ goalId: context.goalId, error: (err as Error).message }, 'Failed to reschedule goal check-in');
          });
          this.logger.debug({ goalId: context.goalId }, 'Goal check-in rescheduled');
        }
      } catch {
        // Context parsing failed, skip rescheduling
      }
    }
  }

  /**
   * Calculate the next occurrence for a recurring schedule
   */
  private calculateNextOccurrence(schedule: RecurringSchedule, userId: string): number | null {
    const tz = this.getTimezone(userId);

    // Get current date/time components in the user's timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = formatter.formatToParts(now);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

    const userYear = parseInt(getPart('year'), 10);
    const userMonth = parseInt(getPart('month'), 10) - 1;
    const userDay = parseInt(getPart('day'), 10);
    const userHour = parseInt(getPart('hour'), 10);
    const userMinute = parseInt(getPart('minute'), 10);

    // Guard against NaN from unexpected Intl.DateTimeFormat output
    if ([userYear, userMonth, userDay, userHour, userMinute].some(Number.isNaN)) {
      this.logger.warn({ tz }, 'Failed to parse timezone date parts, falling back to system time');
      return now.getTime() + 24 * 60 * 60 * 1000;
    }

    const dayNames: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const userDayOfWeek = dayNames[getPart('weekday')] ?? now.getDay();

    // Helper: build a UTC timestamp for a given date in the user's timezone
    const toUtc = (y: number, m: number, d: number, h: number, min: number): number => {
      // Format as ISO-ish string and interpret in the user's timezone
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
      // Use a trick: compute the offset between the user's timezone and UTC
      const utcDate = new Date(dateStr + 'Z');
      const localStr = utcDate.toLocaleString('en-US', { timeZone: tz });
      const localDate = new Date(localStr);
      const offsetMs = localDate.getTime() - utcDate.getTime();
      return new Date(dateStr + 'Z').getTime() - offsetMs;
    };

    // Start from "today" in user timezone, at the scheduled time
    let targetDay = userDay;
    let targetMonth = userMonth;
    let targetYear = userYear;
    const advance = () => {
      const d = new Date(targetYear, targetMonth, targetDay + 1);
      targetDay = d.getDate();
      targetMonth = d.getMonth();
      targetYear = d.getFullYear();
    };
    const getDow = () => new Date(targetYear, targetMonth, targetDay).getDay();

    switch (schedule.type) {
      case 'daily':
        advance(); // tomorrow
        break;

      case 'weekly':
        if (schedule.dayOfWeek !== undefined) {
          let daysUntil = schedule.dayOfWeek - userDayOfWeek;
          if (daysUntil <= 0) daysUntil += 7;
          for (let i = 0; i < daysUntil; i++) advance();
        } else {
          for (let i = 0; i < 7; i++) advance();
        }
        break;

      case 'weekdays':
        advance();
        while (getDow() === 0 || getDow() === 6) advance();
        break;

      case 'weekends':
        advance();
        while (getDow() !== 0 && getDow() !== 6) advance();
        break;

      default:
        return null;
    }

    return toUtc(targetYear, targetMonth, targetDay, schedule.hour, schedule.minute);
  }

  /**
   * Manually trigger evaluation (for testing)
   */
  async evaluateNow(): Promise<void> {
    await this.evaluate();
  }

  /**
   * Check for user engagement with recently-fired proactive items.
   * Call this when a user sends a message to detect engagement.
   *
   * For each recently-fired agent item within the engagement window,
   * marks it as 'acted' to close the trust feedback loop.
   */
  checkEngagement(userId: string): void {
    try {
      const items = this.db.getScheduledItemsByUser(userId);
      const actedIds = detectProactiveEngagement(userId, items);
      for (const id of actedIds) {
        this.db.markScheduledItemActed(id);
      }
      if (actedIds.length > 0) {
        this.logger.debug({ userId, actedCount: actedIds.length }, 'Proactive engagement detected');
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message, userId }, 'Engagement detection failed');
    }
  }

  /**
   * Get count of pending items
   */
  getPendingCount(): number {
    return this.db.getDueScheduledItems().length;
  }

  /**
   * Check if scheduler is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }
}
