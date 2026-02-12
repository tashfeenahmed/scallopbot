/**
 * Unified Scheduler - Combines triggers and reminders into a single system
 *
 * Handles both:
 * - User-set reminders (source='user'): Direct message delivery
 * - Agent-set triggers (source='agent'): LLM-generated contextual messages
 *
 * Supports recurring items and actionable items that run through the agent.
 */

import type { Logger } from 'pino';
import type {
  ScallopDatabase,
  ScheduledItem,
  ScheduledItemSource,
  ScheduledItemType,
  RecurringSchedule,
} from '../memory/db.js';
import type { LLMProvider, ContentBlock } from '../providers/types.js';
import type { CostTracker } from '../routing/cost.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { GoalService } from '../goals/index.js';
import { parseUserIdPrefix } from '../triggers/types.js';
import { formatProactiveMessage, type ProactiveFormatInput } from './proactive-format.js';
import { detectProactiveEngagement } from './feedback.js';

/**
 * Handler for sending messages to users
 */
export type MessageHandler = (userId: string, message: string) => Promise<boolean>;

/**
 * Handler for running messages through the agent (for actionable items)
 */
export type AgentProcessHandler = (
  userId: string,
  sessionId: string | null,
  message: string
) => Promise<string | null>;

/**
 * Options for UnifiedScheduler
 */
export interface UnifiedSchedulerOptions {
  /** Database instance */
  db: ScallopDatabase;
  /** Memory store for context retrieval */
  memoryStore: ScallopMemoryStore;
  /** LLM provider for generating messages (for agent-set items) */
  provider: LLMProvider;
  /** Logger instance */
  logger: Logger;
  /** Cost tracker for recording LLM usage from scheduled messages */
  costTracker?: CostTracker;
  /** Goal service for goal check-in context (optional) */
  goalService?: GoalService;
  /** Check interval in milliseconds (default: 30 seconds) */
  interval?: number;
  /** Maximum age for expired items in milliseconds (default: 24 hours) */
  maxItemAge?: number;
  /** Handler to send messages to users */
  onSendMessage: MessageHandler;
  /** Optional handler to process actionable items through the agent */
  onAgentProcess?: AgentProcessHandler;
  /** Callback to resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
}

/**
 * Keywords that indicate an actionable item (should run through agent)
 */
const ACTION_KEYWORDS = [
  'check',
  'get',
  'find',
  'search',
  'look up',
  'tell me',
  'show',
  'fetch',
  'run',
  'execute',
  'do',
];

/**
 * UnifiedScheduler - Handles both user reminders and agent triggers
 */
export class UnifiedScheduler {
  private db: ScallopDatabase;
  private memoryStore: ScallopMemoryStore;
  private provider: LLMProvider;
  private logger: Logger;
  private goalService?: GoalService;
  private interval: number;
  private maxItemAge: number;
  private onSendMessage: MessageHandler;
  private onAgentProcess?: AgentProcessHandler;
  private getTimezone: (userId: string) => string;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private evaluating = false;
  private pendingEvaluation = false;

  constructor(options: UnifiedSchedulerOptions) {
    this.db = options.db;
    this.memoryStore = options.memoryStore;
    // Wrap provider with cost tracking if available
    this.provider = options.costTracker
      ? options.costTracker.wrapProvider(options.provider, 'scheduler')
      : options.provider;
    this.logger = options.logger.child({ component: 'unified-scheduler' });
    this.goalService = options.goalService;
    this.interval = options.interval ?? 30 * 1000; // 30 seconds
    this.maxItemAge = options.maxItemAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onSendMessage = options.onSendMessage;
    this.onAgentProcess = options.onAgentProcess;
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn('UnifiedScheduler already running');
      return;
    }

    this.isRunning = true;
    this.logger.info({ intervalMs: this.interval }, 'Starting UnifiedScheduler');

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
    // (e.g. waiting on LLM), defer this tick so it runs after the current one finishes
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

      // Process each item
      for (const item of dueItems) {
        try {
          await this.processItem(item);
        } catch (err) {
          this.logger.error(
            { itemId: item.id, error: (err as Error).message },
            'Failed to process scheduled item'
          );
          // Reset to pending so it can be retried on the next tick
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
   * Process a single scheduled item
   */
  private async processItem(item: ScheduledItem): Promise<void> {
    this.logger.debug(
      { itemId: item.id, source: item.source, type: item.type, message: item.message },
      'Processing scheduled item'
    );

    let message: string;

    if (item.source === 'user') {
      // User-set reminder: use stored message directly
      message = item.message;
    } else {
      // Agent-set trigger: generate contextual message using LLM
      const generatedMessage = await this.generateMessage(item);
      if (!generatedMessage) {
        this.logger.warn({ itemId: item.id }, 'Failed to generate message, marking as fired anyway');
        this.markItemFiredAndReschedule(item);
        return;
      }
      message = generatedMessage;
    }

    // Check if this is an actionable item
    const isActionable = this.isActionable(item);

    if (isActionable && this.onAgentProcess) {
      // Run through agent for potential action execution
      this.logger.debug({ itemId: item.id }, 'Processing actionable item through agent');

      const promptPrefix =
        item.source === 'user'
          ? '[SCHEDULED REMINDER - Execute this task now]:'
          : '[PROACTIVE CHECK - Context for you to check in on]:';

      const agentResponse = await this.onAgentProcess(item.userId, item.sessionId, `${promptPrefix} ${message}`);

      if (agentResponse) {
        // Agent processed it, send the agent's response
        await this.onSendMessage(item.userId, agentResponse);
      } else {
        // Agent didn't produce a response, send the message directly
        await this.sendFormattedMessage(item, message);
      }
    } else {
      // Simple item - just send the message
      await this.sendFormattedMessage(item, message);
    }

    // Mark as fired and handle recurring
    this.markItemFiredAndReschedule(item);
  }

  /**
   * Check if an item should be processed through the agent
   */
  private isActionable(item: ScheduledItem): boolean {
    // Agent-set event_prep triggers are always actionable
    if (item.source === 'agent' && item.type === 'event_prep') {
      return true;
    }

    // User reminders with action keywords are actionable
    if (item.source === 'user') {
      return ACTION_KEYWORDS.some(keyword => item.message.toLowerCase().includes(keyword));
    }

    return false;
  }

  /**
   * Send a formatted message to the user.
   * For agent-sourced items, applies per-channel proactive formatting.
   */
  private async sendFormattedMessage(item: ScheduledItem, message: string): Promise<void> {
    if (item.source === 'agent') {
      const { channel } = parseUserIdPrefix(item.userId);

      if (channel === 'telegram' || channel === 'api') {
        // Parse gapType from item context if available
        let gapType: string | undefined;
        let urgency: 'low' | 'medium' | 'high' = 'low';
        let source: 'inner_thoughts' | 'gap_scanner' = 'gap_scanner';
        if (item.context) {
          try {
            const ctx = JSON.parse(item.context) as Record<string, unknown>;
            gapType = ctx.gapType as string | undefined;
            if (ctx.urgency === 'high' || ctx.urgency === 'medium' || ctx.urgency === 'low') {
              urgency = ctx.urgency as 'low' | 'medium' | 'high';
            }
            if (ctx.source === 'inner_thoughts') {
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

        const formatted = formatProactiveMessage(channel, formatInput);
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
      { itemId: item.id, userId: item.userId, source: item.source, type: item.type },
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
          type: item.type,
          message: item.message,
          context: item.context,
          triggerAt: nextTriggerAt,
          recurring: item.recurring,
          sourceMemoryId: item.sourceMemoryId,
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
   * Generate a contextual message for agent-set triggers using LLM
   */
  private async generateMessage(item: ScheduledItem): Promise<string | null> {
    // Get relevant memories for context
    let memoryContext = '';
    try {
      const memories = await this.memoryStore.search(item.message, {
        userId: item.userId,
        limit: 5,
      });
      if (memories.length > 0) {
        memoryContext = memories.map(m => `- ${m.memory.content}`).join('\n');
      }
    } catch {
      // Memory search is optional
    }

    // Get goal progress context for goal_checkin triggers
    let goalContext = '';
    if (item.type === 'goal_checkin' && item.context && this.goalService) {
      try {
        const triggerContext = JSON.parse(item.context);
        if (triggerContext.goalId) {
          const tree = await this.goalService.getGoalHierarchy(triggerContext.goalId);
          if (tree) {
            goalContext = `\nGOAL PROGRESS:\n`;
            goalContext += `- Goal: ${tree.goal.content}\n`;
            goalContext += `- Overall progress: ${tree.totalProgress}%\n`;

            const activeMilestones = tree.milestones.filter(
              m => m.milestone.metadata.status === 'active'
            );
            const completedMilestones = tree.milestones.filter(
              m => m.milestone.metadata.status === 'completed'
            );

            goalContext += `- Milestones: ${completedMilestones.length}/${tree.milestones.length} completed\n`;

            if (activeMilestones.length > 0) {
              goalContext += `- Currently working on: ${activeMilestones.map(m => m.milestone.content).join(', ')}\n`;
            }

            // Find pending tasks
            const pendingTasks = tree.milestones
              .flatMap(m => m.tasks)
              .filter(t => t.metadata.status !== 'completed')
              .slice(0, 3);

            if (pendingTasks.length > 0) {
              goalContext += `- Next tasks: ${pendingTasks.map(t => t.content).join(', ')}\n`;
            }
          }
        }
      } catch {
        // Goal context is optional
      }
    }

    const triggerTypeDescriptions: Record<ScheduledItemType, string> = {
      reminder: 'reminding the user about something they set',
      event_prep: 'preparing the user for an upcoming event',
      commitment_check: 'checking in on a commitment the user made',
      goal_checkin: 'checking in on progress toward a goal',
      follow_up: 'following up on something the user mentioned',
    };

    // Parse context: may be structured JSON with guidance, or a plain string
    let originalContext = item.context || 'None';
    let guidance = '';
    if (item.context) {
      try {
        const parsedContext = JSON.parse(item.context) as {
          original_context?: string;
          guidance?: string;
        };
        if (parsedContext.original_context) {
          originalContext = parsedContext.original_context;
        }
        if (parsedContext.guidance) {
          guidance = parsedContext.guidance;
        }
      } catch {
        // Not JSON — use as plain string (backward compatible)
      }
    }

    const now = new Date();
    const tz = this.getTimezone(item.userId);
    const tzOptions = { timeZone: tz };
    const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...tzOptions });
    const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOptions });

    const prompt = `You are a proactive personal assistant. Generate a brief, friendly message for ${triggerTypeDescriptions[item.type] || 'following up'}.

CURRENT DATE: ${currentDate}
CURRENT TIME: ${currentTime}

TRIGGER CONTEXT:
- Type: ${item.type}
- Description: ${item.message}
- Original context: ${originalContext}
${guidance ? `- Guidance (what to do): ${guidance}\n` : ''}${goalContext}
${memoryContext ? `RELEVANT MEMORIES:\n${memoryContext}\n` : ''}
GUIDELINES:
- Be conversational and warm, not robotic
- Keep it brief (1-3 sentences)
- Make it feel natural, like a helpful friend checking in
- For event_prep: Offer to help prepare or remind of details
- For commitment_check: Gently check progress, don't be pushy
- For goal_checkin: Be encouraging, celebrate small wins, mention specific progress
- For follow_up: Reference the original context naturally
${guidance ? '- Follow the guidance instructions to help the user proactively\n' : ''}- Don't use emojis unless appropriate for the context
- Start directly with the message, no greeting needed

Generate the proactive message:`;

    try {
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        maxTokens: 150,
      });

      const responseText = Array.isArray(response.content)
        ? response.content
            .map((block: ContentBlock) => ('text' in block ? block.text : ''))
            .join('')
        : String(response.content);

      return responseText.trim();
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to generate proactive message');
      return null;
    }
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
