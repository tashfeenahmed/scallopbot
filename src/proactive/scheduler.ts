/**
 * Unified Scheduler - Processes scheduled items and delivers messages.
 *
 * Nudge-kind items are delivered as pre-written messages.
 * Task-kind items are executed by a sub-agent and never fall back to raw task text.
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
import type { SubAgentExecutor } from '../subagent/index.js';
import type { Router } from '../routing/router.js';
import {
  isMessageDeliveryReceipt,
  isMessageDeliverySuppressed,
  messageWasDelivered,
  parseUserIdPrefix,
  type MessageDeliveryHandler,
  type MessageDeliveryMetadata,
  type MessageDeliveryResult,
} from '../triggers/types.js';
import { formatProactiveMessage, type ProactiveFormatInput } from './proactive-format.js';
import {
  attributeProactiveEngagement,
  parseProactiveReplyAction,
  proactiveIdentityCandidates,
  type ProactiveFeedbackResult,
  type ProactiveEngagementContext,
} from './feedback.js';
import { getRecentChatContext } from './chat-context.js';
import { wordOverlap } from '../utils/text-similarity.js';
import { resolveStateUserId } from '../utils/state-user-id.js';
import {
  prepareUserFacingProactiveMessage,
  renderCompletedWorkDigest,
  sanitizeProactiveMessage,
  summarizeTaskResultForDelivery,
} from './message-safety.js';
import { assessProactiveMessage } from './message-quality.js';
import {
  MAX_AGENT_SENDS_PER_DAY,
  MIN_GAP_MS,
  PROACTIVE_STYLE_HISTORY_MS,
} from './proactive-config.js';
import { getTodayStartMs } from './proactive-utils.js';
import {
  parseProactivePreferences,
  proactiveTopicMatchesText,
} from '../memory/proactive-evaluator.js';

/** How long to remember recently sent messages for dedup (2 hours).
 *  Extended from 30min so a recurring cognitive-layer signal that fires every
 *  60-90min doesn't slip through with rephrased wording. */
const SEND_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Word overlap threshold to consider two proactive messages "the same".
 *  Lowered from 0.5 → 0.3 since LLM-generated nudges about the same topic
 *  often phrase it differently (e.g. "hope legs aren't sore" vs
 *  "how are you feeling after the leg workout"). */
const SEND_DEDUP_THRESHOLD = 0.3;
/** Hard floor on time between any two agent-sourced proactive sends to the
 *  same user. Bypassed for user-set reminders (they have explicit times).
 *  Honors PROACTIVE_MIN_GAP_MS (previously the env var was read by
 *  proactive-config but silently ignored here — a hard-coded 1h won). */
const MIN_AGENT_PROACTIVE_GAP_MS = MIN_GAP_MS;
const ACTIVE_CONVERSATION_WINDOW_MS = 5 * 60 * 1000;
const ACTIVE_CONVERSATION_DEFERRAL_MS = 30 * 60 * 1000;
const MAX_EXPLICIT_REMINDER_RETRY_MS = 6 * 60 * 60 * 1000;
const SOURCE_RESOLUTION_RE = /\b(?:done|completed|finished|resolved|cancelled|canceled|called off|already handled|no (?:follow[- ]?up|reminder) (?:is |was )?needed)\b/i;
const ANAPHORIC_RESOLUTION_RE = /\b(?:it|that|this)(?:'s| is| was| has been)\s+(?:already\s+)?(?:done|completed|finished|resolved|cancelled|canceled|handled)\b|\b(?:done|completed|finished|resolved|cancelled|canceled|handled)\s+(?:it|that|this)\b/i;
const RESOLUTION_STOP_WORDS = new Set([
  'about', 'after', 'again', 'been', 'could', 'did', 'does', 'from', 'going',
  'have', 'into', 'just', 'needed', 'should', 'that', 'the', 'their', 'then',
  'there', 'this', 'was', 'were', 'what', 'when', 'with', 'would', 'your',
]);

function resolutionTopicText(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length >= 3 && !RESOLUTION_STOP_WORDS.has(word))
    .join(' ');
}

function messageResolvesScheduledIntent(message: string, itemText: string): boolean {
  if (!SOURCE_RESOLUTION_RE.test(message)) return false;
  if (ANAPHORIC_RESOLUTION_RE.test(message)) return true;
  const messageTopics = resolutionTopicText(message);
  const itemTopics = resolutionTopicText(itemText);
  return wordOverlap(messageTopics, itemTopics, { minWordLength: 3 }) >= 0.2;
}

function stableMinuteJitter(seed: string, min: number, max: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return min + ((hash >>> 0) % (max - min + 1));
}

function getLocalTimeParts(now: Date, timeZone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find(part => part.type === 'hour')?.value ?? '', 10) % 24;
    const minute = parseInt(parts.find(part => part.type === 'minute')?.value ?? '', 10);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return { hour, minute };
  } catch {
    // Fall through to server-local time for an invalid timezone.
  }
  return { hour: now.getHours(), minute: now.getMinutes() };
}

function millisecondsUntilLocalMorning(now: Date, timeZone: string, jitterSeed?: string): number {
  const { hour, minute } = getLocalTimeParts(now, timeZone);
  const currentMinute = hour * 60 + minute;
  const morningMinute = 8 * 60;
  const minutesUntilMorning = currentMinute < morningMinute
    ? morningMinute - currentMinute
    : 24 * 60 - currentMinute + morningMinute;
  const jitterMinutes = jitterSeed ? stableMinuteJitter(jitterSeed, 5, 20) : 0;
  return Math.max(
    60_000,
    (minutesUntilMorning + jitterMinutes) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds(),
  );
}

/**
 * Strip internal markup, XML function calls, error prefixes, and thinking blocks
 * from raw sub-agent output so it's safe to show to the user.
 * Returns empty string if nothing meaningful remains.
 */
function sanitizeAgentResponse(raw: string): string {
  if (!raw) return '';

  const cleaned = raw
    // Strip <function_calls>...</function_calls> blocks (and unclosed ones)
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '')
    // Strip <invoke ...>...</invoke> blocks
    .replace(/<invoke[\s\S]*?(<\/invoke>|$)/g, '')
    // Strip <*> blocks (thinking, etc.)
    .replace(/<\w+[\s\S]*?(<\/antml:\w+>|$)/g, '')
    // Strip leaked <tool>...</tool>, <query>...</query>, <command>...</command> etc.
    .replace(/<(tool|query|command|result|output|search_query|input|args|parameters|tool_name|tool_input)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    // Strip "Error: ..." lines (internal errors, not user-facing)
    .replace(/^Error:\s*.*/gm, '')
    // Collapse excess whitespace left behind by stripping
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // If nothing meaningful remains, return empty
  if (cleaned.length === 0) return '';
  return cleaned;
}

/**
 * Handler for sending messages to users
 */
export type MessageHandler = MessageDeliveryHandler;
type ProcessOutcome =
  | 'sent'
  | 'suppressed'
  | 'cancelled'
  | 'deferred'
  | 'failed'
  | 'render_failed'
  | 'delivery_failed';

function isFailureOutcome(outcome: ProcessOutcome): boolean {
  return outcome === 'failed' || outcome === 'render_failed' || outcome === 'delivery_failed';
}

interface TaskLeaseContext {
  leaseToken: string;
  isActive: () => boolean;
  renew: () => boolean;
}

interface TaskProcessResult {
  outcome: ProcessOutcome;
  result?: BoardItemResult;
  error?: string;
}

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
  /** Sub-agent executor for task-kind items (optional — unavailable tasks are suppressed) */
  subAgentExecutor?: SubAgentExecutor;
  /** LLM router used only to rewrite instruction-shaped reminder drafts. */
  router?: Pick<Router, 'executeWithFallback'>;
  /** Check interval in milliseconds (default: 30 seconds) */
  interval?: number;
  /** Maximum age for expired items in milliseconds (default: 24 hours) */
  maxItemAge?: number;
  /** Handler to send messages to users */
  onSendMessage: MessageHandler;
  /** Callback to resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
  /** Hard floor in ms between two agent-sourced proactive sends to the same
   *  user. Defaults to the centralized 6h policy. Set to 0 in tests that need multiple agent items
   *  to fire in a single tick. */
  minAgentProactiveGapMs?: number;
  /** Durable worker identity; injectable so multiple schedulers can be tested. */
  workerId?: string;
  /** Lease duration for scheduled task work (default 90 seconds). */
  taskLeaseMs?: number;
  /** Heartbeat cadence while a task sub-agent is running (default lease/3). */
  taskHeartbeatMs?: number;
  /** Delay before retrying execution or delivery failures (default 60 seconds). */
  taskRetryDelayMs?: number;
  /** Age after which an uncompleted nudge claim is treated as abandoned
   *  (default 15 minutes; minimum 60 seconds). */
  nudgeClaimTimeoutMs?: number;
  /** Explicit deployment-owned IDs that map to the single-user `default` record. */
  canonicalSingleUserIds?: string[];
}

/**
 * UnifiedScheduler - Handles both user reminders and agent triggers
 */
export class UnifiedScheduler {
  private db: ScallopDatabase;
  private logger: Logger;
  private goalService?: GoalService;
  private sessionManager?: SessionManager;
  private subAgentExecutor?: SubAgentExecutor;
  private router?: Pick<Router, 'executeWithFallback'>;
  private interval: number;
  private maxItemAge: number;
  private onSendMessage: MessageHandler;
  private getTimezone: (userId: string) => string;

  private boardService: BoardService;
  /** Owner-scoped fallback parents for unattended scheduled sub-agents. */
  private schedulerSessionIds = new Map<string, string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pendingImmediateHandle: ReturnType<typeof setImmediate> | null = null;
  private isRunning = false;
  private isStopping = false;
  private evaluating = false;
  private pendingEvaluation = false;
  /** Counter for periodic dedup consolidation (every ~10 min) */
  private evalTickCount = 0;
  /** Recently sent messages per user for send-time dedup: userId → [{message, time, source}].
   *  Hydrated from SQLite on start() so dedup history survives process restarts.
   *  Bounded by pruning empty arrays after each dedup check to keep memory flat. */
  private recentSends = new Map<string, { message: string; time: number; source: string }[]>();
  private minAgentProactiveGapMs: number;
  private workerId: string;
  private taskLeaseMs: number;
  private taskHeartbeatMs: number;
  private taskRetryDelayMs: number;
  private nudgeClaimTimeoutMs: number;
  private canonicalSingleUserIds: string[];
  private static readonly MAX_RECENT_SEND_USERS = 500;
  private static readonly MAX_TASKS_PER_EVALUATION = 100;

  constructor(options: UnifiedSchedulerOptions) {
    this.db = options.db;
    this.logger = options.logger.child({ component: 'unified-scheduler' });
    this.goalService = options.goalService;
    this.sessionManager = options.sessionManager;
    this.subAgentExecutor = options.subAgentExecutor;
    this.router = options.router;
    this.interval = options.interval ?? 30 * 1000; // 30 seconds
    this.maxItemAge = options.maxItemAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onSendMessage = options.onSendMessage;
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.minAgentProactiveGapMs = options.minAgentProactiveGapMs ?? MIN_AGENT_PROACTIVE_GAP_MS;
    // Stable across restarts so a task handed to the built-in scheduler does
    // not become orphaned when the process PID or deployment changes.
    this.workerId = options.workerId ?? 'scheduler';
    this.taskLeaseMs = Math.max(1_000, Math.floor(options.taskLeaseMs ?? 90_000));
    this.taskHeartbeatMs = Math.max(
      250,
      Math.min(this.taskLeaseMs - 1, Math.floor(options.taskHeartbeatMs ?? this.taskLeaseMs / 3)),
    );
    this.taskRetryDelayMs = Math.max(1_000, Math.floor(options.taskRetryDelayMs ?? 60_000));
    this.nudgeClaimTimeoutMs = Math.max(
      60_000,
      Math.floor(options.nudgeClaimTimeoutMs ?? 15 * 60_000),
    );
    this.canonicalSingleUserIds = [...new Set(options.canonicalSingleUserIds ?? [])];
    this.boardService = new BoardService(this.db, this.logger);
  }

  private async ensureSchedulerSession(userId: string = 'default'): Promise<string | null> {
    const stateUserId = resolveStateUserId(userId, this.canonicalSingleUserIds);
    const existing = this.schedulerSessionIds.get(stateUserId);
    if (existing) return existing;
    if (!this.sessionManager) return null;
    try {
      const { channel } = parseUserIdPrefix(userId);
      const session = await this.sessionManager.createSession({
        source: 'scheduler',
        userId: stateUserId,
        ...(channel ? { channelId: channel } : {}),
      });
      this.schedulerSessionIds.set(stateUserId, session.id);
      this.logger.debug({ sessionId: session.id, userId: stateUserId }, 'Owner-scoped scheduler session created');
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message, userId: stateUserId },
        'Failed to create owner-scoped scheduler session — scheduled tasks will be suppressed',
      );
    }
    return this.schedulerSessionIds.get(stateUserId) ?? null;
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
    this.isStopping = false;
    this.logger.info({ intervalMs: this.interval }, 'Starting UnifiedScheduler');

    // Create a persistent scheduler session for sub-agent parenting
    await this.ensureSchedulerSession();

    // Consolidate duplicate reminders on startup
    try {
      const removed = this.db.consolidateDuplicateScheduledItems();
      if (removed > 0) {
        this.logger.info({ duplicatesRemoved: removed }, 'Consolidated duplicate scheduled items on startup');
      }
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to consolidate duplicates on startup');
    }

    // Hydrate the in-memory dedup map from SQLite so we don't lose history
    // on restart. Without this, a redeploy opens a SEND_DEDUP_WINDOW_MS
    // window in which the cognitive layer can re-emit similar nudges.
    try {
      const since = Date.now() - PROACTIVE_STYLE_HISTORY_MS;
      const recent = this.db.getRecentProactiveSends(since);
      for (const r of recent) {
        const list = this.recentSends.get(r.userId) || [];
        list.push({ message: r.message, time: r.sentAt, source: r.source });
        this.recentSends.set(r.userId, list);
      }
      if (recent.length > 0) {
        this.logger.info({ entries: recent.length, users: this.recentSends.size }, 'Hydrated proactive send-dedup map from SQLite');
      }
      // Keep enough history to detect day-to-day template repetition while
      // bounding disk use on small devices.
      this.db.pruneProactiveSendLog(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to hydrate proactive send log');
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
   * Stop the scheduler. Safe to call mid-evaluate: in-flight evaluate() exits
   * at the next await point via the isStopping guard, and any deferred
   * setImmediate is cancelled so it can't fire after shutdown.
   */
  stop(): void {
    this.isStopping = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.pendingImmediateHandle) {
      clearImmediate(this.pendingImmediateHandle);
      this.pendingImmediateHandle = null;
    }
    this.pendingEvaluation = false;
    this.isRunning = false;
    this.logger.info('UnifiedScheduler stopped');
  }

  /**
   * Evaluate and process due items
   */
  async evaluate(): Promise<void> {
    // Bail immediately if we're shutting down — a tick may have been queued
    // via setInterval or setImmediate moments before stop() was called.
    if (this.isStopping) return;

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

      // A process can die after atomically claiming a nudge but before it can
      // send/reset/complete it. Reclaim only claims older than the conservative
      // timeout; fresh in-flight work remains exclusively owned.
      const reclaimedNudges = this.db.reclaimStaleProcessingNudges(this.nudgeClaimTimeoutMs);
      if (reclaimedNudges > 0) {
        this.logger.warn({ count: reclaimedNudges }, 'Recovered stale processing nudge claims');
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

      // Preserve the historical task-before-nudge ordering so a task result can
      // seed send dedup before a companion proactive nudge is considered.
      this.boardService.reclaimExpiredLeases();
      await this.processDueTasks();

      // Nudges retain the lightweight atomic claim path. Task-kind items are
      // deliberately excluded: they are owned by durable board leases below.
      const dueNudges = this.db.claimDueScheduledItems(Date.now(), 'nudge');
      if (dueNudges.length > 0) {
        // Quiet hours are evaluated per user. A mixed-user batch must not use
        // the first user's timezone for everyone else.
        const now = new Date();
        const readyDuringQuietHours: ScheduledItem[] = [];
        let quietHoursDeferred = 0;
        for (const item of dueNudges) {
          const tz = this.getTimezone(item.userId);
          const { hour } = getLocalTimeParts(now, tz);
          const isQuietHours = hour >= 22 || hour < 8;
          if (item.source === 'agent' && isQuietHours) {
            this.db.updateScheduledItemBoard(item.id, {
              triggerAt: now.getTime() + millisecondsUntilLocalMorning(now, tz, item.id),
            });
            this.db.resetScheduledItemToPending(item.id);
            quietHoursDeferred++;
          } else {
            // User reminders fire at the explicit time the user chose.
            readyDuringQuietHours.push(item);
          }
        }
        if (quietHoursDeferred > 0) {
          this.logger.debug({ count: quietHoursDeferred }, 'Deferred agent items to morning (quiet hours)');
        }

        this.logger.info({ count: readyDuringQuietHours.length }, 'Found due nudge items');

        // Dependency check for nudges. Durable tasks enforce dependencies while claiming.
        const readyNudges = readyDuringQuietHours.filter(item => {
          if (!item.dependsOn || item.dependsOn.length === 0) return true;
          for (const depId of item.dependsOn) {
            const dep = this.db.getScheduledItem(depId);
            if (!dep) continue;
            const depBoard = computeBoardStatus(dep);
            if (depBoard !== 'done' && depBoard !== 'archived') {
              this.db.resetScheduledItemToPending(item.id);
              this.db.updateScheduledItemBoard(item.id, {
                boardStatus: 'waiting',
                triggerAt: Date.now() + 60 * 60 * 1000,
              });
              this.logger.debug({ itemId: item.id, blockedBy: depId }, 'Nudge blocked by dependency');
              return false;
            }
          }
          return true;
        });

        for (const item of readyNudges) {
          try {
            const outcome = await this.processNudge(item);
            if (outcome === 'sent') {
              this.markItemFiredAndReschedule(item);
            } else if (outcome === 'suppressed' || outcome === 'cancelled') {
              this.db.markScheduledItemExpired(item.id);
            } else if (outcome === 'render_failed') {
              this.retryGeneratedNudge(item, 'Generated nudge could not be rendered safely');
            } else if (outcome === 'delivery_failed') {
              this.retryNudgeDelivery(item, 'Nudge delivery failed');
            } else if (outcome === 'failed') {
              this.retryGeneratedNudge(item, 'Generated nudge processing failed');
            }
          } catch (err) {
            this.logger.error(
              { itemId: item.id, error: (err as Error).message },
              'Failed to process scheduled nudge',
            );
            if (item.source === 'user') {
              this.retryExplicitReminderDelivery(item, (err as Error).message);
            } else {
              this.retryGeneratedNudge(item, (err as Error).message);
            }
          }
        }
      }

    } finally {
      this.evaluating = false;

      // If a tick was deferred while we were evaluating, run it now — unless
      // we're shutting down. Track the handle so stop() can cancel it.
      if (this.pendingEvaluation && !this.isStopping) {
        this.pendingEvaluation = false;
        this.logger.debug('Running deferred scheduler evaluation');
        this.pendingImmediateHandle = setImmediate(() => {
          this.pendingImmediateHandle = null;
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
  private async processNudge(item: ScheduledItem): Promise<ProcessOutcome> {
    this.logger.debug(
      { itemId: item.id, source: item.source, type: item.type },
      'Processing nudge'
    );

    if (item.source === 'agent') {
      const preferenceBlock = this.currentPreferenceBlock(item);
      if (preferenceBlock) {
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'suppressed',
          reason: preferenceBlock,
          detail: { itemId: item.id },
        });
        return 'cancelled';
      }

      const invalidSourceReason = this.invalidLinkedSourceReason(item);
      if (invalidSourceReason) {
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'suppressed',
          reason: invalidSourceReason,
          detail: { itemId: item.id },
        });
        return 'cancelled';
      }

      // Cancel only when a newer user turn actually resolves this intent.
      // Unrelated conversation should refresh the renderer, not silently erase
      // a future follow-up.
      const ownedSourceSessionId = this.getOwnedSessionId(item.sessionId, item.userId);
      if (ownedSourceSessionId) {
        const itemText = `${item.message}\n${item.context ?? ''}`;
        const resolvingMessage = this.db.getSessionMessages(ownedSourceSessionId)
          .filter(message => message.role === 'user' && message.createdAt > item.createdAt)
          .find(message => messageResolvesScheduledIntent(message.content, itemText));
        if (resolvingMessage) {
          this.db.recordProactiveDecision({
            userId: item.userId,
            stage: 'deliver',
            outcome: 'suppressed',
            reason: 'source_conversation_changed',
            detail: { itemId: item.id },
          });
          return 'cancelled';
        }
      }

      // Avoid dropping a separate notification into an active exchange. This
      // is a deferral, not a cancellation: the current chat may be unrelated.
      const recent = this.db.getRecentMessagesByUserId(
        item.userId,
        4,
        [...this.ownedIdentityCandidates(item.userId)],
      );
      const latest = recent.at(-1);
      if (latest && Date.now() - latest.createdAt < ACTIVE_CONVERSATION_WINDOW_MS) {
        this.db.updateScheduledItemBoard(item.id, {
          triggerAt: Date.now() + ACTIVE_CONVERSATION_DEFERRAL_MS,
        });
        this.db.resetScheduledItemToPending(item.id);
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'deferred',
          reason: 'active_conversation',
          detail: { itemId: item.id },
        });
        return 'deferred';
      }
    }

    return this.sendFormattedMessage(item, item.message);
  }

  /**
   * Resolve first-class source provenance, retaining a context fallback for
   * wrapper rows created before scheduled_items.source_item_id existed.
   */
  private linkedSourceItemId(item: ScheduledItem): string | null {
    if (item.sourceItemId) return item.sourceItemId;
    if (!item.context) return null;
    try {
      const context = JSON.parse(item.context) as Record<string, unknown>;
      if (typeof context.sourceId !== 'string' || !context.sourceId.trim()) return null;
      if (context.gapType === 'stale_board_item' || context.gapType === 'blocked_item') {
        return context.sourceId;
      }
      // Some legacy rows omitted gapType. Accept the fallback only when it
      // resolves to a real scheduled item; summary/memory IDs remain untouched.
      return this.db.getScheduledItem(context.sourceId) ? context.sourceId : null;
    } catch {
      return null;
    }
  }

  private getOwnedLinkedSourceItem(item: ScheduledItem): ScheduledItem | null {
    const sourceItemId = this.linkedSourceItemId(item);
    if (!sourceItemId || sourceItemId === item.id) return null;
    const source = this.db.getScheduledItem(sourceItemId);
    if (!source || source.userId !== item.userId) return null;
    return source;
  }

  /** Return a delivery-suppression reason when the originating board state changed. */
  private invalidLinkedSourceReason(item: ScheduledItem): string | null {
    const sourceItemId = this.linkedSourceItemId(item);
    if (!sourceItemId) return null;
    if (sourceItemId === item.id) return 'source_item_invalid';
    const source = this.db.getScheduledItem(sourceItemId);
    if (!source) return 'source_item_missing';
    if (source.userId !== item.userId) return 'source_item_owner_mismatch';
    const boardStatus = computeBoardStatus(source);
    if (
      source.status === 'fired'
      || source.status === 'acted'
      || source.status === 'dismissed'
      || source.status === 'expired'
      || boardStatus === 'done'
      || boardStatus === 'archived'
    ) {
      return 'source_item_resolved';
    }
    // A user/worker touched the source after the wrapper was generated. The old
    // wording is no longer grounded even if the item remains active.
    if (source.updatedAt > item.createdAt) return 'source_item_changed';
    return null;
  }

  private retryGeneratedNudge(item: ScheduledItem, error: string): void {
    this.db.recordScheduledNudgeFailure(
      item.id,
      Date.now() + this.taskRetryDelayMs,
      error,
    );
  }

  private retryNudgeDelivery(item: ScheduledItem, error: string): void {
    if (item.source === 'user') {
      this.retryExplicitReminderDelivery(item, error);
      return;
    }
    this.retryGeneratedNudge(item, error);
  }

  /**
   * Explicit reminders are durable user commitments, not speculative model
   * output. Retry transport failures with capped exponential backoff without
   * consuming the generated-content retry budget.
   */
  private retryExplicitReminderDelivery(item: ScheduledItem, error: string): void {
    const exponent = Math.min(item.attemptCount, 8);
    const delay = Math.min(
      MAX_EXPLICIT_REMINDER_RETRY_MS,
      this.taskRetryDelayMs * (2 ** exponent),
    );
    this.db.recordScheduledExplicitDeliveryFailure(
      item.id,
      Date.now() + delay,
      error,
    );
  }

  private currentPreferenceBlock(item: ScheduledItem): 'preference_opt_out' | 'topic_opt_out' | null {
    const profile = parseProactivePreferences(
      this.db.getMemoriesByUser(item.userId, { isLatest: true, limit: 100 })
        .map(memory => memory.content),
    );
    if (profile.globalOptOut) return 'preference_opt_out';

    const itemText = `${item.message}\n${item.context ?? ''}`;
    const blockedTopic = profile.negative
      .filter(rule => rule.scope === 'topic' && rule.topic)
      .some(rule => proactiveTopicMatchesText(rule.topic!, itemText));
    return blockedTopic ? 'topic_opt_out' : null;
  }

  /** Claim and drain the currently due task users through durable worker leases. */
  private async processDueTasks(): Promise<void> {
    const dueUsers = this.db.getReadyBoardTaskUserIds();
    let processed = 0;

    for (const userId of dueUsers) {
      while (processed < UnifiedScheduler.MAX_TASKS_PER_EVALUATION) {
        const claim = this.boardService.claimNextTask(userId, this.workerId, this.taskLeaseMs);
        if (!claim) break;
        processed++;

        const item = this.db.getScheduledItem(claim.item.id);
        if (!item) continue;

        // Agent-created tasks obey quiet hours; explicit user tasks retain the
        // exact time selected by the user. Releasing this administrative claim
        // restores the attempt because no model work was performed.
        const now = new Date();
        const timezone = this.getTimezone(item.userId);
        const { hour } = getLocalTimeParts(now, timezone);
        if (item.source === 'agent' && (hour >= 22 || hour < 8)) {
          this.boardService.deferLeasedTask(
            item.id,
            claim.leaseToken,
            now.getTime() + millisecondsUntilLocalMorning(now, timezone),
            { reason: 'Quiet hours', restoreAttempt: true },
          );
          continue;
        }

        await this.processLeasedTask(item, claim.leaseToken);
      }
    }

    if (processed >= UnifiedScheduler.MAX_TASKS_PER_EVALUATION) {
      this.logger.warn({ processed }, 'Scheduled task evaluation cap reached; remaining work will continue next tick');
    }
  }

  private async processLeasedTask(item: ScheduledItem, leaseToken: string): Promise<void> {
    let leaseActive = true;
    const renew = (): boolean => {
      if (!leaseActive) return false;
      leaseActive = this.boardService.heartbeatTask(item.id, leaseToken, this.taskLeaseMs);
      if (!leaseActive) this.logger.warn({ itemId: item.id }, 'Scheduled task lease was lost');
      return leaseActive;
    };
    const heartbeat = setInterval(renew, this.taskHeartbeatMs);

    try {
      const processed = await this.processTask(item, {
        leaseToken,
        isActive: () => leaseActive,
        renew,
      });

      if (!leaseActive) return;

      if (
        processed.outcome === 'sent' ||
        processed.outcome === 'suppressed' ||
        processed.outcome === 'cancelled'
      ) {
        if (!processed.result || !renew()) return;
        const finalResult: BoardItemResult = {
          ...processed.result,
          notifiedAt: processed.outcome === 'sent' ? Date.now() : processed.result.notifiedAt,
        };
        const completed = this.boardService.completeLeasedTask(item.id, leaseToken, finalResult);
        if (completed) this.markItemFiredAndReschedule(item, true);
        return;
      }

      if (processed.outcome === 'deferred' || (isFailureOutcome(processed.outcome) && processed.result)) {
        const delay = this.taskRetryDelayMs;
        this.boardService.deferLeasedTask(
          item.id,
          leaseToken,
          Date.now() + delay,
          { reason: processed.error ?? (processed.outcome === 'deferred' ? 'Proactive delivery gap' : 'Delivery failed') },
        );
        return;
      }

      this.boardService.failLeasedTask(
        item.id,
        leaseToken,
        processed.error ?? 'Scheduled task execution failed',
        { retryAt: Date.now() + this.taskRetryDelayMs },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Process a task item — execute via sub-agent, send result to user.
   * Silently skips if sub-agent fails (no fallback to raw task description).
   */
  private async processTask(item: ScheduledItem, lease: TaskLeaseContext): Promise<TaskProcessResult> {
    // If the work already completed but delivery failed, retry the stored result
    // instead of executing the task (and its potentially mutating tools) twice.
    if (item.result?.response) {
      const storedResult = sanitizeAgentResponse(item.result.response);
      if (storedResult) {
        if (!lease.renew()) return { outcome: 'failed', error: 'Task lease lost before delivery' };
        const outcome = await this.sendFormattedMessage(item, storedResult, 'task_result', true);
        return { outcome, result: item.result, error: isFailureOutcome(outcome) ? 'Stored result delivery failed' : undefined };
      }
    }

    const config = item.taskConfig;
    const schedulerSessionId = await this.ensureSchedulerSession(item.userId);
    const executionParentSessionId = this.getOwnedSessionId(item.sessionId, item.userId)
      ?? schedulerSessionId;
    if (!config || !this.subAgentExecutor || !executionParentSessionId) {
      this.logger.warn({ itemId: item.id }, 'Scheduled task cannot run; suppressing raw task description');
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'suppressed',
        reason: 'task_executor_unavailable',
        detail: { itemId: item.id },
      });
      const unavailableResult: BoardItemResult = {
        response: 'Task could not run because no sub-agent executor was available.',
        completedAt: Date.now(),
        taskComplete: false,
      };
      if (!lease.renew() || !this.boardService.storeLeasedResult(item.id, lease.leaseToken, unavailableResult)) {
        return { outcome: 'failed', error: 'Task lease lost while recording unavailable executor' };
      }
      return { outcome: 'suppressed', result: unavailableResult };
    }

    this.logger.info(
      { itemId: item.id, goal: config.goal, tools: config.tools },
      'Executing task via sub-agent'
    );

    try {
      // Fetch recent chat context so the sub-agent is aware of ongoing conversations
      const chatContext = getRecentChatContext(this.db, item.userId, {
        identityCandidates: [...this.ownedIdentityCandidates(item.userId)],
      });

      // Grounding directive: scheduled tasks run unattended, so a sub-agent that
      // skips its data tools and improvises output goes unnoticed (e.g. the daily
      // YouTube report that fabricated subscriber counts for weeks). Spell out
      // that the listed tools are the source of truth.
      const toolList = (config.tools ?? []).join(', ');
      const groundedTask = toolList
        ? `${config.goal}\n\nIMPORTANT: Use your tools (${toolList}) to gather the REAL data this task needs. Do not estimate, extrapolate, or invent any numbers. If the data cannot be retrieved, deliver a short honest report saying what failed instead.`
        : config.goal;

      // Preserve the originating session when available so the executor can
      // reapply its channel-specific tool policy. The scheduler session is only
      // a fallback for legacy/task rows without session provenance.
      const result = await this.subAgentExecutor.spawnAndWait(
        executionParentSessionId,
        {
          task: groundedTask,
          label: `scheduled:${item.type}`,
          skills: config.tools,
          modelTier: config.modelTier ?? 'fast',
          // 420s, not 180s: thinking-heavy models (kimi, local qwen) regularly
          // need >3min for multi-tool tasks — at 180s the report runs were
          // timing out and producing nothing at all.
          timeoutSeconds: 420,
          waitForResult: true,
          recentChatContext: chatContext?.formattedContext,
        },
      );

      if (!result.taskComplete) {
        throw new Error('Scheduled sub-agent stopped before completing its task');
      }

      const boardResult: BoardItemResult = {
        response: result.response,
        completedAt: Date.now(),
        iterationsUsed: result.iterationsUsed,
        costUsd: result.costUsd,
        taskComplete: result.taskComplete,
      };
      if (!lease.renew() || !lease.isActive()) {
        return { outcome: 'failed', error: 'Task lease lost before result persistence' };
      }
      if (!this.boardService.storeLeasedResult(item.id, lease.leaseToken, boardResult)) {
        return { outcome: 'failed', error: 'Task lease lost while persisting result' };
      }

      // Send sanitized result to user
      const clean = sanitizeAgentResponse(result.response);
      if (clean) {
        if (!lease.isActive()) return { outcome: 'failed', result: boardResult, error: 'Task lease lost before delivery' };
        const outcome = await this.sendFormattedMessage(item, clean, 'task_result', true);
        if (outcome === 'sent') {
          // Record task description & goal for dedup so companion nudges get suppressed.
          this.recordSend(item.userId, item.message, 'agent_alias');
          if (config.goal && config.goal !== item.message) {
            this.recordSend(item.userId, config.goal, 'agent_alias');
          }
        }
        return { outcome, result: boardResult, error: isFailureOutcome(outcome) ? 'Task result delivery failed' : undefined };
      } else {
        // Sub-agent produced no user-facing output (error, empty, or all-markup response).
        // Don't send the raw task description — it reads like an internal to-do, not a message.
        this.logger.warn({ itemId: item.id }, 'Sub-agent returned no user-facing content, skipping message');
        return { outcome: 'suppressed', result: boardResult };
      }
    } catch (err) {
      // Infrastructure failure (no provider, session error, etc.) — don't confuse user
      // with a raw task description. Just log and skip.
      this.logger.error(
        { itemId: item.id, error: (err as Error).message },
        'Sub-agent execution failed, skipping message'
      );
      return { outcome: 'failed', error: (err as Error).message };
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
    leaseManaged: boolean = false,
  ): Promise<ProcessOutcome> {
    const gapApplies = item.source === 'agent' && sourceOverride !== 'task_result';

    if (sourceOverride === 'task_result') {
      message = await summarizeTaskResultForDelivery(
        message,
        this.router,
        this.getRecentMessagesForStyle(item.userId),
      );
    }
    const originalMessage = message;
    // `source` identifies who initiated an item, not who authored its text.
    // Model-invoked reminder/board tools create user-sourced items too, so only
    // independently proven literal user text may bypass the rendering boundary.
    const isProvenUserLiteral = item.source === 'user'
      && item.messageProvenance === 'user_literal'
      && sourceOverride === undefined;
    const shouldRealizeAtDelivery = !isProvenUserLiteral && sourceOverride !== 'task_result';
    const recentChat = !isProvenUserLiteral && sourceOverride !== 'task_result'
      ? getRecentChatContext(this.db, item.userId, {
          maxMessages: 8,
          maxCharsPerMessage: 350,
          stalenessMs: 7 * 24 * 60 * 60 * 1000,
          identityCandidates: [...this.ownedIdentityCandidates(item.userId)],
        })
      : null;
    const renderResult = isProvenUserLiteral
      ? { outcome: 'ready' as const, message: message.trim() }
      : await prepareUserFacingProactiveMessage(message, this.router, {
          forceRewrite: shouldRealizeAtDelivery,
          context: item.context,
          recentConversation: recentChat?.formattedContext,
          recentMessages: this.getRecentMessagesForStyle(item.userId),
          messageType: sourceOverride ?? item.type,
        });
    if (renderResult.outcome === 'skip') {
      this.logger.info(
        { itemId: item.id, userId: item.userId, source: item.source },
        'Renderer skipped stale or resolved proactive message',
      );
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'suppressed',
        reason: 'renderer_skip',
        detail: { itemId: item.id, source: item.source },
      });
      return 'cancelled';
    }
    if (renderResult.outcome === 'failed') {
      this.logger.warn(
        { itemId: item.id, userId: item.userId, source: item.source },
        'Suppressing unsafe proactive message'
      );
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'suppressed',
        reason: 'unsafe_message',
        detail: { itemId: item.id, source: item.source },
      });
      const sanitizedOriginal = sanitizeProactiveMessage(originalMessage);
      const hasRelationalHardFailure = sanitizedOriginal
        ? assessProactiveMessage(sanitizedOriginal).hardFailures.length > 0
        : false;
      // Relationally unsafe drafts should not burn a model call every minute.
      // Instruction-shaped drafts may simply have hit a transient renderer
      // outage, so they remain pending instead of leaking or being lost.
      return isProvenUserLiteral || hasRelationalHardFailure
        ? 'cancelled'
        : 'render_failed';
    }
    const safeMessage = renderResult.message;
    message = safeMessage;
    if (message !== originalMessage.trim()) {
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'render',
        outcome: 'rewritten',
        reason: 'instruction_draft',
        detail: { itemId: item.id, source: item.source },
      });
    }

    // Send-time dedup: skip if a similar message was sent recently to this user
    if (item.source === 'agent' && this.isDuplicateSend(item.userId, message)) {
      this.logger.info({ itemId: item.id, userId: item.userId }, 'Skipping proactive message — similar one sent recently');
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'suppressed',
        reason: 'send_dedup',
        detail: { itemId: item.id },
      });
      return 'cancelled';
    }

    // Rendering is asynchronous. Re-read the linked board source immediately
    // before transport so a completion/archive/update that raced the model call
    // cannot escape as a stale notification.
    if (item.source === 'agent' && sourceOverride === undefined) {
      const invalidSourceReason = this.invalidLinkedSourceReason(item);
      if (invalidSourceReason) {
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'suppressed',
          reason: invalidSourceReason,
          detail: { itemId: item.id, phase: 'post_render' },
        });
        return 'cancelled';
      }
    }

    // Reserve cross-process capacity at the last safe point before transport.
    // Explicit reminders and completed task results retain their requested
    // cadence and deliberately bypass inferred-outreach budgets.
    let deliveryReservationToken: string | null = null;
    if (gapApplies) {
      const now = new Date();
      const timezone = this.getTimezone(item.userId);
      const todayStart = getTodayStartMs(timezone);
      const nextBudgetAt = now.getTime() + millisecondsUntilLocalMorning(now, timezone, item.id);
      const reservation = this.db.reserveProactiveDelivery({
        itemId: item.id,
        userId: item.userId,
        dayStart: todayStart,
        nextDayStart: nextBudgetAt,
        dailyCap: MAX_AGENT_SENDS_PER_DAY,
        minGapMs: this.minAgentProactiveGapMs,
        now: now.getTime(),
      });
      if (reservation.outcome === 'daily_cap') {
        if (!leaseManaged) {
          this.db.updateScheduledItemBoard(item.id, { triggerAt: reservation.retryAt });
          this.db.resetScheduledItemToPending(item.id);
        }
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'deferred',
          reason: 'daily_delivery_budget',
          detail: { itemId: item.id, cap: MAX_AGENT_SENDS_PER_DAY },
        });
        return 'deferred';
      }
      if (reservation.outcome === 'min_gap') {
        const remainingGapMs = Math.max(1_000, reservation.retryAt - now.getTime());
        this.logger.info({ itemId: item.id, userId: item.userId }, 'Suppressing agent proactive — within reserved min-gap');
        if (!leaseManaged) {
          this.db.updateScheduledItemBoard(item.id, { triggerAt: now.getTime() + remainingGapMs });
          this.db.resetScheduledItemToPending(item.id);
        }
        this.db.recordProactiveDecision({
          userId: item.userId,
          stage: 'deliver',
          outcome: 'suppressed',
          reason: 'min_gap',
          detail: { itemId: item.id },
        });
        return 'deferred';
      }
      deliveryReservationToken = reservation.token;
    }
    this.db.recordProactiveDecision({
      userId: item.userId,
      stage: 'deliver',
      outcome: 'queued',
      reason: 'queued',
      detail: { itemId: item.id, source: item.source },
    });

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
        let delivery: MessageDeliveryResult;
        try {
          delivery = await this.deliverAndRecordConversation(item, formatted, message);
        } catch (error) {
          if (deliveryReservationToken) {
            this.db.releaseProactiveDeliveryReservation(deliveryReservationToken);
          }
          throw error;
        }
        return this.finishDelivery(item, message, delivery, sourceOverride, deliveryReservationToken);
      }
    }

    // User-sourced items or unknown channels: send as-is
    let delivery: MessageDeliveryResult;
    try {
      delivery = await this.deliverAndRecordConversation(item, message);
    } catch (error) {
      if (deliveryReservationToken) {
        this.db.releaseProactiveDeliveryReservation(deliveryReservationToken);
      }
      throw error;
    }
    return this.finishDelivery(item, message, delivery, sourceOverride, deliveryReservationToken);
  }

  private finishDelivery(
    item: ScheduledItem,
    message: string,
    delivery: MessageDeliveryResult,
    sourceOverride?: 'task_result' | 'inner_thoughts' | 'gap_scanner',
    deliveryReservationToken: string | null = null,
  ): ProcessOutcome {
    if (isMessageDeliverySuppressed(delivery)) {
      if (deliveryReservationToken) {
        this.db.releaseProactiveDeliveryReservation(deliveryReservationToken);
      }
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'suppressed',
        reason: delivery.reason,
        detail: { itemId: item.id, source: item.source, phase: 'pre_transport' },
      });
      return 'cancelled';
    }

    if (!messageWasDelivered(delivery)) {
      if (deliveryReservationToken) {
        this.db.releaseProactiveDeliveryReservation(deliveryReservationToken);
      }
      this.db.recordProactiveDecision({
        userId: item.userId,
        stage: 'deliver',
        outcome: 'failed',
        reason: 'delivery_failed',
        detail: { itemId: item.id, source: item.source },
      });
      return 'delivery_failed';
    }

    const sendSource = sourceOverride === 'task_result' ? 'task_result' : item.source;
    let finalizedReservation = false;
    if (deliveryReservationToken) {
      try {
        finalizedReservation = this.db.finalizeProactiveDeliveryReservation(
          deliveryReservationToken,
          message,
          sendSource,
        );
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, itemId: item.id }, 'Failed to finalize proactive delivery reservation');
      }
      if (!finalizedReservation) {
        this.db.releaseProactiveDeliveryReservation(deliveryReservationToken);
      }
    }

    // Persist the exact rendered nudge the channel received. Telegram reply
    // attribution can then match reply_to_message text even when the stored
    // draft was substantially rewritten; sourceItemId remains the authoritative
    // provenance link. Task rows keep their task title rather than a report.
    if (
      sourceOverride === undefined
      && item.messageProvenance === 'generated'
      && message !== item.message.trim()
    ) {
      this.db.updateScheduledItem(item.id, {
        message,
        messageProvenance: 'generated',
      });
    }

    // A completed task report is useful style/dedup history, but it is not one
    // of the independently inferred nudges governed by the daily outreach cap.
    this.recordSend(item.userId, message, sendSource, !finalizedReservation);
    this.db.recordProactiveDecision({
      userId: item.userId,
      stage: 'deliver',
      outcome: 'sent',
      reason: 'sent',
      detail: { itemId: item.id, source: item.source },
    });
    return 'sent';
  }

  /**
   * Keep a scheduled message in its source conversation after delivery.
   * A later user reply can then be understood as a reply to the proactive
   * nudge, including after a process restart when the channel rehydrates the
   * same session. This is deliberately conversation state, not a delivery
   * filter: the agent sees and reasons over the full exchange on its next turn.
   */
  private async deliverAndRecordConversation(
    item: ScheduledItem,
    deliveredMessage: string,
    conversationMessage: string = deliveredMessage,
  ): Promise<MessageDeliveryResult> {
    const metadata: MessageDeliveryMetadata = {
      scheduledItemId: item.id,
      ownerUserId: item.userId,
      ...(this.linkedSourceItemId(item)
        ? {
            validate: () => {
              const reason = this.invalidLinkedSourceReason(item);
              return reason ? { valid: false, reason } : { valid: true };
            },
          }
        : {}),
    };
    const delivery = this.onSendMessage.supportsDeliveryMetadata
      ? await this.onSendMessage(item.userId, deliveredMessage, metadata)
      : await this.onSendMessage(item.userId, deliveredMessage);
    if (!messageWasDelivered(delivery)) return delivery;

    if (isMessageDeliveryReceipt(delivery)) {
      try {
        this.db.recordProactiveDeliveryReceipt({
          channel: delivery.channel,
          channelMessageIds: delivery.messageIds,
          scheduledItemId: item.id,
          ownerUserId: item.userId,
          ambiguous: delivery.combined === true,
        });
      } catch (error) {
        // Transport already succeeded. A provenance write failure must not
        // retry and duplicate the user-visible message; it merely removes
        // source-mutation authority from any later reply.
        this.logger.warn(
          { itemId: item.id, error: (error as Error).message },
          'Failed to persist proactive delivery receipt',
        );
      }
    }

    if (!this.sessionManager) return delivery;

    // Fact/gap generated wrappers historically had no session_id. Attach the
    // delivered assistant turn to the user's latest durable conversation so a
    // later reply has provenance without exposing internal item IDs in text.
    const conversationSessionId = this.getOwnedSessionId(item.sessionId, item.userId)
      ?? this.findLatestOwnedConversationSessionId(item.userId)
      ?? this.getOwnedSessionId(this.getOwnedLinkedSourceItem(item)?.sessionId, item.userId);
    if (!conversationSessionId) return delivery;

    try {
      await this.sessionManager.addMessage(conversationSessionId, {
        role: 'assistant',
        content: conversationMessage,
      });
      this.logger.debug({ itemId: item.id, sessionId: conversationSessionId }, 'Recorded proactive message in source conversation');
    } catch (err) {
      // A missing/deleted source session must not make delivery fail.
      this.logger.warn({ itemId: item.id, sessionId: conversationSessionId, error: (err as Error).message }, 'Failed to record proactive message in source conversation');
    }
    return delivery;
  }

  /** Resolve only explicitly owned/canonical identities, never arbitrary users. */
  private findLatestOwnedConversationSessionId(userId: string): string | null {
    const sessions = [...this.ownedIdentityCandidates(userId)]
      .map(candidate => this.db.findSessionByUserId(candidate))
      .filter((session): session is NonNullable<typeof session> => session != null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions[0]?.id ?? null;
  }

  /** Exact channel/session identities authorized for one durable state owner. */
  private ownedIdentityCandidates(userId: string): Set<string> {
    const candidates = new Set(proactiveIdentityCandidates(userId, this.canonicalSingleUserIds));
    if (resolveStateUserId(userId, this.canonicalSingleUserIds) === 'default') {
      candidates.add('default');
      for (const alias of this.canonicalSingleUserIds) candidates.add(alias);
    }
    return candidates;
  }

  /** Reject stale/corrupt cross-owner session references before any read/write. */
  private getOwnedSessionId(sessionId: string | null | undefined, userId: string): string | null {
    if (!sessionId) return null;
    const session = this.db.getSession(sessionId);
    const sessionUserId = session?.metadata?.userId;
    if (typeof sessionUserId !== 'string') return null;
    return this.ownedIdentityCandidates(userId).has(sessionUserId) ? sessionId : null;
  }

  /**
   * Check if a similar message was sent to this user recently.
   */
  private isDuplicateSend(userId: string, message: string): boolean {
    const now = Date.now();
    const recent = this.recentSends.get(userId);
    if (!recent) return false;

    // Retain a longer style history than the hard semantic-dedup window. The
    // renderer needs to see yesterday's openings even though a legitimate
    // follow-up about the same topic may be allowed later.
    const history = recent.filter(r => now - r.time < PROACTIVE_STYLE_HISTORY_MS);
    if (history.length === 0) {
      this.recentSends.delete(userId);
    } else if (history.length !== recent.length) {
      this.recentSends.set(userId, history);
    }

    return history
      .filter(r => now - r.time < SEND_DEDUP_WINDOW_MS)
      .some(r => wordOverlap(r.message, message, { minWordLength: 2 }) >= SEND_DEDUP_THRESHOLD);
  }

  private getRecentMessagesForStyle(userId: string): string[] {
    const cutoff = Date.now() - PROACTIVE_STYLE_HISTORY_MS;
    return (this.recentSends.get(userId) ?? [])
      .filter(entry => entry.time >= cutoff)
      .slice(-8)
      .map(entry => entry.message);
  }

  /**
   * Record a message as sent for future dedup checks. Caps the per-user list
   * and the top-level user count to prevent unbounded growth. Also persists
   * to SQLite so the dedup state survives a restart.
   */
  private recordSend(
    userId: string,
    message: string,
    source: string = 'agent',
    persist: boolean = true,
  ): void {
    const now = Date.now();
    const list = this.recentSends.get(userId) || [];
    list.push({ message, time: now, source });
    // At three inferred sends/day, 60 entries comfortably covers the 14-day
    // style window while leaving headroom for task results.
    if (list.length > 60) list.splice(0, list.length - 60);
    this.recentSends.set(userId, list);

    // Persist for restart-time hydration. Best-effort: failure to persist
    // shouldn't block the send.
    if (persist) {
      try {
        this.db.recordProactiveSend(userId, message, source, now);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Failed to persist proactive send log entry');
      }
    }

    // Global cap: evict the oldest user entry (Map iteration order is
    // insertion order) if we've somehow accumulated too many.
    while (this.recentSends.size > UnifiedScheduler.MAX_RECENT_SEND_USERS) {
      const oldest = this.recentSends.keys().next().value;
      if (oldest === undefined) break;
      this.recentSends.delete(oldest);
    }
  }

  /**
   * Mark item as fired and reschedule if recurring
   */
  private markItemFiredAndReschedule(item: ScheduledItem, alreadyFired: boolean = false): void {
    if (!alreadyFired) this.db.markScheduledItemFired(item.id);
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
          messageProvenance: item.messageProvenance,
          kind: item.kind,
          type: item.type,
          message: item.message,
          context: item.context,
          triggerAt: nextTriggerAt,
          recurring: item.recurring,
          sourceMemoryId: item.sourceMemoryId,
          sourceItemId: item.sourceItemId,
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

    // Helper: build a UTC timestamp for a given date in the user's timezone.
    // Uses Intl.DateTimeFormat.formatToParts offset-diff pattern so it's
    // independent of the Node process's system timezone.
    const toUtc = (y: number, m: number, d: number, h: number, min: number): number => {
      const approxUtcMs = Date.UTC(y, m, d, h, min);
      const partsFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const p = partsFmt.formatToParts(new Date(approxUtcMs));
      const g = (t: string) => parseInt(p.find(x => x.type === t)?.value || '0', 10);
      const tzAsUtcMs = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
      const offsetMs = tzAsUtcMs - approxUtcMs;
      return approxUtcMs - offsetMs;
    };

    // Start from "today" in user timezone, at the scheduled time.
    // Use UTC date math so advance() doesn't depend on system TZ.
    let targetDay = userDay;
    let targetMonth = userMonth;
    let targetYear = userYear;
    const advance = () => {
      const d = new Date(Date.UTC(targetYear, targetMonth, targetDay + 1));
      targetDay = d.getUTCDate();
      targetMonth = d.getUTCMonth();
      targetYear = d.getUTCFullYear();
    };
    const getDow = () => new Date(Date.UTC(targetYear, targetMonth, targetDay)).getUTCDay();

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
  checkEngagement(
    userId: string,
    userMessage?: string,
    context: Omit<ProactiveEngagementContext, 'userMessage'> = {},
  ): ProactiveFeedbackResult {
    const feedbackResult: ProactiveFeedbackResult = { matched: false };
    try {
      const seen = new Set<string>();
      const identityCandidates = proactiveIdentityCandidates(userId, this.canonicalSingleUserIds);
      const items = identityCandidates
        .flatMap(identity => this.db.getScheduledItemsByUser(identity))
        .filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      let matches = attributeProactiveEngagement(userId, items, {
        ...context,
        userMessage,
        identityCandidates,
      });
      const exactReplyAction = (
        context.directReply
        && context.allowSourceAction !== false
        && typeof userMessage === 'string'
      ) ? parseProactiveReplyAction(userMessage) : null;
      const exactWrapper = exactReplyAction
        ? this.resolveExactReplyWrapper(userId, context, items)
        : null;
      if (exactWrapper && exactReplyAction) {
        // Exact channel provenance wins over fuzzy/newest text attribution.
        // This also prevents one reply from marking a similar newer wrapper as
        // acted when Telegram says the user replied to the earlier delivery.
        matches = [{
          itemId: exactWrapper.id,
          score: 2,
          reason: 'direct_reply',
          replyAction: exactReplyAction,
        }];
      }
      for (const match of matches) {
        feedbackResult.matched = true;
        const wrapper = items.find(item => item.id === match.itemId);
        let sourceAction: ProactiveFeedbackResult['sourceAction'] | null = null;
        let feedbackPersistedAtomically = false;
        if (
          wrapper
          && exactWrapper?.id === wrapper.id
          && match.reason === 'direct_reply'
          && match.replyAction
        ) {
          const sourceItemId = this.linkedSourceItemId(wrapper);
          if (sourceItemId) {
            const atomic = this.db.applyLinkedSourceReplyAndAcknowledge({
              wrapperId: wrapper.id,
              sourceItemId,
              ownerUserId: wrapper.userId,
              feedbackUserId: userId,
              action: match.replyAction.type,
              delayMs: match.replyAction.type === 'snooze' ? match.replyAction.delayMs : undefined,
              score: match.score,
            });
            feedbackPersistedAtomically = atomic.acknowledged;
            sourceAction = atomic.sourceAction;
          }
        }
        if (sourceAction) feedbackResult.sourceAction = sourceAction;
        if (!feedbackPersistedAtomically) {
          if (match.reason === 'negative') {
            this.db.markScheduledItemDismissed(match.itemId);
          } else {
            this.db.markScheduledItemActed(match.itemId);
          }
          this.db.recordProactiveDecision({
            userId,
            stage: 'feedback',
            outcome: match.reason === 'negative' ? 'dismissed' : 'acted',
            reason: match.reason,
            detail: {
              itemId: match.itemId,
              score: match.score,
              ...(match.replyAction
                ? { replyAction: match.replyAction.type, sourceActionApplied: sourceAction?.applied ?? false }
                : {}),
            },
          });
        }
      }
      if (matches.length > 0) {
        this.logger.debug(
          { userId, actedCount: matches.length, reason: matches[0].reason, score: matches[0].score },
          'Proactive engagement attributed',
        );
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message, userId }, 'Engagement detection failed');
    }
    return feedbackResult;
  }

  /**
   * Resolve source-action authority from append-only channel delivery
   * provenance. Text, recency, and newest-item fallback are intentionally not
   * consulted here: they remain engagement signals only.
   */
  private resolveExactReplyWrapper(
    feedbackUserId: string,
    context: Omit<ProactiveEngagementContext, 'userMessage'>,
    items: ScheduledItem[],
  ): ScheduledItem | null {
    const messageId = context.repliedToMessageId?.trim();
    const { channel } = parseUserIdPrefix(feedbackUserId);
    if (!context.directReply || !messageId || !channel) return null;

    const identities = new Set(
      proactiveIdentityCandidates(feedbackUserId, this.canonicalSingleUserIds),
    );
    const receipts = this.db.getProactiveDeliveryReceipts(channel, messageId)
      .filter(receipt => identities.has(receipt.ownerUserId));
    if (receipts.length === 0 || receipts.some(receipt => receipt.ambiguous)) return null;

    const wrapperIds = new Set(receipts.map(receipt => receipt.scheduledItemId));
    if (wrapperIds.size !== 1) return null;
    const [wrapperId] = wrapperIds;
    const wrapper = items.find(item => item.id === wrapperId);
    if (!wrapper || !identities.has(wrapper.userId)) return null;
    if (!receipts.some(receipt => (
      receipt.scheduledItemId === wrapper.id
      && receipt.ownerUserId === wrapper.userId
    ))) return null;

    if (
      wrapper.source !== 'agent'
      || !['processing', 'fired', 'acted'].includes(wrapper.status)
    ) return null;
    return wrapper;
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

    const deliverable = unnotified.flatMap((item) => {
      const result = item.result;
      if (!result) return [];
      const clean = sanitizeAgentResponse(result.response);
      return clean ? [{ item, result, clean }] : [];
    });
    const message = await renderCompletedWorkDigest(
      deliverable.map(entry => ({ title: entry.item.message, result: entry.clean })),
      this.router,
    );
    if (!message || !(await this.onSendMessage(userId, message))) return 0;

    const notifiedAt = Date.now();
    for (const entry of deliverable) {
      this.db.updateScheduledItemResult(entry.item.id, { ...entry.result, notifiedAt });
    }

    this.logger.info({ userId, count: deliverable.length }, 'Sent morning digest');
    return deliverable.length;
  }

  /**
   * Get the board service instance (for use by cognitive layer)
   */
  getBoardService(): BoardService {
    return this.boardService;
  }
}
