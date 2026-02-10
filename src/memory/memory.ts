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

// Re-export types from legacy-types (needed by migrate.ts)
export type { MemoryType, MemoryEntry, PartialMemoryEntry } from './legacy-types.js';

// Re-export from bm25
export { calculateBM25Score, buildDocFreqMap, type BM25Options } from './bm25.js';

import type { ScallopMemoryStore } from './scallop-store.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';
import { findFusionClusters, fuseMemoryCluster } from './fusion.js';
import { nremConsolidate } from './nrem-consolidation.js';
import { performHealthPing } from './health-ping.js';
import { auditRetrievalHistory } from './retrieval-audit.js';
import { computeTrustScore } from './trust-score.js';
import { checkGoalDeadlines } from './goal-deadline-check.js';

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
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      this.lightTick();
    }, this.interval);

    this.logger.info({ intervalMs: this.interval }, 'Background gardener started (tiered consolidation)');
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

          if (dormantMemories.length < 3) continue; // Need at least minClusterSize

          // Find fusion clusters (maxProminence matches JS filter above)
          const clusters = findFusionClusters(
            dormantMemories,
            (id) => db.getRelations(id),
            { minClusterSize: 3, maxClusters: 5, maxProminence: 0.7 },
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

            // Mark sources as superseded
            for (const source of cluster) {
              this.scallopStore.update(source.id, { isLatest: false });
              db.updateMemory(source.id, { memoryType: 'superseded' });
            }

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
        const cutoffDays = 30;
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

    // 3. Prune old sessions + archived memories
    try {
      const sessionsDeleted = db.pruneOldSessions(30);
      const memoriesDeleted = db.pruneArchivedMemories(0.01);
      if (sessionsDeleted > 0 || memoriesDeleted > 0) {
        this.logger.info(
          { sessionsDeleted, memoriesDeleted },
          'Deep pruning complete'
        );
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Deep pruning failed');
    }

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

    // 5. Retrieval audit
    try {
      const auditResult = auditRetrievalHistory(db);
      if (auditResult.neverRetrieved > 0 || auditResult.staleRetrieved > 0) {
        this.logger.info({ ...auditResult, candidateCount: auditResult.candidatesForDecay.length }, 'Retrieval audit complete');
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Retrieval audit failed');
    }

    // 6. Trust score update
    try {
      const profileManager = this.scallopStore.getProfileManager();
      const sessionSummaries = db.getSessionSummariesByUser('default', 30);
      const sessions = sessionSummaries
        .filter(s => s.messageCount > 0)
        .map(s => ({ messageCount: s.messageCount, durationMs: s.durationMs, startTime: s.createdAt }));
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

    // 7. Goal deadline check
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
   */
  async sleepTick(): Promise<void> {
    this.logger.info('Sleep tick: nightly cognitive processing starting');

    const db = this.scallopStore.getDatabase();

    // Phase 27: NREM consolidation
    if (this.fusionProvider) {
      try {
        const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
        let totalFused = 0;
        let totalMerged = 0;

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

          // Run NREM consolidation (pure function — handles clustering, relation context, LLM fusion)
          const nremResult = await nremConsolidate(
            eligibleMemories,
            (id) => db.getRelations(id),
            this.fusionProvider,
          );

          // Store each fused result (same pattern as deep tick fusion)
          for (const result of nremResult.fusionResults) {
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

              // Mark sources as superseded
              for (const sourceId of result.sourceMemoryIds) {
                this.scallopStore.update(sourceId, { isLatest: false });
                db.updateMemory(sourceId, { memoryType: 'superseded' });
              }

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

          if (nremResult.clustersProcessed > 0) {
            this.logger.info({
              userId,
              clustersProcessed: nremResult.clustersProcessed,
              memoriesConsolidated: nremResult.fusionResults.length,
              failures: nremResult.failures,
            }, 'NREM consolidation complete for user');
          }
        }

        if (totalFused > 0) {
          this.logger.info({ fused: totalFused, memoriesMerged: totalMerged }, 'NREM consolidation complete');
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'NREM consolidation failed');
      }
    }

    // Phase 28: REM exploration (placeholder)
    // Phase 30: Self-reflection (placeholder)

    this.logger.info('Sleep tick complete');
  }

  /** Backward-compatible: processMemories calls lightTick */
  processMemories(): void {
    this.lightTick();
  }
}
