/**
 * Deep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import type { GardenerContext } from './gardener-context.js';
import { DEFAULT_USER_ID } from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import { auditRetrievalHistory } from './retrieval-audit.js';
import { archiveLowUtilityMemories, pruneOrphanedRelations } from './utility-score.js';
import { computeTrustScore } from './trust-score.js';
import { checkGoalDeadlines } from './goal-deadline-check.js';
import { evaluateInnerThoughts } from './inner-thoughts.js';

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
  try {
    const result = ctx.scallopStore.processFullDecay();
    if (result.updated > 0) {
      ctx.logger.info({ updated: result.updated, archived: result.archived }, 'Full decay processed');
    }
    return result;
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Full decay failed');
    return { updated: 0, archived: 0 };
  }
}

/**
 * B1.5: Memory fusion (merge dormant related memory clusters)
 */
export async function runMemoryFusion(ctx: GardenerContext): Promise<FusionStepResult> {
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
export async function runSessionSummarization(ctx: GardenerContext): Promise<SessionSummarizationResult> {
  if (!ctx.sessionSummarizer) return { summarized: 0 };

  try {
    const cutoffDays = 1;
    const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
    const oldSessions = ctx.db.raw<{ id: string; metadata: string | null }>(
      'SELECT id, metadata FROM sessions WHERE updated_at < ? LIMIT 20',
      [cutoff]
    ).filter(s => {
      // Skip sub-agent sessions — transient, results already in parent
      if (s.metadata) {
        try {
          const meta = JSON.parse(s.metadata);
          if (meta.isSubAgent) return false;
        } catch { /* ignore */ }
      }
      return true;
    });
    if (oldSessions.length > 0) {
      const resolvedUserId = DEFAULT_USER_ID;
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
    const userId = DEFAULT_USER_ID;
    let totalMessages = 0;

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
    const userId = DEFAULT_USER_ID;

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
      return { trustScore: trustResult.trustScore, proactivenessDial: trustResult.proactivenessDial };
    }
    return {};
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
    const userId = DEFAULT_USER_ID;
    let totalApproaching = 0;
    let totalNotifications = 0;

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
            kind: 'nudge',
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
    const userId = DEFAULT_USER_ID;
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    let proactiveItemsCreated = 0;

    try {
      const allSummaries = ctx.db.getSessionSummariesByUser(userId, 10);
      const recentSummaries = allSummaries.filter(s => s.createdAt >= sixHoursAgo);

      if (recentSummaries.length > 0) {
        const sessionSummary = recentSummaries[0];

        const behavioralPatterns = ctx.db.getBehavioralPatterns(userId);
        const affect = behavioralPatterns?.smoothedAffect ?? null;
        const dial = (behavioralPatterns?.responsePreferences?.proactivenessDial as 'conservative' | 'moderate' | 'eager') ?? 'moderate';
        const activeHours = behavioralPatterns?.activeHours ?? [];

        const lastProactiveAt = getLastProactiveAt(ctx.db, userId);

        // Gap scanning removed — C3 (sleep tick gap pipeline) handles all
        // gap-based proactive outreach. B7 focuses purely on session context:
        // "does this specific session warrant follow-up?"
        const result = await evaluateInnerThoughts({
          sessionSummary,
          recentGapSignals: [],
          affect,
          dial,
          lastProactiveAt,
          activeHours,
        }, ctx.fusionProvider);

        if (result.decision === 'proact' && result.message) {
          if (!ctx.db.hasSimilarPendingScheduledItem(userId, result.message)) {
            scheduleProactiveItem({
              db: ctx.db,
              userId,
              message: result.message,
              context: JSON.stringify({
                source: 'inner_thoughts',
                reason: result.reason,
                urgency: result.urgency,
              }),
              type: 'follow_up',
              kind: 'nudge',
              quietHours: ctx.quietHours,
              activeHours,
              lastProactiveAt,
              urgency: result.urgency,
              timezone: ctx.getTimezone?.(userId),
            });

            ctx.logger.info({ userId, urgency: result.urgency, reason: result.reason }, 'Inner thoughts created proactive item');
            proactiveItemsCreated++;
          } else {
            ctx.logger.debug({ userId }, 'Skipping inner thoughts item - similar already pending');
          }
        }
      }
    } catch (err) {
      ctx.logger.warn({ error: (err as Error).message, userId }, 'Inner thoughts failed for user');
    }
    return { proactiveItemsCreated };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Inner thoughts phase failed');
    return { proactiveItemsCreated: 0 };
  }
}

// ============ Sub-Agent Cleanup ============

export interface SubAgentCleanupResult {
  runsDeleted: number;
  sessionsDeleted: number;
}

/**
 * B8: Clean up old sub-agent runs and their sessions
 */
export function runSubAgentCleanup(ctx: GardenerContext, cleanupAfterSeconds: number = 3600): SubAgentCleanupResult {
  try {
    const maxAgeMs = cleanupAfterSeconds * 1000;

    // Get child session IDs of old sub-agent runs before deleting
    const childSessionIds = ctx.db.getSubAgentChildSessionIds(maxAgeMs);

    // Delete old completed/failed sub-agent run records
    const runsDeleted = ctx.db.deleteOldSubAgentRuns(maxAgeMs);

    // Delete their sessions and messages
    let sessionsDeleted = 0;
    for (const sessionId of childSessionIds) {
      try {
        ctx.db.deleteSession(sessionId);
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

    if (runsDeleted > 0 || sessionsDeleted > 0 || staleSessionsCleaned > 0) {
      ctx.logger.info(
        { runsDeleted, sessionsDeleted, staleSessionsCleaned },
        'Sub-agent cleanup complete'
      );
    }

    return { runsDeleted, sessionsDeleted };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Sub-agent cleanup failed');
    return { runsDeleted: 0, sessionsDeleted: 0 };
  }
}
