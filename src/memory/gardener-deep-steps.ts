/**
 * Deep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import type { GardenerContext } from './gardener-context.js';
import { safeBehavioralPatterns } from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import { auditRetrievalHistory } from './retrieval-audit.js';
import { archiveLowUtilityMemories, pruneOrphanedRelations } from './utility-score.js';
import { computeTrustScore } from './trust-score.js';
import { checkGoalDeadlines } from './goal-deadline-check.js';
import { evaluateInnerThoughts } from './inner-thoughts.js';
import { scanForGaps } from './gap-scanner.js';

// ============ Result types ============

export interface FullDecayResult {
  updated: number;
  archived: number;
}

export interface FusionStepResult {
  totalFused: number;
  totalMerged: number;
}

export interface SessionSummarizationResult {
  summarized: number;
}

export interface ForgettingResult {
  auditNeverRetrieved: number;
  auditStaleRetrieved: number;
  auditCandidateCount: number;
  archived: number;
  memoriesDeleted: number;
  sessionsDeleted: number;
  orphansDeleted: number;
}

export interface BehavioralInferenceResult {
  messageCount: number;
}

export interface TrustScoreStepResult {
  trustScore?: number;
  proactivenessDial?: string;
}

export interface GoalDeadlineStepResult {
  approaching: number;
  notifications: number;
}

export interface InnerThoughtsStepResult {
  proactiveItemsCreated: number;
}

// ============ Step functions ============

/**
 * B1: Full decay scan (all memories)
 */
export function runFullDecay(ctx: GardenerContext): FullDecayResult {
  const result = ctx.scallopStore.processFullDecay();
  if (result.updated > 0) {
    ctx.logger.info({ updated: result.updated, archived: result.archived }, 'Full decay processed');
  }
  return result;
}

/**
 * B1.5: Memory fusion (merge dormant related memory clusters)
 */
export async function runMemoryFusion(ctx: GardenerContext): Promise<FusionStepResult> {
  if (!ctx.fusionProvider) return { totalFused: 0, totalMerged: 0 };

  try {
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let totalFused = 0;
    let totalMerged = 0;

    for (const { user_id: userId } of userRows) {
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

      if (dormantMemories.length < 2) continue;

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
export async function runSessionSummarization(ctx: GardenerContext): Promise<SessionSummarizationResult> {
  if (!ctx.sessionSummarizer) return { summarized: 0 };

  try {
    const cutoffDays = 1;
    const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
    const oldSessions = ctx.db.raw<{ id: string; metadata: string | null }>(
      'SELECT id, metadata FROM sessions WHERE updated_at < ? LIMIT 20',
      [cutoff]
    );
    if (oldSessions.length > 0) {
      // Resolve userId from session metadata (falls back to first known user)
      let resolvedUserId = 'default';
      for (const s of oldSessions) {
        if (s.metadata) {
          try {
            const meta = JSON.parse(s.metadata);
            if (meta.userId) { resolvedUserId = meta.userId; break; }
          } catch { /* ignore */ }
        }
      }
      if (resolvedUserId === 'default') {
        const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\' LIMIT 1', []);
        if (userRows.length > 0) resolvedUserId = userRows[0].user_id;
      }
      const summarized = await ctx.sessionSummarizer.summarizeBatch(
        ctx.db,
        oldSessions.map(s => s.id),
        resolvedUserId
      );
      if (summarized > 0) {
        ctx.logger.info({ summarized, total: oldSessions.length }, 'Session summaries generated');
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
 * B3: Enhanced forgetting pipeline (audit + archival + prune + orphan cleanup)
 */
export async function runEnhancedForgetting(ctx: GardenerContext): Promise<ForgettingResult> {
  let auditNeverRetrieved = 0;
  let auditStaleRetrieved = 0;
  let auditCandidateCount = 0;
  let archiveCount = 0;
  let sessionsDeleted = 0;
  let memoriesDeleted = 0;
  let orphansDeleted = 0;

  // 3a. Retrieval audit
  try {
    const auditResult = auditRetrievalHistory(ctx.db);
    auditNeverRetrieved = auditResult.neverRetrieved;
    auditStaleRetrieved = auditResult.staleRetrieved;
    auditCandidateCount = auditResult.candidatesForDecay.length;
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Retrieval audit failed');
  }

  // 3b. Utility-based archival
  if (!ctx.disableArchival) {
    try {
      const archiveResult = archiveLowUtilityMemories(ctx.db, {
        utilityThreshold: 0.1,
        minAgeDays: 14,
        maxPerRun: 50,
      });
      archiveCount = archiveResult.archived;
    } catch (err) {
      ctx.logger.warn({ error: (err as Error).message }, 'Utility-based archival failed');
    }
  }

  // 3c. Hard prune truly dead memories
  if (!ctx.disableArchival) {
    try {
      sessionsDeleted = ctx.db.pruneOldSessions(30);
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
      archived: archiveCount,
      memoriesDeleted,
      sessionsDeleted,
      orphansDeleted,
    },
    'Enhanced forgetting complete'
  );

  return {
    auditNeverRetrieved,
    auditStaleRetrieved,
    auditCandidateCount,
    archived: archiveCount,
    memoriesDeleted,
    sessionsDeleted,
    orphansDeleted,
  };
}

/**
 * B4: Behavioral pattern inference
 */
export function runBehavioralInference(ctx: GardenerContext): BehavioralInferenceResult {
  try {
    const profileManager = ctx.scallopStore.getProfileManager();
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let totalMessages = 0;

    for (const { user_id: userId } of userRows) {
      const recentSessions = ctx.db.listSessions(5);
      const allMessages: Array<{ content: string; timestamp: number }> = [];
      for (const session of recentSessions) {
        const messages = ctx.db.getSessionMessages(session.id);
        for (const msg of messages) {
          if (msg.role === 'user') {
            allMessages.push({ content: msg.content, timestamp: msg.createdAt });
          }
        }
      }
      if (allMessages.length > 0) {
        const sessionSummaries = ctx.db.getSessionSummariesByUser(userId, 20);
        const sessions = sessionSummaries
          .filter(s => s.messageCount > 0)
          .map(s => ({
            messageCount: s.messageCount,
            durationMs: s.durationMs,
            startTime: s.createdAt,
          }));

        const userMemories = ctx.db.getMemoriesByUser(userId, { isLatest: true, limit: 100 });
        const messageEmbeddings = userMemories
          .filter(m => m.embedding != null)
          .map(m => ({
            content: m.content,
            embedding: m.embedding!,
          }));

        profileManager.inferBehavioralPatterns(userId, allMessages, {
          sessions: sessions.length > 0 ? sessions : undefined,
          messageEmbeddings: messageEmbeddings.length > 0 ? messageEmbeddings : undefined,
        });
        ctx.logger.debug({ userId, messageCount: allMessages.length }, 'Behavioral patterns updated');
        totalMessages += allMessages.length;
      }
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
export function runTrustScoreUpdate(ctx: GardenerContext): TrustScoreStepResult {
  try {
    const profileManager = ctx.scallopStore.getProfileManager();
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let lastResult: TrustScoreStepResult = {};

    for (const { user_id: userId } of userRows) {
      const sessionSummaries = ctx.db.getSessionSummariesByUser(userId, 30);
      let sessions = sessionSummaries
        .filter(s => s.messageCount > 0)
        .map(s => ({ messageCount: s.messageCount, durationMs: s.durationMs, startTime: s.createdAt }));

      // Fallback: if fewer than 5 session summaries, use raw sessions
      if (sessions.length < 5) {
        const rawSessions = ctx.db.listSessions(30);
        const fallbackSessions = rawSessions.map(s => {
          const msgs = ctx.db.getSessionMessages(s.id);
          return {
            messageCount: msgs.length,
            durationMs: s.updatedAt - s.createdAt,
            startTime: s.createdAt,
          };
        }).filter(s => s.messageCount > 0);
        if (fallbackSessions.length > sessions.length) {
          sessions = fallbackSessions;
        }
      }

      const rawScheduledItems = ctx.db.getScheduledItemsByUser(userId);
      const scheduledItems = rawScheduledItems
        .filter(i => i.status !== 'expired')
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
        lastResult = { trustScore: trustResult.trustScore, proactivenessDial: trustResult.proactivenessDial };
      }
    }
    return lastResult;
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Trust score update failed');
    return {};
  }
}

/**
 * B6: Goal deadline check
 */
export async function runGoalDeadlineCheck(ctx: GardenerContext): Promise<GoalDeadlineStepResult> {
  try {
    const GoalService = (await import('../goals/goal-service.js')).GoalService;
    const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let totalApproaching = 0;
    let totalNotifications = 0;

    for (const { user_id: userId } of userRows) {
      const activeGoals = await goalService.listGoals(userId, { status: 'active' });
      const goalsWithDueDates = activeGoals.filter(g => g.metadata.dueDate != null);
      if (goalsWithDueDates.length > 0) {
        const pendingItems = ctx.db.getDueScheduledItems(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const existingReminders = pendingItems.map(item => ({ message: item.message }));
        const deadlineResult = checkGoalDeadlines(goalsWithDueDates, existingReminders);
        for (const notification of deadlineResult.notifications) {
          if (!ctx.db.hasSimilarPendingScheduledItem(notification.userId, notification.message)) {
            ctx.db.addScheduledItem({
              userId: notification.userId,
              message: notification.message,
              triggerAt: Date.now(),
              source: 'agent',
              type: 'goal_checkin',
              sessionId: null,
              context: null,
              recurring: null,
              sourceMemoryId: notification.goalId,
            });
          }
        }
        if (deadlineResult.approaching.length > 0) {
          ctx.logger.info({ userId, approaching: deadlineResult.approaching.length, notifications: deadlineResult.notifications.length }, 'Goal deadline check complete');
        }
        totalApproaching += deadlineResult.approaching.length;
        totalNotifications += deadlineResult.notifications.length;
      }
    }
    return { approaching: totalApproaching, notifications: totalNotifications };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Goal deadline check failed');
    return { approaching: 0, notifications: 0 };
  }
}

/**
 * B7: Inner thoughts evaluation (for users with recent session summaries)
 */
export async function runInnerThoughts(ctx: GardenerContext): Promise<InnerThoughtsStepResult> {
  if (!ctx.fusionProvider) return { proactiveItemsCreated: 0 };

  try {
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM session_summaries', []);
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    let proactiveItemsCreated = 0;

    for (const { user_id: userId } of userRows) {
      try {
        const allSummaries = ctx.db.getSessionSummariesByUser(userId, 10);
        const recentSummaries = allSummaries.filter(s => s.createdAt >= sixHoursAgo);

        if (recentSummaries.length === 0) continue;

        const sessionSummary = recentSummaries[0];

        const behavioralPatterns = ctx.db.getBehavioralPatterns(userId);
        const affect = behavioralPatterns?.smoothedAffect ?? null;
        const dial = (behavioralPatterns?.responsePreferences?.proactivenessDial as 'conservative' | 'moderate' | 'eager') ?? 'moderate';
        const activeHours = behavioralPatterns?.activeHours ?? [];

        const lastProactiveAt = getLastProactiveAt(ctx.db, userId);

        // Get recent gap signals
        const GoalService = (await import('../goals/goal-service.js')).GoalService;
        const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
        const activeGoals = await goalService.listGoals(userId, { status: 'active' });
        const safeBehavioral = behavioralPatterns ?? safeBehavioralPatterns(userId);
        const gapSignals = scanForGaps({
          activeGoals,
          behavioralSignals: safeBehavioral,
          sessionSummaries: allSummaries,
        });

        const result = await evaluateInnerThoughts({
          sessionSummary,
          recentGapSignals: gapSignals,
          affect,
          dial,
          lastProactiveAt,
          activeHours,
        }, ctx.fusionProvider);

        if (result.decision === 'proact' && result.message) {
          if (ctx.db.hasSimilarPendingScheduledItem(userId, result.message)) {
            ctx.logger.debug({ userId }, 'Skipping inner thoughts item - similar already pending');
            continue;
          }

          scheduleProactiveItem({
            db: ctx.db,
            userId,
            message: result.message,
            context: JSON.stringify({
              source: 'inner_thoughts',
              reason: result.reason,
              urgency: result.urgency,
              gapSourceIds: gapSignals.map(s => s.sourceId),
            }),
            type: 'follow_up',
            quietHours: ctx.quietHours,
            activeHours,
            lastProactiveAt,
            urgency: result.urgency,
          });

          ctx.logger.info({ userId, urgency: result.urgency, reason: result.reason }, 'Inner thoughts created proactive item');
          proactiveItemsCreated++;
        }
      } catch (err) {
        ctx.logger.warn({ error: (err as Error).message, userId }, 'Inner thoughts failed for user');
      }
    }
    return { proactiveItemsCreated };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Inner thoughts phase failed');
    return { proactiveItemsCreated: 0 };
  }
}
