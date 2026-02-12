/**
 * Memory System
 * Background gardener for ScallopMemory (SQLite)
 *
 * Tiered consolidation:
 * - Tier 1 — Light tick (every 5 min): incremental decay + expire old scheduled items
 * - Tier 2 — Deep tick (every 6 hours): full decay, session summaries, pruning, behavioral inference
 * - Tier 3 — Sleep tick (every 24 hours, quiet hours only): nightly cognitive processing (Phase 27+)
 */

import type { Logger } from 'pino';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';

// Re-export types from legacy-types (needed by migrate.ts)
export type { MemoryType, MemoryEntry, PartialMemoryEntry } from './legacy-types.js';

// Re-export from bm25
export { calculateBM25Score, buildDocFreqMap, type BM25Options } from './bm25.js';

import type { ScallopMemoryStore } from './scallop-store.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import { dream } from './dream.js';
import type { DreamResult } from './dream.js';
import { performHealthPing } from './health-ping.js';
import { auditRetrievalHistory } from './retrieval-audit.js';
import { archiveLowUtilityMemories, pruneOrphanedRelations } from './utility-score.js';
import { computeTrustScore } from './trust-score.js';
import { checkGoalDeadlines } from './goal-deadline-check.js';
import { reflect } from './reflection.js';
import { scanForGaps } from './gap-scanner.js';
import { diagnoseGaps } from './gap-diagnosis.js';
import { createGapActions } from './gap-actions.js';
import { evaluateInnerThoughts } from './inner-thoughts.js';
import { computeDeliveryTime } from '../proactive/timing-model.js';

export interface BackgroundGardenerOptions {
  scallopStore: ScallopMemoryStore;
  logger: Logger;
  /** Light tick interval in ms (default: 5 minutes) */
  interval?: number;
  /** Session summarizer for generating summaries before pruning */
  sessionSummarizer?: SessionSummarizer;
  /** Optional LLM provider for memory fusion (merging dormant clusters) */
  fusionProvider?: LLMProvider;
  /** Quiet hours for sleep tick (default: 2-5 AM local time) */
  quietHours?: { start: number; end: number };
  /** Workspace directory for SOUL.md I/O (optional — reflection skipped if not provided) */
  workspace?: string;
  /** Disable utility-based archival in deepTick (for eval — batch ingestion has no retrieval) */
  disableArchival?: boolean;
}

/**
 * Background Gardener - runs tiered consolidation on memories
 *
 * Tier 1 — Light tick (every interval, default 5 min):
 *   - Incremental decay (bounded set of recently-changed memories)
 *   - Expire old scheduled items
 *
 * Tier 2 — Deep tick (every ~6 hours):
 *   - Full decay scan (all memories)
 *   - Generate session summaries for old sessions
 *   - Prune old sessions + archived memories
 *   - Behavioral pattern inference
 *
 * Tier 3 — Sleep tick (every ~24 hours, quiet hours only):
 *   - Nightly cognitive processing (Phase 27+: NREM, REM, self-reflection)
 */
export class BackgroundGardener {
  private scallopStore: ScallopMemoryStore;
  private logger: Logger;
  private interval: number;
  private sessionSummarizer?: SessionSummarizer;
  private fusionProvider?: LLMProvider;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private sleepTickCount = 0;
  private quietHours: { start: number; end: number };
  private workspace?: string;
  private disableArchival: boolean;

  /** Deep consolidation runs every DEEP_EVERY light ticks.
   *  With default 5-min interval: 72 ticks × 5 min = 6 hours */
  private static readonly DEEP_EVERY = 72;

  /** Sleep consolidation runs every SLEEP_EVERY light ticks.
   *  With default 5-min interval: 288 ticks × 5 min = 24 hours */
  private static readonly SLEEP_EVERY = 288;

  constructor(options: BackgroundGardenerOptions) {
    this.scallopStore = options.scallopStore;
    this.logger = options.logger.child({ component: 'gardener' });
    this.interval = options.interval ?? 5 * 60 * 1000; // 5 minutes default
    this.sessionSummarizer = options.sessionSummarizer;
    this.fusionProvider = options.fusionProvider;
    this.quietHours = options.quietHours ?? { start: 2, end: 5 };
    this.workspace = options.workspace;
    this.disableArchival = options.disableArchival ?? false;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    try {
      this.timer = setInterval(() => {
        this.lightTick();
      }, this.interval);

      this.logger.info({ intervalMs: this.interval }, 'Background gardener started (tiered consolidation)');
    } catch (error) {
      this.running = false;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      throw error;
    }
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Background gardener stopped');
  }

  /**
   * Light tick: incremental decay + expire scheduled items
   */
  lightTick(): void {
    this.logger.debug('Light tick: incremental decay');

    const decayResult = this.scallopStore.processDecay();
    if (decayResult.updated > 0 || decayResult.archived > 0) {
      this.logger.debug(
        { updated: decayResult.updated, archived: decayResult.archived },
        'Incremental decay processed'
      );
    }

    // Expire old scheduled items
    try {
      const db = this.scallopStore.getDatabase();
      db.expireOldScheduledItems();
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Expire scheduled items failed');
    }

    // Health ping (sync — safe for lightTick)
    try {
      const db = this.scallopStore.getDatabase();
      const health = performHealthPing(db);
      this.logger.debug({ ...health }, 'Health ping');
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Health ping failed');
    }

    // Check if it's time for a deep tick
    this.tickCount++;
    if (this.tickCount >= BackgroundGardener.DEEP_EVERY) {
      this.tickCount = 0;
      this.deepTick().catch(err => {
        this.logger.warn({ error: (err as Error).message }, 'Deep tick failed');
      });
    }

    // Check if it's time for a sleep tick (quiet hours gated)
    this.sleepTickCount++;
    if (this.sleepTickCount >= BackgroundGardener.SLEEP_EVERY && this.isQuietHours()) {
      this.sleepTickCount = 0;
      this.sleepTick().catch(err => {
        this.logger.warn({ error: (err as Error).message }, 'Sleep tick failed');
      });
    }
  }

  /**
   * Deep tick: full decay, session summaries, pruning, behavioral inference
   */
  async deepTick(): Promise<void> {
    this.logger.info('Deep tick: full consolidation starting');

    const db = this.scallopStore.getDatabase();

    // 1. Full decay scan (all memories)
    const fullDecayResult = this.scallopStore.processFullDecay();
    if (fullDecayResult.updated > 0) {
      this.logger.info(
        { updated: fullDecayResult.updated, archived: fullDecayResult.archived },
        'Full decay processed'
      );
    }

    // 1.5. Memory fusion (merge dormant related memory clusters)
    if (this.fusionProvider) {
      try {
        // Get all users with memories
        const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
        let totalFused = 0;
        let totalMerged = 0;

        for (const { user_id: userId } of userRows) {
          // Get dormant memories for this user
          const allMemories = db.getMemoriesByUser(userId, {
            minProminence: 0.1,
            isLatest: true,
            includeAllSources: true,
          });
          // Filter in JS: prominence < 0.7 (naturally decayed) and not static_profile or derived
          // Note: decay formula floor is ~0.52 for old low-importance memories,
          // so 0.7 captures memories that have significantly decayed from initial ~0.9
          const dormantMemories = allMemories.filter(m =>
            m.prominence < 0.7 &&
            m.memoryType !== 'static_profile' &&
            m.memoryType !== 'derived'
          );

          if (dormantMemories.length < 2) continue; // Need at least minClusterSize

          // Find fusion clusters (maxProminence matches JS filter above)
          const clusters = findFusionClusters(
            dormantMemories,
            (id) => db.getRelations(id),
            { minClusterSize: 2, maxClusters: 5, maxProminence: 0.7 },
          );

          // Fuse each cluster
          for (const cluster of clusters) {
            const result = await fuseMemoryCluster(cluster, this.fusionProvider);
            if (!result) continue;

            // Store fused memory
            const fusedMemory = await this.scallopStore.add({
              userId,
              content: result.summary,
              category: result.category,
              importance: result.importance,
              confidence: result.confidence,
              sourceChunk: cluster.map(m => m.content).join(' | '),
              metadata: {
                fusedAt: new Date().toISOString(),
                sourceCount: cluster.length,
                sourceIds: cluster.map(m => m.id),
              },
              learnedFrom: 'consolidation',
              detectRelations: false,
            });

            // Override memoryType to 'derived' (add() sets 'regular')
            db.updateMemory(fusedMemory.id, { memoryType: 'derived' });

            // Add DERIVES relations from fused memory to each source
            for (const source of cluster) {
              db.addRelation(fusedMemory.id, source.id, 'DERIVES', 0.95);
            }

            // Keep originals searchable — fused memory is supplementary, not a replacement
            // (Superseding loses specific details that multi-hop retrieval needs)

            // Set fused memory prominence
            const maxProminence = Math.max(...cluster.map(m => m.prominence));
            const fusedProminence = Math.min(0.6, maxProminence + 0.1);
            db.updateProminences([{ id: fusedMemory.id, prominence: fusedProminence }]);

            totalFused++;
            totalMerged += cluster.length;
          }
        }

        if (totalFused > 0) {
          this.logger.info({ fused: totalFused, memoriesMerged: totalMerged }, 'Memory fusion complete');
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Memory fusion failed');
      }
    }

    // 2. Generate session summaries for old sessions before pruning
    if (this.sessionSummarizer) {
      try {
        const cutoffDays = 1;
        const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
        // Find sessions that are about to be pruned
        const oldSessions = db.raw<{ id: string }>(
          'SELECT id FROM sessions WHERE updated_at < ? LIMIT 20',
          [cutoff]
        );
        if (oldSessions.length > 0) {
          const summarized = await this.sessionSummarizer.summarizeBatch(
            db,
            oldSessions.map(s => s.id)
          );
          if (summarized > 0) {
            this.logger.info({ summarized, total: oldSessions.length }, 'Session summaries generated');
          }
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Session summarization failed');
      }
    }

    // 3. Enhanced forgetting pipeline (replaces old steps 3+5)
    // 3a. Retrieval audit (moved from old step 5 to inform archival)
    let auditNeverRetrieved = 0;
    let auditStaleRetrieved = 0;
    let auditCandidateCount = 0;
    try {
      const auditResult = auditRetrievalHistory(db);
      auditNeverRetrieved = auditResult.neverRetrieved;
      auditStaleRetrieved = auditResult.staleRetrieved;
      auditCandidateCount = auditResult.candidatesForDecay.length;
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Retrieval audit failed');
    }

    // 3b. Utility-based archival of low-utility active memories
    let archiveCount = 0;
    if (!this.disableArchival) {
      try {
        const archiveResult = archiveLowUtilityMemories(db, {
          utilityThreshold: 0.1,
          minAgeDays: 14,
          maxPerRun: 50,
        });
        archiveCount = archiveResult.archived;
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Utility-based archival failed');
      }
    }

    // 3c. Hard prune truly dead memories (very low prominence + superseded)
    let sessionsDeleted = 0;
    let memoriesDeleted = 0;
    if (!this.disableArchival) {
      try {
        sessionsDeleted = db.pruneOldSessions(30);
        memoriesDeleted = db.pruneArchivedMemories(0.01);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Hard pruning failed');
      }
    }

    // 3d. Prune orphaned relation edges
    let orphansDeleted = 0;
    try {
      orphansDeleted = pruneOrphanedRelations(db);
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Orphan relation pruning failed');
    }

    this.logger.info(
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

    // 4. Behavioral pattern inference
    try {
      const profileManager = this.scallopStore.getProfileManager();
      // Get recent session messages for behavioral analysis
      const recentSessions = db.listSessions(5);
      const allMessages: Array<{ content: string; timestamp: number }> = [];
      for (const session of recentSessions) {
        const messages = db.getSessionMessages(session.id);
        for (const msg of messages) {
          if (msg.role === 'user') {
            allMessages.push({ content: msg.content, timestamp: msg.createdAt });
          }
        }
      }
      if (allMessages.length > 0) {
        // Build session engagement data from session summaries (already available)
        const sessionSummaries = db.getSessionSummariesByUser('default', 20);
        const sessions = sessionSummaries
          .filter(s => s.messageCount > 0)
          .map(s => ({
            messageCount: s.messageCount,
            durationMs: s.durationMs,
            startTime: s.createdAt,
          }));

        // Collect existing embeddings from memories (no new embedding generation)
        const userMemories = db.getMemoriesByUser('default', { isLatest: true, limit: 100 });
        const messageEmbeddings = userMemories
          .filter(m => m.embedding != null)
          .map(m => ({
            content: m.content,
            embedding: m.embedding!,
          }));

        profileManager.inferBehavioralPatterns('default', allMessages, {
          sessions: sessions.length > 0 ? sessions : undefined,
          messageEmbeddings: messageEmbeddings.length > 0 ? messageEmbeddings : undefined,
        });
        this.logger.debug({ messageCount: allMessages.length }, 'Behavioral patterns updated');
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Behavioral inference failed');
    }

    // 5. Trust score update
    try {
      const profileManager = this.scallopStore.getProfileManager();
      const sessionSummaries = db.getSessionSummariesByUser('default', 30);
      let sessions = sessionSummaries
        .filter(s => s.messageCount > 0)
        .map(s => ({ messageCount: s.messageCount, durationMs: s.durationMs, startTime: s.createdAt }));

      // Fallback: if fewer than 5 session summaries, use raw sessions from the sessions table
      if (sessions.length < 5) {
        const rawSessions = db.listSessions(30);
        const fallbackSessions = rawSessions.map(s => {
          const msgs = db.getSessionMessages(s.id);
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

      const rawScheduledItems = db.getScheduledItemsByUser('default');
      const scheduledItems = rawScheduledItems
        .filter(i => i.status !== 'expired')
        .map(i => ({ status: i.status as 'pending' | 'fired' | 'acted' | 'dismissed', source: i.source, firedAt: i.firedAt ?? undefined }));
      const existingPatterns = profileManager.getBehavioralPatterns('default');
      const existingTrust = existingPatterns?.responsePreferences?.trustScore as number | undefined;
      const trustResult = computeTrustScore(sessions, scheduledItems, { existingScore: existingTrust });
      if (trustResult) {
        profileManager.updateBehavioralPatterns('default', {
          responsePreferences: {
            ...(existingPatterns?.responsePreferences ?? {}),
            trustScore: trustResult.trustScore,
            proactivenessDial: trustResult.proactivenessDial,
          },
        });
        this.logger.debug({ trustScore: trustResult.trustScore, dial: trustResult.proactivenessDial }, 'Trust score updated');
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Trust score update failed');
    }

    // 6. Goal deadline check
    try {
      const GoalService = (await import('../goals/goal-service.js')).GoalService;
      const goalService = new GoalService({ db, logger: this.logger });
      const activeGoals = await goalService.listGoals('default', { status: 'active' });
      const goalsWithDueDates = activeGoals.filter(g => g.metadata.dueDate != null);
      if (goalsWithDueDates.length > 0) {
        const pendingItems = db.getDueScheduledItems(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const existingReminders = pendingItems.map(item => ({ message: item.message }));
        const deadlineResult = checkGoalDeadlines(goalsWithDueDates, existingReminders);
        for (const notification of deadlineResult.notifications) {
          if (!db.hasSimilarPendingScheduledItem(notification.userId, notification.message)) {
            db.addScheduledItem({
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
          this.logger.info({ approaching: deadlineResult.approaching.length, notifications: deadlineResult.notifications.length }, 'Goal deadline check complete');
        }
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Goal deadline check failed');
    }

    // 7. Inner thoughts evaluation (for users with recent session summaries)
    if (this.fusionProvider) {
      try {
        const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM session_summaries', []);
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

        for (const { user_id: userId } of userRows) {
          try {
            // Only evaluate inner thoughts for users with session summaries created since last deep tick (~6h)
            const allSummaries = db.getSessionSummariesByUser(userId, 10);
            const recentSummaries = allSummaries.filter(s => s.createdAt >= sixHoursAgo);

            if (recentSummaries.length === 0) continue;

            // Use the most recent session summary
            const sessionSummary = recentSummaries[0];

            // Gather context for inner thoughts evaluation
            const behavioralPatterns = db.getBehavioralPatterns(userId);
            const affect = behavioralPatterns?.smoothedAffect ?? null;
            const dial = (behavioralPatterns?.responsePreferences?.proactivenessDial as 'conservative' | 'moderate' | 'eager') ?? 'moderate';
            const activeHours = behavioralPatterns?.activeHours ?? [];

            // Get last proactive firing timestamp
            const scheduledItems = db.getScheduledItemsByUser(userId);
            const lastFiredAgent = scheduledItems
              .filter(i => i.source === 'agent' && i.firedAt != null)
              .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0));
            const lastProactiveAt = lastFiredAgent.length > 0 ? lastFiredAgent[0].firedAt : null;

            // Get recent gap signals (reuse scanner inputs)
            const GoalService = (await import('../goals/goal-service.js')).GoalService;
            const goalService = new GoalService({ db, logger: this.logger });
            const activeGoals = await goalService.listGoals(userId, { status: 'active' });
            const safeBehavioral = behavioralPatterns ?? {
              userId,
              communicationStyle: null,
              expertiseAreas: [],
              responsePreferences: {},
              activeHours: [],
              messageFrequency: null,
              sessionEngagement: null,
              topicSwitch: null,
              responseLength: null,
              affectState: null,
              smoothedAffect: null,
              updatedAt: 0,
            };
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
            }, this.fusionProvider);

            if (result.decision === 'proact' && result.message) {
              // Skip if a similar item already exists (prevents duplication)
              if (db.hasSimilarPendingScheduledItem(userId, result.message)) {
                this.logger.debug({ userId }, 'Skipping inner thoughts item - similar already pending');
                continue;
              }

              // Compute delivery time using timing model
              const currentHour = new Date().getHours();
              const timing = computeDeliveryTime({
                userActiveHours: activeHours,
                quietHours: this.quietHours,
                lastProactiveAt,
                currentHour,
                urgency: result.urgency,
                now: Date.now(),
              });

              db.addScheduledItem({
                userId,
                sessionId: null,
                source: 'agent',
                type: 'follow_up',
                message: result.message,
                context: JSON.stringify({
                  source: 'inner_thoughts',
                  reason: result.reason,
                  urgency: result.urgency,
                  gapSourceIds: gapSignals.map(s => s.sourceId),
                }),
                triggerAt: timing.deliverAt,
                recurring: null,
                sourceMemoryId: null,
              });

              this.logger.info({ userId, urgency: result.urgency, strategy: timing.strategy, reason: result.reason }, 'Inner thoughts created proactive item');
            }
          } catch (err) {
            this.logger.warn({ error: (err as Error).message, userId }, 'Inner thoughts failed for user');
          }
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Inner thoughts phase failed');
      }
    }

    this.logger.info('Deep tick complete');
  }

  /**
   * Check if the current hour falls within configured quiet hours.
   * Supports wrap-around ranges (e.g., start: 23, end: 5).
   */
  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    if (this.quietHours.start < this.quietHours.end) {
      return hour >= this.quietHours.start && hour < this.quietHours.end;
    }
    // Handle wrap-around (e.g., start: 23, end: 5)
    return hour >= this.quietHours.start || hour < this.quietHours.end;
  }

  /**
   * Sleep tick: nightly cognitive processing (Tier 3).
   * Phase 27: NREM consolidation (wider prominence window, cross-category clustering)
   * Phase 28: REM exploration (creative association discovery via EXTENDS relations)
   * Phase 30: Self-reflection (composite reflection → SOUL.md re-distillation)
   */
  async sleepTick(): Promise<void> {
    this.logger.info('Sleep tick: nightly cognitive processing starting');

    const db = this.scallopStore.getDatabase();

    // Phase 27+28: Dream cycle (NREM consolidation → REM exploration)
    if (this.fusionProvider) {
      try {
        const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
        let totalFused = 0;
        let totalMerged = 0;
        let totalDiscoveries = 0;

        for (const { user_id: userId } of userRows) {
          // Get memories with NREM's wider prominence window [0.05, 0.8)
          const allMemories = db.getMemoriesByUser(userId, {
            minProminence: 0.05,
            isLatest: true,
            includeAllSources: true,
          });
          // Filter in JS: prominence < 0.8, exclude static_profile and derived
          const eligibleMemories = allMemories.filter(m =>
            m.prominence < 0.8 &&
            m.memoryType !== 'static_profile' &&
            m.memoryType !== 'derived'
          );

          if (eligibleMemories.length < 3) continue;

          // Run dream cycle: NREM consolidation → REM exploration
          // Reuse fusionProvider for both NREM and REM (same fast-tier LLM)
          const dreamResult: DreamResult = await dream(
            eligibleMemories,
            (id) => db.getRelations(id),
            this.fusionProvider,
            this.fusionProvider,
          );

          // ── Store NREM results (same pattern as before — unchanged) ──
          if (dreamResult.nrem) {
            for (const result of dreamResult.nrem.fusionResults) {
              try {
                const fusedMemory = await this.scallopStore.add({
                  userId,
                  content: result.summary,
                  category: result.category,
                  importance: result.importance,
                  confidence: result.confidence,
                  sourceChunk: result.sourceMemoryIds.join(' | '),
                  metadata: {
                    fusedAt: new Date().toISOString(),
                    sourceCount: result.sourceMemoryIds.length,
                    sourceIds: result.sourceMemoryIds,
                    nrem: true,
                  },
                  learnedFrom: 'nrem_consolidation',
                  detectRelations: false,
                });

                // Override memoryType to 'derived' (add() sets 'regular')
                db.updateMemory(fusedMemory.id, { memoryType: 'derived' });

                // Add DERIVES relations from fused memory to each source
                for (const sourceId of result.sourceMemoryIds) {
                  db.addRelation(fusedMemory.id, sourceId, 'DERIVES', 0.95);
                }

                // Keep originals searchable — fused memory is supplementary, not a replacement
                // (Superseding loses specific details that multi-hop retrieval needs)

                // Set fused memory prominence
                const sourceMemories = allMemories.filter(m => result.sourceMemoryIds.includes(m.id));
                const maxProminence = Math.max(...sourceMemories.map(m => m.prominence));
                const fusedProminence = Math.min(0.6, maxProminence + 0.1);
                db.updateProminences([{ id: fusedMemory.id, prominence: fusedProminence }]);

                totalFused++;
                totalMerged += result.sourceMemoryIds.length;
              } catch (err) {
                this.logger.warn({ error: (err as Error).message, userId }, 'NREM cluster storage failed');
              }
            }

            if (dreamResult.nrem.clustersProcessed > 0) {
              this.logger.info({
                userId,
                clustersProcessed: dreamResult.nrem.clustersProcessed,
                memoriesConsolidated: dreamResult.nrem.fusionResults.length,
                failures: dreamResult.nrem.failures,
              }, 'NREM consolidation complete for user');
            }
          }

          // ── Store REM results (EXTENDS relations only — no new memories) ──
          if (dreamResult.rem) {
            for (const discovery of dreamResult.rem.discoveries) {
              try {
                db.addRelation(
                  discovery.seedId,
                  discovery.neighborId,
                  'EXTENDS',
                  discovery.confidence,
                );
                this.logger.debug({
                  seedId: discovery.seedId,
                  neighborId: discovery.neighborId,
                  connection: discovery.connectionDescription,
                  confidence: discovery.confidence,
                }, 'REM discovery: EXTENDS relation created');
                totalDiscoveries++;
              } catch (err) {
                this.logger.warn({ error: (err as Error).message, userId }, 'REM discovery storage failed');
              }
            }

            if (dreamResult.rem.seedsExplored > 0) {
              this.logger.info({
                userId,
                seedsExplored: dreamResult.rem.seedsExplored,
                candidatesEvaluated: dreamResult.rem.candidatesEvaluated,
                discoveries: dreamResult.rem.discoveries.length,
                failures: dreamResult.rem.failures,
              }, 'REM exploration complete for user');
            }
          }
        }

        if (totalFused > 0 || totalDiscoveries > 0) {
          this.logger.info({
            nremFused: totalFused,
            nremMemoriesMerged: totalMerged,
            remDiscoveries: totalDiscoveries,
          }, 'Dream cycle complete');
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Dream cycle failed');
      }
    }

    // Phase 30: Self-reflection
    if (this.fusionProvider && this.workspace) {
      try {
        const db = this.scallopStore.getDatabase();
        // Get today's session summaries (all users — iterate per user like dream cycle)
        const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM session_summaries', []);

        for (const { user_id: userId } of userRows) {
          try {
            // Get recent session summaries (last 24h worth)
            const allSummaries = db.getSessionSummariesByUser(userId, 50);
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            const todaySummaries = allSummaries.filter(s => s.createdAt >= oneDayAgo);

            if (todaySummaries.length === 0) continue;

            // Read current SOUL.md (may not exist yet)
            let currentSoul: string | null = null;
            const soulPath = path.join(this.workspace, 'SOUL.md');
            try {
              currentSoul = await fsPromises.readFile(soulPath, 'utf-8');
            } catch {
              // First run — SOUL.md doesn't exist yet
            }

            // Generate reflections
            const result = await reflect(todaySummaries, currentSoul, this.fusionProvider);

            if (result.skipped) {
              this.logger.debug({ userId, reason: result.skipReason }, 'Self-reflection skipped');
              continue;
            }

            // Store insights as insight-category memories with DERIVES relations
            for (const insight of result.insights) {
              try {
                const mem = await this.scallopStore.add({
                  userId,
                  content: insight.content,
                  category: 'insight',
                  importance: 7,
                  confidence: 0.85,
                  sourceChunk: insight.sourceSessionIds.join(' | '),
                  metadata: {
                    reflectedAt: new Date().toISOString(),
                    topics: insight.topics,
                    sourceSessionIds: insight.sourceSessionIds,
                  },
                  learnedFrom: 'self_reflection',
                  detectRelations: false,
                });
                db.updateMemory(mem.id, { memoryType: 'derived' });

                // DERIVES relations to source session summary memory entries
                // (session summaries are stored in a separate table, not memories —
                //  so we skip DERIVES relations to sessions and rely on metadata.sourceSessionIds)
              } catch (err) {
                this.logger.warn({ error: (err as Error).message, userId }, 'Reflection insight storage failed');
              }
            }

            // Write updated SOUL.md
            if (result.updatedSoul) {
              try {
                await fsPromises.writeFile(soulPath, result.updatedSoul, 'utf-8');
                this.logger.info({ userId }, 'SOUL.md updated from self-reflection');
              } catch (err) {
                this.logger.warn({ error: (err as Error).message }, 'SOUL.md write failed');
              }
            }

            this.logger.info({
              userId,
              insightsGenerated: result.insights.length,
              soulUpdated: result.updatedSoul !== null,
              sessionsReflected: todaySummaries.length,
            }, 'Self-reflection complete for user');
          } catch (err) {
            this.logger.warn({ error: (err as Error).message, userId }, 'Self-reflection failed for user');
          }
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Self-reflection phase failed');
      }
    }

    // Phase 31: Gap scanner
    if (this.fusionProvider) {
      try {
        const users = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);

        for (const { user_id: userId } of users) {
          try {
            // Gather Stage 1 inputs
            const sessionSummaries = db.getSessionSummariesByUser(userId, 20);
            const behavioralPatterns = db.getBehavioralPatterns(userId);
            const existingItems = db.getScheduledItemsByUser(userId);

            // Dynamic import GoalService (same pattern as deepTick step 7)
            const GoalService = (await import('../goals/goal-service.js')).GoalService;
            const goalService = new GoalService({ db, logger: this.logger });
            const activeGoals = await goalService.listGoals(userId, { status: 'active' });

            // Stage 1: Scan for gaps (pure, no LLM)
            // behavioralPatterns may be null on cold start; scanBehavioralAnomalies
            // guards against null messageFrequency, but the type requires non-null.
            // Provide a minimal stub when null so stale-goal and unresolved-thread
            // scanners still run.
            const safeBehavioral = behavioralPatterns ?? {
              userId,
              communicationStyle: null,
              expertiseAreas: [],
              responsePreferences: {},
              activeHours: [],
              messageFrequency: null,
              sessionEngagement: null,
              topicSwitch: null,
              responseLength: null,
              affectState: null,
              smoothedAffect: null,
              updatedAt: 0,
            };
            const signals = scanForGaps({
              activeGoals,
              behavioralSignals: safeBehavioral,
              sessionSummaries,
            });

            if (signals.length === 0) continue;

            // Stage 2: LLM diagnosis
            const dial = (safeBehavioral.responsePreferences?.proactivenessDial as string) ?? 'moderate';
            const affect = safeBehavioral.smoothedAffect ?? null;
            const recentTopics = sessionSummaries.slice(0, 5).flatMap(s => s.topics ?? []);

            const diagnosed = await diagnoseGaps(
              signals,
              { affect, dial: dial as 'conservative' | 'moderate' | 'eager', recentTopics },
              this.fusionProvider,
            );

            // Stage 3: Create gated actions (pass context for sourceId-based dedup)
            const pendingItems = existingItems.filter(i => i.status === 'pending' || i.status === 'fired');
            const actions = createGapActions(
              diagnosed,
              dial as 'conservative' | 'moderate' | 'eager',
              pendingItems.map(i => ({ message: i.message, context: i.context })),
              userId,
            );

            // Insert scheduled items with timing model (replaces fixed 30-min delay)
            const currentHour = new Date().getHours();
            const gapActiveHours = safeBehavioral.activeHours ?? [];
            // Get last proactive firing timestamp for gap enforcement
            const lastFiredGap = existingItems
              .filter(i => i.source === 'agent' && i.firedAt != null)
              .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0));
            const lastProactiveAtGap = lastFiredGap.length > 0 ? lastFiredGap[0].firedAt : null;

            for (const action of actions) {
              // Map gap severity to timing urgency
              const gapContext = action.scheduledItem.context ? JSON.parse(action.scheduledItem.context) : {};
              const gapSeverity = gapContext.severity as string | undefined;
              const timingUrgency: 'low' | 'medium' | 'high' =
                gapSeverity === 'high' ? 'high' :
                gapSeverity === 'medium' ? 'medium' : 'low';

              const timing = computeDeliveryTime({
                userActiveHours: gapActiveHours,
                quietHours: this.quietHours,
                lastProactiveAt: lastProactiveAtGap,
                currentHour,
                urgency: timingUrgency,
                now: Date.now(),
              });

              db.addScheduledItem({
                userId,
                sessionId: null,
                source: 'agent',
                type: 'follow_up',
                message: action.scheduledItem.message,
                context: action.scheduledItem.context,
                triggerAt: timing.deliverAt,
                recurring: null,
                sourceMemoryId: null,
              });
            }

            if (actions.length > 0) {
              this.logger.info({ userId, signalsFound: signals.length, actionsCreated: actions.length }, 'Gap scanner created actions');
            }
          } catch (err) {
            this.logger.warn({ error: (err as Error).message, userId }, 'Gap scanner failed for user');
          }
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Gap scanner phase failed');
      }
    }

    this.logger.info('Sleep tick complete');
  }

  /** Backward-compatible: processMemories calls lightTick */
  processMemories(): void {
    this.lightTick();
  }
}
