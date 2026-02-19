/**
 * Unified Scheduler - Processes scheduled items and delivers messages.
 *
 * All items are delivered as nudges (pre-written messages).
 * Supports recurring items with automatic rescheduling.
 */

import type { Logger } from 'pino';
import type {
  ScallopDatabase,
  ScheduledItem,
  RecurringSchedule,
  BoardItemResult,
} from '../memory/db.js';
import { BoardService } from '../board/board-service.js';
import { computeBoardStatus } from '../board/types.js';
import type { GoalService } from '../goals/index.js';
import type { SessionManager } from '../agent/session.js';
import { parseUserIdPrefix } from '../triggers/types.js';
import { formatProactiveMessage, type ProactiveFormatInput } from './proactive-format.js';
import { detectProactiveEngagement } from './feedback.js';

/**
 * Strip internal markup, XML function calls, error prefixes, and thinking blocks
 * from raw sub-agent output so it's safe to show to the user.
 * Returns empty string if nothing meaningful remains.
 */
function sanitizeAgentResponse(raw: string): string {
  if (!raw) return '';

  let cleaned = raw
    // Strip <function_calls>...</function_calls> blocks (and unclosed ones)
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '')
    // Strip <invoke ...>...</invoke> blocks
    .replace(/<invoke[\s\S]*?(<\/invoke>|$)/g, '')
    // Strip <*> blocks (thinking, etc.)
    .replace(/<\w+[\s\S]*?(<\/antml:\w+>|$)/g, '')
    // Strip "Error: ..." lines (internal errors, not user-facing)
    .replace(/^Error:\s*.*/gm, '')
    .trim();

  // If nothing meaningful remains, return empty
  if (cleaned.length < 5) return '';
  return cleaned;
}

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
  /** Goal service for goal check-in context (optional) */
  goalService?: GoalService;
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
  private sessionManager?: SessionManager;
  private interval: number;
  private maxItemAge: number;
  private onSendMessage: MessageHandler;
  private getTimezone: (userId: string) => string;

  private boardService: BoardService;
  private schedulerSessionId: string | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private evaluating = false;
  private pendingEvaluation = false;
  /** Counter for periodic dedup consolidation (every ~10 min) */
  private evalTickCount = 0;

  constructor(options: UnifiedSchedulerOptions) {
    this.db = options.db;
    this.logger = options.logger.child({ component: 'unified-scheduler' });
    this.goalService = options.goalService;
    this.sessionManager = options.sessionManager;
    this.interval = options.interval ?? 30 * 1000; // 30 seconds
    this.maxItemAge = options.maxItemAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onSendMessage = options.onSendMessage;
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.boardService = new BoardService(this.db, this.logger);
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

      // Periodic dedup consolidation (~every 10 minutes)
      this.evalTickCount++;
      if (this.evalTickCount % 20 === 0) {
        try {
          const removed = this.db.consolidateDuplicateScheduledItems();
          if (removed > 0) {
            this.logger.info({ duplicatesRemoved: removed }, 'Periodic duplicate consolidation');
          }
        } catch (err) {
          this.logger.warn({ error: (err as Error).message }, 'Periodic consolidation failed');
        }
      }

      // Atomically claim due items (marks them 'processing' so no other tick can grab them)
      const dueItems = this.db.claimDueScheduledItems();
      if (dueItems.length === 0) {
        return;
      }

      // Quiet hours: defer agent-sourced items between 10 PM and 8 AM user-local time.
      // User-sourced reminders always fire immediately (the user set the exact time).
      const tz = this.getTimezone(dueItems[0].userId);
      const hourNow = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false })
          .formatToParts(new Date())
          .find(p => p.type === 'hour')?.value ?? '12',
        10
      );
      const isQuietHours = hourNow >= 22 || hourNow < 8;

      if (isQuietHours) {
        const deferred: ScheduledItem[] = [];
        const ready: ScheduledItem[] = [];
        for (const item of dueItems) {
          if (item.source === 'agent') {
            // Reset to pending and reschedule to 8 AM in user's timezone.
            // Compute hours until 8 AM from the user's current hour.
            this.db.resetScheduledItemToPending(item.id);
            const hoursUntil8am = hourNow >= 8 ? (24 - hourNow + 8) : (8 - hourNow);
            const next8amMs = Date.now() + hoursUntil8am * 60 * 60 * 1000;
            this.db.updateScheduledItemBoard(item.id, { triggerAt: next8amMs });
            deferred.push(item);
          } else {
            ready.push(item);
          }
        }
        if (deferred.length > 0) {
          this.logger.debug({ count: deferred.length }, 'Deferred agent items to morning (quiet hours)');
        }
        if (ready.length === 0) return;
        // Replace dueItems with only user-sourced ready items
        dueItems.length = 0;
        dueItems.push(...ready);
      }

      this.logger.info({ count: dueItems.length }, 'Found due scheduled items');

      // Dependency check: skip items whose dependencies aren't done/archived
      const readyItems = dueItems.filter(item => {
        if (!item.dependsOn || item.dependsOn.length === 0) return true;
        for (const depId of item.dependsOn) {
          const dep = this.db.getScheduledItem(depId);
          if (!dep) continue; // deleted dependency counts as resolved
          const depBoard = computeBoardStatus(dep);
          if (depBoard !== 'done' && depBoard !== 'archived') {
            // Dependency not resolved — reset to pending with a delayed trigger
            this.db.resetScheduledItemToPending(item.id);
            this.db.updateScheduledItemBoard(item.id, {
              boardStatus: 'waiting',
              triggerAt: Date.now() + 60 * 60 * 1000, // retry in 1 hour
            });
            this.logger.debug({ itemId: item.id, blockedBy: depId }, 'Item blocked by dependency');
            return false;
          }
        }
        return true;
      });

      // All items delivered as nudges (pre-written message, no sub-agent).
      // Sub-agent task execution disabled — too expensive for scheduled items.
      for (const item of readyItems) {
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

    await this.sendFormattedMessage(item, item.message);
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
            if (!sourceOverride) {
              // Unified evaluator writes source: 'proactive_evaluator'.
              // Classify by gapType: session follow-ups → inner_thoughts, rest → gap_scanner.
              if (ctx.source === 'inner_thoughts' || ctx.source === 'proactive_evaluator') {
                source = gapType === 'unresolved_thread' ? 'inner_thoughts' : 'gap_scanner';
              }
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
        await this.onSendMessage(item.userId, formatted);
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
        // Create a new item for the next occurrence (preserves board fields)
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
          boardStatus: 'scheduled',
          priority: item.priority,
          labels: item.labels,
          goalId: item.goalId,
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

  /**
   * Send a morning digest of unnotified completed items.
   * Call this at quiet hours end (e.g., 7 AM) to consolidate overnight results.
   */
  async sendMorningDigest(userId: string): Promise<number> {
    const unnotified = this.db.getUnnotifiedCompletedItems(userId);
    if (unnotified.length === 0) return 0;

    const lines: string[] = ['While you were away:'];

    for (const item of unnotified) {
      const result = item.result;
      const title = item.message;
      if (result) {
        // Sanitize and truncate the result for the digest
        const clean = sanitizeAgentResponse(result.response);
        if (clean) {
          const truncated = clean.length > 200 ? clean.slice(0, 200) + '…' : clean;
          lines.push(`- ${title}: ${truncated}`);
        } else {
          // Result was all internal markup/errors — just show the title
          lines.push(`- ${title}`);
        }
      } else {
        lines.push(`- ${title}`);
      }

      // Mark as notified
      if (result) {
        const updatedResult: BoardItemResult = { ...result, notifiedAt: Date.now() };
        this.db.updateScheduledItemResult(item.id, updatedResult);
      }
    }

    if (lines.length > 1) {
      await this.onSendMessage(userId, lines.join('\n'));
    }

    this.logger.info({ userId, count: unnotified.length }, 'Sent morning digest');
    return unnotified.length;
  }

  /**
   * Get the board service instance (for use by cognitive layer)
   */
  getBoardService(): BoardService {
    return this.boardService;
  }
}
