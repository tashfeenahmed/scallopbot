/**
 * Deep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import type { GardenerContext } from './gardener-context.js';
import {
  DEFAULT_USER_ID,
  hasExplicitSingleOwner,
  resolveSessionStateUserId,
  sessionBelongsToStateUser,
  stateIdentityCandidates,
} from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { getLastProactiveAt, createProactiveItem } from './gardener-scheduling.js';
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import { auditRetrievalHistory } from './retrieval-audit.js';
import { archiveLowUtilityMemories, pruneOrphanedRelations } from './utility-score.js';
import { computeTrustScore } from './trust-score.js';
import { checkGoalDeadlines } from './goal-deadline-check.js';
import {
  evaluateProactive,
  parseProactivePreferences,
  resolveProactiveDial,
} from './proactive-evaluator.js';
import { getTodayStartMs } from '../proactive/proactive-utils.js';
import { DEFAULT_QUIET_HOURS, DIAL_BUDGETS, PROACTIVE_COOLDOWN_MS } from '../proactive/proactive-config.js';
import { getRecentChatContext } from '../proactive/chat-context.js';
import { classifySessionMessage } from './session-message-view.js';

// ============ Step functions ============

/**
 * B1: Full decay scan (all memories) + utility-based archival.
 * Combines decay pass with low-utility archival into a single forgetting step.
 */
export function runFullDecay(ctx: GardenerContext): { updated: number; archived: number } {
  try {
    const result = ctx.scallopStore.processFullDecay();

    // Utility-based archival (previously substep B3b)
    let utilityArchived = 0;
    if (!ctx.disableArchival) {
      try {
        const archiveResult = archiveLowUtilityMemories(ctx.db, {
          utilityThreshold: 0.1,
          minAgeDays: 14,
          maxPerRun: 50,
        });
        utilityArchived = archiveResult.archived;
      } catch (err) {
        ctx.logger.warn({ error: (err as Error).message }, 'Utility-based archival failed');
      }
    }

    const totalArchived = result.archived + utilityArchived;
    if (result.updated > 0 || utilityArchived > 0) {
      ctx.logger.info({ updated: result.updated, archived: totalArchived }, 'Full decay processed');
    }
    return { updated: result.updated, archived: totalArchived };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Full decay failed');
    return { updated: 0, archived: 0 };
  }
}

/**
 * B1.5: Memory fusion (merge dormant related memory clusters)
 */
export async function runMemoryFusion(ctx: GardenerContext): Promise<{ totalFused: number; totalMerged: number }> {
  if (!ctx.fusionProvider) return { totalFused: 0, totalMerged: 0 };

  try {
    const userId = DEFAULT_USER_ID;
    let totalFused = 0;
    let totalMerged = 0;

    const allMemories = ctx.db.getMemoriesByUser(userId, {
      minProminence: 0.1,
      isLatest: true,
      includeAllSources: true,
    });
    const dormantMemories = allMemories.filter(m =>
      m.prominence < 0.7 &&
      m.memoryType !== 'static_profile' &&
      m.memoryType !== 'derived'
    );

    if (dormantMemories.length >= 2) {
      const clusters = findFusionClusters(
        dormantMemories,
        (id) => ctx.db.getRelations(id),
        { minClusterSize: 2, maxClusters: 5, maxProminence: 0.7 },
      );

      for (const cluster of clusters) {
        const result = await fuseMemoryCluster(cluster, ctx.fusionProvider);
        if (!result) continue;

        await storeFusedMemory({
          scallopStore: ctx.scallopStore,
          db: ctx.db,
          userId,
          summary: result.summary,
          category: result.category,
          importance: result.importance,
          confidence: result.confidence,
          sourceMemoryIds: cluster.map(m => m.id),
          sourceChunk: cluster.map(m => m.content).join(' | '),
          learnedFrom: 'consolidation',
          supersedeSources: true,
        }, allMemories);

        totalFused++;
        totalMerged += cluster.length;
      }
    }

    if (totalFused > 0) {
      ctx.logger.info({ fused: totalFused, memoriesMerged: totalMerged }, 'Memory fusion complete');
    }
    return { totalFused, totalMerged };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Memory fusion failed');
    return { totalFused: 0, totalMerged: 0 };
  }
}

/**
 * B2: Generate session summaries for old sessions before pruning
 */
export async function runSessionSummarization(ctx: GardenerContext): Promise<{ summarized: number }> {
  if (!ctx.sessionSummarizer) return { summarized: 0 };

  try {
    // Summarize sessions idle for 2+ hours (not 24h) so inner thoughts
    // gets input sooner and proactive follow-ups can be generated.
    const cutoffMs = 2 * 60 * 60 * 1000; // 2 hours
    const cutoff = Date.now() - cutoffMs;
    const oldSessions = ctx.db.raw<{ id: string; metadata: string | null }>(
      `SELECT s.id, s.metadata FROM sessions s
       WHERE s.updated_at < ?
         AND s.transcript_deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_summaries ss
           WHERE ss.session_id = s.id
             AND ss.schema_valid = 1
             AND ss.verified_at IS NOT NULL
             AND ss.verifier IS NOT NULL
             AND ss.verification_version >= 1
             AND EXISTS (
               SELECT 1 FROM session_summary_verification_events receipt
               WHERE receipt.summary_id = ss.id
                 AND receipt.outcome = 'verified'
                 AND receipt.verifier = ss.verifier
                 AND receipt.verification_version = ss.verification_version
             )
         )
       ORDER BY s.updated_at DESC
       LIMIT 20`,
      [cutoff]
    );
    const sessionsByUser = new Map<string, string[]>();
    for (const session of oldSessions) {
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed = session.metadata ? JSON.parse(session.metadata) as unknown : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch { /* malformed identity is ambiguous and must be skipped */ }
      const userId = resolveSessionStateUserId(metadata, ctx.canonicalSingleUserIds);
      if (!userId) continue;
      const ids = sessionsByUser.get(userId) ?? [];
      ids.push(session.id);
      sessionsByUser.set(userId, ids);
    }

    if (sessionsByUser.size > 0) {
      let summarized = 0;
      for (const [userId, sessionIds] of sessionsByUser) {
        summarized += await ctx.sessionSummarizer.summarizeBatch(ctx.db, sessionIds, userId);
      }
      if (summarized > 0) {
        ctx.logger.info(
          { summarized, eligible: [...sessionsByUser.values()].reduce((sum, ids) => sum + ids.length, 0), total: oldSessions.length },
          'Session summaries generated',
        );
      }
      return { summarized };
    }
    return { summarized: 0 };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Session summarization failed');
    return { summarized: 0 };
  }
}

/**
 * B3: Enhanced forgetting pipeline (audit + prune + orphan cleanup).
 * Utility-based archival (formerly 3b) is now handled by runFullDecay (B1).
 */
export async function runEnhancedForgetting(ctx: GardenerContext): Promise<void> {
  let auditNeverRetrieved = 0;
  let auditStaleRetrieved = 0;
  let auditCandidateCount = 0;
  let transcriptsPruned = 0;
  let memoriesDeleted = 0;
  let orphansDeleted = 0;

  // 3a. Retrieval audit — apply small prominence penalty to never/stale-retrieved active memories
  try {
    const auditResult = auditRetrievalHistory(ctx.db);
    auditNeverRetrieved = auditResult.neverRetrieved;
    auditStaleRetrieved = auditResult.staleRetrieved;
    auditCandidateCount = auditResult.candidatesForDecay.length;

    // Demote audit candidates: 5% prominence reduction per deep tick.
    // This nudges never/stale-retrieved active memories toward dormancy
    // so the system gradually forgets memories it never actually uses.
    if (auditResult.candidatesForDecay.length > 0) {
      const demotions: Array<{ id: string; prominence: number }> = [];
      for (const id of auditResult.candidatesForDecay) {
        const mem = ctx.db.getMemory(id);
        if (mem && mem.prominence > 0.1) {
          demotions.push({ id, prominence: mem.prominence * 0.95 });
        }
      }
      if (demotions.length > 0) {
        ctx.db.updateProminences(demotions);
        ctx.logger.debug({ demoted: demotions.length }, 'Audit candidates demoted');
      }
    }
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Retrieval audit failed');
  }

  // 3c. Hard prune truly dead memories
  if (!ctx.disableArchival) {
    try {
      // Historical DB method name retained for compatibility. It now prunes
      // only raw transcripts from already-archived sessions with a verified
      // summary; active and unsummarized conversations are never touched.
      transcriptsPruned = ctx.db.pruneOldSessions(30);
      memoriesDeleted = ctx.db.pruneArchivedMemories(0.01);
    } catch (err) {
      ctx.logger.warn({ error: (err as Error).message }, 'Hard pruning failed');
    }
  }

  // 3d. Prune orphaned relation edges
  try {
    orphansDeleted = pruneOrphanedRelations(ctx.db);
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Orphan relation pruning failed');
  }

  ctx.logger.info(
    {
      auditNeverRetrieved,
      auditStaleRetrieved,
      auditCandidateCount,
      memoriesDeleted,
      transcriptsPruned,
      orphansDeleted,
    },
    'Enhanced forgetting complete'
  );
}

/**
 * B4: Behavioral pattern inference
 */
export function runBehavioralInference(ctx: GardenerContext): { messageCount: number } {
  try {
    const profileManager = ctx.scallopStore.getProfileManager();
    let totalMessages = 0;

    const recentSessions = ctx.db.listSessions(5);
    const sessionsByUser = new Map<string, typeof recentSessions>();
    for (const session of recentSessions) {
      const userId = resolveSessionStateUserId(session.metadata, ctx.canonicalSingleUserIds);
      if (!userId) continue;
      const sessions = sessionsByUser.get(userId) ?? [];
      sessions.push(session);
      sessionsByUser.set(userId, sessions);
    }

    for (const [userId, sessionsForUser] of sessionsByUser) {
      const allMessages: Array<{ content: string; timestamp: number }> = [];
      const behavioralSessions: Array<{ messageCount: number; durationMs: number; startTime: number }> = [];
      for (const session of sessionsForUser) {
        const messages = ctx.db.getSessionMessages(session.id);
        const visibleMessages = messages
          .map(message => ({ message, view: classifySessionMessage(message, { sessionMetadata: session.metadata }) }))
          .filter(({ view }) => view.isHumanVisible);
        for (const msg of messages) {
          const view = classifySessionMessage(msg, { sessionMetadata: session.metadata });
          if (view.isHumanTurn && view.visibleText) {
            allMessages.push({ content: view.visibleText, timestamp: msg.createdAt });
          }
        }
        if (visibleMessages.length > 0) {
          behavioralSessions.push({
            messageCount: visibleMessages.length,
            durationMs: visibleMessages[visibleMessages.length - 1].message.createdAt
              - visibleMessages[0].message.createdAt,
            startTime: visibleMessages[0].message.createdAt,
          });
        }
      }
      if (allMessages.length === 0) continue;

      const userMemories = ctx.db.getMemoriesByUser(userId, { isLatest: true, limit: 100 });
      const messageEmbeddings = userMemories
        .filter(m => m.embedding != null
          && m.source !== 'assistant'
          && m.memoryType !== 'derived'
          && m.learnedFrom !== 'self_reflection')
        .map(m => ({
          content: m.content,
          embedding: m.embedding!,
        }));

      profileManager.inferBehavioralPatterns(userId, allMessages, {
        sessions: behavioralSessions.length > 0 ? behavioralSessions : undefined,
        messageEmbeddings: messageEmbeddings.length > 0 ? messageEmbeddings : undefined,
      });
      ctx.logger.debug({ userId, messageCount: allMessages.length }, 'Behavioral patterns updated');
      totalMessages += allMessages.length;
    }
    return { messageCount: totalMessages };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Behavioral inference failed');
    return { messageCount: 0 };
  }
}

/**
 * B5: Trust score update
 */
export function runTrustScoreUpdate(ctx: GardenerContext): void {
  try {
    const profileManager = ctx.scallopStore.getProfileManager();
    const userId = DEFAULT_USER_ID;

    const sessionSummaries = ctx.db.getSessionSummariesByUser(userId, 30);
    const sessions = sessionSummaries
      .filter(s => s.messageCount > 0)
      .map(s => ({ messageCount: s.messageCount, durationMs: s.durationMs, startTime: s.createdAt }));

    const rawScheduledItems = ctx.db.getScheduledItemsByUser(userId);
    const scheduledItems = rawScheduledItems
      // Trust calibration is about inferred conversational nudges. Background
      // task completion/suppression is a different product and must not train
      // the outreach dial.
      .filter(i => i.source === 'agent' && i.kind === 'nudge' && i.status !== 'expired')
      .map(i => ({ status: i.status as 'pending' | 'fired' | 'acted' | 'dismissed', source: i.source, firedAt: i.firedAt ?? undefined }));
    const existingPatterns = profileManager.getBehavioralPatterns(userId);
    const existingTrust = existingPatterns?.responsePreferences?.trustScore as number | undefined;
    const trustResult = computeTrustScore(sessions, scheduledItems, { existingScore: existingTrust });
    if (trustResult) {
      profileManager.updateBehavioralPatterns(userId, {
        responsePreferences: {
          ...(existingPatterns?.responsePreferences ?? {}),
          trustScore: trustResult.trustScore,
          proactivenessDial: trustResult.proactivenessDial,
        },
      });
      ctx.logger.debug({ userId, trustScore: trustResult.trustScore, dial: trustResult.proactivenessDial }, 'Trust score updated');
    }
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Trust score update failed');
  }
}

/**
 * B6: Goal deadline check
 */
export async function runGoalDeadlineCheck(ctx: GardenerContext): Promise<void> {
  try {
    const GoalService = (await import('../goals/goal-service.js')).GoalService;
    const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
    const userId = DEFAULT_USER_ID;

    const activeGoals = await goalService.listGoals(userId, { status: 'active' });
    const goalsWithDueDates = activeGoals.filter(g => g.metadata.dueDate != null);
    if (goalsWithDueDates.length > 0) {
      // Include historical deliveries, not only currently pending rows. Each
      // deadline stage (warning -> urgent -> overdue) may notify once per due
      // date; a fired warning must not be recreated every deep tick.
      const existingReminders = ctx.db.getScheduledItemsByUser(userId)
        // Only an outstanding candidate or a reminder that actually reached
        // the user may consume a deadline stage. Expired/suppressed rows are
        // failed attempts and must not permanently silence that stage.
        .filter(item => ['pending', 'processing', 'fired', 'acted', 'dismissed'].includes(item.status))
        .map(item => {
          let detail: Record<string, unknown> = {};
          try { detail = item.context ? JSON.parse(item.context) as Record<string, unknown> : {}; } catch { /* legacy */ }
          const stage = detail.deadlineStage;
          const urgency: 'warning' | 'urgent' | 'overdue' | undefined =
            stage === 'warning' || stage === 'urgent' || stage === 'overdue' ? stage : undefined;
          return {
            message: item.message,
            goalId: item.sourceMemoryId,
            dueDate: typeof detail.dueDate === 'number' ? detail.dueDate : undefined,
            urgency,
          };
        });
      const deadlineResult = checkGoalDeadlines(goalsWithDueDates, existingReminders);
      for (const notification of deadlineResult.notifications) {
        createProactiveItem({
          db: ctx.db,
          userId: notification.userId,
          message: notification.message,
          context: JSON.stringify({
            proactiveKind: 'goal_deadline',
            goalId: notification.goalId,
            dueDate: notification.dueDate,
            deadlineStage: notification.urgency,
          }),
          type: 'goal_checkin',
          kind: 'nudge',
          quietHours: DEFAULT_QUIET_HOURS,
          activeHours: [],
          lastProactiveAt: null,
          urgency: notification.urgency === 'warning' ? 'medium' : 'high',
          sourceMemoryId: notification.goalId,
          timezone: ctx.getTimezone?.(notification.userId),
        });
      }
      if (deadlineResult.approaching.length > 0) {
        ctx.logger.info({ userId, approaching: deadlineResult.approaching.length, notifications: deadlineResult.notifications.length }, 'Goal deadline check complete');
      }
    }
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Goal deadline check failed');
  }
}

/**
 * B7: Unified proactive evaluation (session context + system gaps in one LLM call).
 * Replaces the previous two-path approach (inner-thoughts + gap-scanner).
 */
export async function runInnerThoughts(ctx: GardenerContext): Promise<void> {
  if (!ctx.fusionProvider || !hasExplicitSingleOwner(ctx)) return;

  try {
    const userId = DEFAULT_USER_ID;
    // Context older than this can inform historical comparison but must not be
    // treated as the current state or used as a fallback trigger.
    const SESSION_CONTEXT_WINDOW_MS = 48 * 60 * 60 * 1000;
    const contextCutoff = Date.now() - SESSION_CONTEXT_WINDOW_MS;

    const allSummaries = ctx.db.getSessionSummariesByUser(userId, 20)
      .filter(summary => sessionBelongsToStateUser(
        ctx.db,
        summary.sessionId,
        userId,
        ctx.canonicalSingleUserIds,
      ));
    const recentSummaries = allSummaries.filter(s => s.createdAt >= contextCutoff);
    const sessionSummary = recentSummaries.length > 0
      ? recentSummaries[0]
      : null;

    const behavioralPatterns = ctx.db.getBehavioralPatterns(userId);
    const affect = behavioralPatterns?.smoothedAffect ?? null;
    const storedDial = (behavioralPatterns?.responsePreferences?.proactivenessDial as 'conservative' | 'moderate' | 'eager') ?? 'moderate';
    const activeHours = behavioralPatterns?.activeHours ?? [];
    const lastProactiveAt = getLastProactiveAt(ctx.db, userId);

    // Load goals and board items for gap scanning
    const GoalService = (await import('../goals/goal-service.js')).GoalService;
    const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
    const activeGoals = await goalService.listGoals(userId, { status: 'active' });

    const existingItems = ctx.db.getScheduledItemsByUser(userId);
    const boardItems = existingItems
      // The canonical lifecycle state is authoritative. Never infer live work
      // from a stale/contradictory board column on a terminal historical row.
      .filter(i => (i.status === 'pending' || i.status === 'processing')
        && (i.boardStatus === 'in_progress' || i.boardStatus === 'waiting'))
      .map(i => ({
        id: i.id,
        title: i.message,
        status: i.status,
        boardStatus: i.boardStatus!,
        updatedAt: i.updatedAt,
        priority: i.priority,
      }));

    // Count today's items for budget
    const tz = ctx.getTimezone?.(userId) ?? 'UTC';
    const todayStart = getTodayStartMs(tz);
    const todayItemCount = ctx.db.getRecentProactiveSends(todayStart)
      .filter(send => send.userId === userId && send.source === 'agent')
      .length;

    const pendingItems = existingItems
      .filter(i => i.status === 'pending' || (i.status === 'fired' && (i.firedAt ?? 0) >= Date.now() - 14 * 24 * 60 * 60 * 1000))
      .map(i => ({ message: i.message, context: i.context }));

    // Interpret user-stated outreach preferences deterministically. This
    // avoids treating a negated preference ("don't remind me") as enthusiasm
    // merely because it contains the word "remind".
    const preferenceProfile = parseProactivePreferences(ctx.db
      .getMemoriesByUser(userId, { limit: 100 })
      .map(m => m.content));
    const userPreferences = [...new Set(preferenceProfile.rules.map(rule => rule.text))].slice(0, 10);

    // Explicit positive preferences may elevate the dial, but any negative or
    // limiting rule wins and prevents that automatic elevation. A global
    // opt-out is enforced again inside shouldEvaluate() before any LLM call.
    const dial = resolveProactiveDial(storedDial, preferenceProfile);

    // Always anchor the cache to the evaluation that actually called the LLM
    // (or created work), never to a later cache-hit diagnostic. Otherwise each
    // `unchanged_signals` row refreshes the timestamp and the cache never
    // expires for a long-lived signal.
    const priorEvaluationDecision = ctx.db.getLatestProactiveEvaluationAnchor(userId);

    const result = await evaluateProactive({
      sessionSummary,
      behavioralPatterns,
      activeGoals,
      boardItems,
      allSessionSummaries: allSummaries,
      existingItems: pendingItems,
      dial,
      affect,
      lastProactiveAt,
      activeHours,
      userId,
      circuitStore: ctx.db,
      todayItemCount,
      userPreferences,
      recentChatContext: getRecentChatContext(ctx.db, userId, {
        maxMessages: 12,
        maxCharsPerMessage: 300,
        stalenessMs: SESSION_CONTEXT_WINDOW_MS,
        identityCandidates: stateIdentityCandidates(userId, ctx.canonicalSingleUserIds),
      })?.formattedContext,
      ...(priorEvaluationDecision
        ? {
            priorEvaluation: {
              signalFingerprint: priorEvaluationDecision.detail!.signalFingerprint as string,
              at: priorEvaluationDecision.at,
              reason: priorEvaluationDecision.reason,
              outcome: priorEvaluationDecision.outcome,
            },
          }
        : {}),
    }, ctx.fusionProvider);

    // Schedule each output item
    for (const item of result.items) {
      const timingUrgency: 'low' | 'medium' | 'high' =
        item.severity === 'high' ? 'high' :
        item.severity === 'medium' ? 'medium' : 'low';

      let sourceSessionId: string | null = null;
      try {
        const itemContext = JSON.parse(item.context) as Record<string, unknown>;
        if (typeof itemContext.sourceSessionId === 'string') sourceSessionId = itemContext.sourceSessionId;
      } catch { /* context was already safety-checked by the evaluator */ }
      if (sourceSessionId && !sessionBelongsToStateUser(
        ctx.db,
        sourceSessionId,
        userId,
        ctx.canonicalSingleUserIds,
      )) {
        ctx.db.recordProactiveDecision({
          userId,
          stage: 'create',
          outcome: 'suppressed',
          reason: 'source_session_owner_mismatch',
          detail: { gapType: item.gapType },
        });
        continue;
      }

      const proResult = createProactiveItem({
        db: ctx.db,
        userId,
        sessionId: sourceSessionId,
        message: item.message,
        context: item.context,
        type: 'follow_up',
        kind: 'nudge',
        quietHours: DEFAULT_QUIET_HOURS,
        activeHours,
        lastProactiveAt,
        urgency: timingUrgency,
        timezone: ctx.getTimezone?.(userId),
      });

      if (proResult.created) {
        ctx.logger.info({ userId, urgency: timingUrgency, gapType: item.gapType }, 'Proactive evaluator created item');
      } else {
        // Item generated but a near-identical one was already pending.
        ctx.db.recordProactiveDecision({
          userId,
          stage: 'create',
          outcome: 'deduped',
          reason: 'pre_create_dedup',
          detail: { gapType: item.gapType, message: item.message.slice(0, 120) },
        });
      }
    }

    if (result.items.length > 0 || result.signalsFound > 0) {
      ctx.logger.info({
        userId,
        signalsFound: result.signalsFound,
        itemsCreated: result.items.length,
        llmCalled: result.llmCalled,
        skipReason: result.skipReason,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.unparsedResponseLength !== undefined
          ? { unparsedResponseLength: result.unparsedResponseLength }
          : {}),
      }, 'Proactive evaluation complete');
    }

    // Observability: record the evaluation outcome so `why-no-proact` can
    // explain exactly which gate fired (cooldown / budget / no-signals / the
    // LLM skipping everything) instead of failing silently.
    const evalNow = Date.now();
    const reason = result.skipReason
      ?? (result.items.length === 0 && result.llmCalled ? 'llm_skipped_all' : undefined);
    ctx.db.recordProactiveDecision({
      userId,
      at: evalNow,
      stage: 'evaluate',
      outcome: result.items.length > 0 ? 'created' : 'skipped',
      reason,
      detail: {
        dial,
        signalsFound: result.signalsFound,
        itemsCreated: result.items.length,
        llmCalled: result.llmCalled,
        todayItemCount,
        budgetCap: DIAL_BUDGETS[dial],
        lastProactiveAt,
        signalFingerprint: result.signalFingerprint,
        ...(result.skipReason === 'cooldown' && lastProactiveAt
          ? { cooldownRemainingMs: Math.max(0, PROACTIVE_COOLDOWN_MS - (evalNow - lastProactiveAt)) }
          : {}),
      },
    });
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Proactive evaluation failed');
  }
}

/**
 * B8: Clean up old sub-agent runs and their sessions
 */
export function runSubAgentCleanup(ctx: GardenerContext, cleanupAfterSeconds?: number): void {
  try {
    const maxAgeMs = (cleanupAfterSeconds ?? ctx.subAgentCleanupAfterSeconds ?? 3600) * 1000;
    const ledgerMaxAgeMs = Math.max(
      maxAgeMs,
      (ctx.subAgentDiagnosticRetentionSeconds ?? 30 * 24 * 60 * 60) * 1000,
    );

    // Get child session IDs of old sub-agent runs before deleting
    const childSessionIds = ctx.db.getSubAgentChildSessionIds(maxAgeMs);

    // Erase bulky/private payloads at the short protocol cutoff while keeping
    // a compact redacted ledger for diagnostics.
    const runsCompacted = ctx.db.compactOldSubAgentRuns(maxAgeMs);

    // Delete only the compact ledger after the longer retention window.
    const runsDeleted = ctx.db.deleteOldSubAgentRuns(ledgerMaxAgeMs);

    // Delete their sessions and messages
    let sessionsDeleted = 0;
    for (const sessionId of childSessionIds) {
      try {
        ctx.db.deleteSession(sessionId, 'subagent_cleanup', 'gardener');
        sessionsDeleted++;
      } catch {
        // Session may already be deleted
      }
    }

    // Clean up stale session references in scheduled items
    let staleSessionsCleaned = 0;
    try {
      staleSessionsCleaned = ctx.db.cleanStaleScheduledItemSessions();
    } catch {
      // Non-critical — log and continue
    }

    if (runsCompacted > 0 || runsDeleted > 0 || sessionsDeleted > 0 || staleSessionsCleaned > 0) {
      ctx.logger.info(
        { runsCompacted, runsDeleted, sessionsDeleted, staleSessionsCleaned },
        'Sub-agent cleanup complete'
      );
    }

  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Sub-agent cleanup failed');
  }
}
