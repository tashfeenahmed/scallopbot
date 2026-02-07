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

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

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
    // First, expire old items
    const expiredCount = this.db.expireOldScheduledItems(this.maxItemAge);
    if (expiredCount > 0) {
      this.logger.debug({ count: expiredCount }, 'Expired old scheduled items');
    }

    // Get due items
    const dueItems = this.db.getDueScheduledItems();
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
   * Send a formatted message to the user
   */
  private async sendFormattedMessage(item: ScheduledItem, message: string): Promise<void> {
    if (item.source === 'user') {
      // User reminders get a "Reminder!" header
      await this.onSendMessage(item.userId, `**Reminder!**\n\n${message}`);
    } else {
      // Agent triggers are sent as-is (they're already contextual)
      await this.onSendMessage(item.userId, message);
    }
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
      const nextTriggerAt = this.calculateNextOccurrence(item.recurring);
      if (nextTriggerAt) {
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
  private calculateNextOccurrence(schedule: RecurringSchedule): number | null {
    const now = new Date();
    const target = new Date();
    target.setHours(schedule.hour, schedule.minute, 0, 0);

    switch (schedule.type) {
      case 'daily':
        // Move to tomorrow at the scheduled time
        target.setDate(target.getDate() + 1);
        break;

      case 'weekly':
        if (schedule.dayOfWeek !== undefined) {
          // Find next occurrence of the day
          const currentDay = now.getDay();
          let daysUntil = schedule.dayOfWeek - currentDay;
          if (daysUntil <= 0) {
            daysUntil += 7;
          }
          target.setDate(target.getDate() + daysUntil);
        } else {
          // No day specified, just add a week
          target.setDate(target.getDate() + 7);
        }
        break;

      case 'weekdays':
        // Move to next weekday
        target.setDate(target.getDate() + 1);
        while (target.getDay() === 0 || target.getDay() === 6) {
          target.setDate(target.getDate() + 1);
        }
        break;

      case 'weekends':
        // Move to next weekend day
        target.setDate(target.getDate() + 1);
        while (target.getDay() !== 0 && target.getDay() !== 6) {
          target.setDate(target.getDate() + 1);
        }
        break;

      default:
        return null;
    }

    return target.getTime();
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

    const prompt = `You are a proactive personal assistant. Generate a brief, friendly message for ${triggerTypeDescriptions[item.type] || 'following up'}.

TRIGGER CONTEXT:
- Type: ${item.type}
- Description: ${item.message}
- Original context: ${item.context || 'None'}
${goalContext}
${memoryContext ? `RELEVANT MEMORIES:\n${memoryContext}\n` : ''}
GUIDELINES:
- Be conversational and warm, not robotic
- Keep it brief (1-3 sentences)
- Make it feel natural, like a helpful friend checking in
- For event_prep: Offer to help prepare or remind of details
- For commitment_check: Gently check progress, don't be pushy
- For goal_checkin: Be encouraging, celebrate small wins, mention specific progress
- For follow_up: Reference the original context naturally
- Don't use emojis unless appropriate for the context
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
