/**
 * Sleep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { GardenerContext } from './gardener-context.js';
import { safeBehavioralPatterns } from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
import { dream } from './dream.js';
import type { DreamResult } from './dream.js';
import { reflect } from './reflection.js';
import { scanForGaps } from './gap-scanner.js';
import { diagnoseGaps } from './gap-diagnosis.js';
import { createGapActions } from './gap-actions.js';

// ============ Result types ============

export interface DreamCycleResult {
  totalFused: number;
  totalMerged: number;
  totalDiscoveries: number;
}

export interface ReflectionStepResult {
  usersReflected: number;
  insightsGenerated: number;
  soulUpdated: boolean;
}

export interface GapScannerStepResult {
  actionsCreated: number;
}

// ============ Step functions ============

/**
 * C1: Dream cycle (NREM consolidation + REM exploration)
 */
export async function runDreamCycle(ctx: GardenerContext): Promise<DreamCycleResult> {
  if (!ctx.fusionProvider) return { totalFused: 0, totalMerged: 0, totalDiscoveries: 0 };

  try {
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let totalFused = 0;
    let totalMerged = 0;
    let totalDiscoveries = 0;

    for (const { user_id: userId } of userRows) {
      // Get memories with NREM's wider prominence window [0.05, 0.8)
      const allMemories = ctx.db.getMemoriesByUser(userId, {
        minProminence: 0.05,
        isLatest: true,
        includeAllSources: true,
      });
      const eligibleMemories = allMemories.filter(m =>
        m.prominence < 0.8 &&
        m.memoryType !== 'static_profile' &&
        m.memoryType !== 'derived'
      );

      if (eligibleMemories.length < 3) continue;

      const dreamResult: DreamResult = await dream(
        eligibleMemories,
        (id) => ctx.db.getRelations(id),
        ctx.fusionProvider,
        ctx.fusionProvider,
      );

      // ── Store NREM results ──
      if (dreamResult.nrem) {
        for (const result of dreamResult.nrem.fusionResults) {
          try {
            await storeFusedMemory({
              scallopStore: ctx.scallopStore,
              db: ctx.db,
              userId,
              summary: result.summary,
              category: result.category,
              importance: result.importance,
              confidence: result.confidence,
              sourceMemoryIds: result.sourceMemoryIds,
              sourceChunk: result.sourceMemoryIds.join(' | '),
              learnedFrom: 'nrem_consolidation',
              extraMetadata: { nrem: true },
            }, allMemories);

            totalFused++;
            totalMerged += result.sourceMemoryIds.length;
          } catch (err) {
            ctx.logger.warn({ error: (err as Error).message, userId }, 'NREM cluster storage failed');
          }
        }

        if (dreamResult.nrem.clustersProcessed > 0) {
          ctx.logger.info({
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
            ctx.db.addRelation(
              discovery.seedId,
              discovery.neighborId,
              'EXTENDS',
              discovery.confidence,
            );
            ctx.logger.debug({
              seedId: discovery.seedId,
              neighborId: discovery.neighborId,
              connection: discovery.connectionDescription,
              confidence: discovery.confidence,
            }, 'REM discovery: EXTENDS relation created');
            totalDiscoveries++;
          } catch (err) {
            ctx.logger.warn({ error: (err as Error).message, userId }, 'REM discovery storage failed');
          }
        }

        if (dreamResult.rem.seedsExplored > 0) {
          ctx.logger.info({
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
      ctx.logger.info({
        nremFused: totalFused,
        nremMemoriesMerged: totalMerged,
        remDiscoveries: totalDiscoveries,
      }, 'Dream cycle complete');
    }
    return { totalFused, totalMerged, totalDiscoveries };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Dream cycle failed');
    return { totalFused: 0, totalMerged: 0, totalDiscoveries: 0 };
  }
}

/**
 * C2: Self-reflection (composite reflection -> SOUL.md re-distillation)
 */
export async function runSelfReflection(ctx: GardenerContext): Promise<ReflectionStepResult> {
  if (!ctx.fusionProvider || !ctx.workspace) return { usersReflected: 0, insightsGenerated: 0, soulUpdated: false };

  try {
    const userRows = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM session_summaries', []);
    let totalInsights = 0;
    let soulUpdated = false;
    let usersReflected = 0;

    for (const { user_id: userId } of userRows) {
      try {
        const allSummaries = ctx.db.getSessionSummariesByUser(userId, 50);
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const todaySummaries = allSummaries.filter(s => s.createdAt >= oneDayAgo);

        if (todaySummaries.length === 0) continue;

        // Read current SOUL.md
        let currentSoul: string | null = null;
        const soulPath = path.join(ctx.workspace, 'SOUL.md');
        try {
          currentSoul = await fsPromises.readFile(soulPath, 'utf-8');
        } catch {
          // First run — SOUL.md doesn't exist yet
        }

        const result = await reflect(todaySummaries, currentSoul, ctx.fusionProvider);

        if (result.skipped) {
          ctx.logger.debug({ userId, reason: result.skipReason }, 'Self-reflection skipped');
          continue;
        }

        // Store insights as insight-category memories
        for (const insight of result.insights) {
          try {
            const mem = await ctx.scallopStore.add({
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
            ctx.db.updateMemory(mem.id, { memoryType: 'derived' });
            totalInsights++;
          } catch (err) {
            ctx.logger.warn({ error: (err as Error).message, userId }, 'Reflection insight storage failed');
          }
        }

        // Write updated SOUL.md
        if (result.updatedSoul) {
          try {
            await fsPromises.writeFile(soulPath, result.updatedSoul, 'utf-8');
            ctx.logger.info({ userId }, 'SOUL.md updated from self-reflection');
            soulUpdated = true;
          } catch (err) {
            ctx.logger.warn({ error: (err as Error).message }, 'SOUL.md write failed');
          }
        }

        ctx.logger.info({
          userId,
          insightsGenerated: result.insights.length,
          soulUpdated: result.updatedSoul !== null,
          sessionsReflected: todaySummaries.length,
        }, 'Self-reflection complete for user');
        usersReflected++;
      } catch (err) {
        ctx.logger.warn({ error: (err as Error).message, userId }, 'Self-reflection failed for user');
      }
    }
    return { usersReflected, insightsGenerated: totalInsights, soulUpdated };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Self-reflection phase failed');
    return { usersReflected: 0, insightsGenerated: 0, soulUpdated: false };
  }
}

/**
 * C3: Gap scanner (3-stage pipeline: scan -> diagnose -> create actions)
 */
export async function runGapScanner(ctx: GardenerContext): Promise<GapScannerStepResult> {
  if (!ctx.fusionProvider) return { actionsCreated: 0 };

  try {
    const users = ctx.db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\'', []);
    let totalActions = 0;

    for (const { user_id: userId } of users) {
      try {
        const sessionSummaries = ctx.db.getSessionSummariesByUser(userId, 20);
        const behavioralPatterns = ctx.db.getBehavioralPatterns(userId);
        const existingItems = ctx.db.getScheduledItemsByUser(userId);

        const GoalService = (await import('../goals/goal-service.js')).GoalService;
        const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
        const activeGoals = await goalService.listGoals(userId, { status: 'active' });

        // Stage 1: Scan for gaps
        const safeBehavioral = behavioralPatterns ?? safeBehavioralPatterns(userId);
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
          ctx.fusionProvider,
        );

        // Stage 3: Create gated actions
        const pendingItems = existingItems.filter(i => i.status === 'pending' || i.status === 'fired');
        const actions = createGapActions(
          diagnosed,
          dial as 'conservative' | 'moderate' | 'eager',
          pendingItems.map(i => ({ message: i.message, context: i.context })),
          userId,
        );

        // Insert scheduled items with timing model
        const gapActiveHours = safeBehavioral.activeHours ?? [];
        const lastProactiveAt = getLastProactiveAt(ctx.db, userId);

        for (const action of actions) {
          const gapContext = action.scheduledItem.context ? JSON.parse(action.scheduledItem.context) : {};
          const gapSeverity = gapContext.severity as string | undefined;
          const timingUrgency: 'low' | 'medium' | 'high' =
            gapSeverity === 'high' ? 'high' :
            gapSeverity === 'medium' ? 'medium' : 'low';

          scheduleProactiveItem({
            db: ctx.db,
            userId,
            message: action.scheduledItem.message,
            context: action.scheduledItem.context,
            type: 'follow_up',
            quietHours: ctx.quietHours,
            activeHours: gapActiveHours,
            lastProactiveAt,
            urgency: timingUrgency,
            timezone: ctx.getTimezone?.(userId),
          });
        }

        if (actions.length > 0) {
          ctx.logger.info({ userId, signalsFound: signals.length, actionsCreated: actions.length }, 'Gap scanner created actions');
          totalActions += actions.length;
        }
      } catch (err) {
        ctx.logger.warn({ error: (err as Error).message, userId }, 'Gap scanner failed for user');
      }
    }
    return { actionsCreated: totalActions };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Gap scanner phase failed');
    return { actionsCreated: 0 };
  }
}
