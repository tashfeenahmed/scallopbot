/**
 * TriggerEvaluator - Processes proactive triggers and sends agent-initiated messages
 *
 * This runs on an interval, checks for due triggers in SQLite, generates
 * contextual messages using LLM, and sends them via the appropriate channel.
 */

import type { Logger } from 'pino';
import type { ScallopDatabase, ProactiveTriggerEntry } from '../memory/db.js';
import type { LLMProvider, ContentBlock } from '../providers/types.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { GoalService } from '../goals/index.js';

/**
 * Handler for sending proactive messages
 */
export type ProactiveMessageHandler = (
  userId: string,
  message: string
) => Promise<boolean>;

/**
 * Handler for running messages through the agent (for actionable triggers)
 */
export type AgentProcessHandler = (
  userId: string,
  message: string
) => Promise<string | null>;

/**
 * Options for TriggerEvaluator
 */
export interface TriggerEvaluatorOptions {
  /** Database instance */
  db: ScallopDatabase;
  /** Memory store for context retrieval */
  memoryStore: ScallopMemoryStore;
  /** LLM provider for generating messages */
  provider: LLMProvider;
  /** Logger instance */
  logger: Logger;
  /** Goal service for goal check-in context (optional) */
  goalService?: GoalService;
  /** Check interval in milliseconds (default: 5 minutes) */
  interval?: number;
  /** Maximum age for expired triggers in milliseconds (default: 24 hours) */
  maxTriggerAge?: number;
  /** Handler to send messages to users */
  onSendMessage: ProactiveMessageHandler;
  /** Optional handler to process actionable triggers through the agent */
  onAgentProcess?: AgentProcessHandler;
}

/**
 * TriggerEvaluator - Evaluates and fires proactive triggers
 */
export class TriggerEvaluator {
  private db: ScallopDatabase;
  private memoryStore: ScallopMemoryStore;
  private provider: LLMProvider;
  private logger: Logger;
  private goalService?: GoalService;
  private interval: number;
  private maxTriggerAge: number;
  private onSendMessage: ProactiveMessageHandler;
  private onAgentProcess?: AgentProcessHandler;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: TriggerEvaluatorOptions) {
    this.db = options.db;
    this.memoryStore = options.memoryStore;
    this.provider = options.provider;
    this.logger = options.logger.child({ component: 'trigger-evaluator' });
    this.goalService = options.goalService;
    this.interval = options.interval ?? 5 * 60 * 1000; // 5 minutes
    this.maxTriggerAge = options.maxTriggerAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onSendMessage = options.onSendMessage;
    this.onAgentProcess = options.onAgentProcess;
  }

  /**
   * Start the trigger evaluator
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn('TriggerEvaluator already running');
      return;
    }

    this.isRunning = true;
    this.logger.info({ intervalMs: this.interval }, 'Starting TriggerEvaluator');

    // Run immediately, then on interval
    this.evaluate().catch(err => {
      this.logger.error({ error: (err as Error).message }, 'Initial trigger evaluation failed');
    });

    this.intervalHandle = setInterval(() => {
      this.evaluate().catch(err => {
        this.logger.error({ error: (err as Error).message }, 'Trigger evaluation failed');
      });
    }, this.interval);
  }

  /**
   * Stop the trigger evaluator
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    this.logger.info('TriggerEvaluator stopped');
  }

  /**
   * Evaluate and process due triggers
   */
  async evaluate(): Promise<void> {
    // First, expire old triggers
    const expiredCount = this.db.expireOldTriggers(this.maxTriggerAge);
    if (expiredCount > 0) {
      this.logger.debug({ count: expiredCount }, 'Expired old triggers');
    }

    // Get due triggers
    const dueTriggers = this.db.getDueTriggers();
    if (dueTriggers.length === 0) {
      return;
    }

    this.logger.info({ count: dueTriggers.length }, 'Found due triggers');

    // Process each trigger
    for (const trigger of dueTriggers) {
      try {
        await this.processTrigger(trigger);
      } catch (err) {
        this.logger.error(
          { triggerId: trigger.id, error: (err as Error).message },
          'Failed to process trigger'
        );
      }
    }
  }

  /**
   * Process a single trigger
   */
  private async processTrigger(trigger: ProactiveTriggerEntry): Promise<void> {
    this.logger.debug(
      { triggerId: trigger.id, type: trigger.type, description: trigger.description },
      'Processing trigger'
    );

    // Generate the proactive message
    const message = await this.generateMessage(trigger);
    if (!message) {
      this.logger.warn({ triggerId: trigger.id }, 'Failed to generate message, marking as fired anyway');
      this.db.markTriggerFired(trigger.id);
      return;
    }

    // Check if this is an actionable trigger (event_prep might need agent to check calendar, etc.)
    const isActionable = trigger.type === 'event_prep' && this.onAgentProcess;

    if (isActionable && this.onAgentProcess) {
      // Run through agent for potential action execution
      this.logger.debug({ triggerId: trigger.id }, 'Processing actionable trigger through agent');
      const agentResponse = await this.onAgentProcess(trigger.userId, message);
      if (agentResponse) {
        // Agent processed it, send the agent's response
        await this.onSendMessage(trigger.userId, agentResponse);
      } else {
        // Agent didn't produce a response, send the generated message
        await this.onSendMessage(trigger.userId, message);
      }
    } else {
      // Simple trigger - just send the message
      await this.onSendMessage(trigger.userId, message);
    }

    // Mark as fired
    this.db.markTriggerFired(trigger.id);
    this.logger.info(
      { triggerId: trigger.id, userId: trigger.userId, type: trigger.type },
      'Proactive trigger fired'
    );

    // Reschedule goal check-ins
    if (trigger.type === 'goal_checkin' && this.goalService) {
      try {
        const context = JSON.parse(trigger.context);
        if (context.goalId) {
          await this.goalService.rescheduleCheckin(context.goalId);
          this.logger.debug({ goalId: context.goalId }, 'Goal check-in rescheduled');
        }
      } catch {
        // Context parsing failed, skip rescheduling
      }
    }
  }

  /**
   * Generate a contextual proactive message using LLM
   */
  private async generateMessage(trigger: ProactiveTriggerEntry): Promise<string | null> {
    // Get relevant memories for context
    let memoryContext = '';
    try {
      const memories = await this.memoryStore.search(trigger.description, {
        userId: trigger.userId,
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
    if (trigger.type === 'goal_checkin' && this.goalService) {
      try {
        const triggerContext = JSON.parse(trigger.context);
        if (triggerContext.goalId) {
          const tree = await this.goalService.getGoalHierarchy(triggerContext.goalId);
          if (tree) {
            goalContext = `\nGOAL PROGRESS:\n`;
            goalContext += `- Goal: ${tree.goal.content}\n`;
            goalContext += `- Overall progress: ${tree.totalProgress}%\n`;

            const activeMilestones = tree.milestones.filter(m => m.milestone.metadata.status === 'active');
            const completedMilestones = tree.milestones.filter(m => m.milestone.metadata.status === 'completed');

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

    const triggerTypeDescriptions: Record<string, string> = {
      event_prep: 'preparing the user for an upcoming event',
      commitment_check: 'checking in on a commitment the user made',
      goal_checkin: 'checking in on progress toward a goal',
      follow_up: 'following up on something the user mentioned',
    };

    const prompt = `You are a proactive personal assistant. Generate a brief, friendly message for ${triggerTypeDescriptions[trigger.type] || 'following up'}.

TRIGGER CONTEXT:
- Type: ${trigger.type}
- Description: ${trigger.description}
- Original context: ${trigger.context}
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
        ? response.content.map((block: ContentBlock) => 'text' in block ? block.text : '').join('')
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
   * Get pending triggers count
   */
  getPendingCount(): number {
    return this.db.getDueTriggers().length;
  }
}
