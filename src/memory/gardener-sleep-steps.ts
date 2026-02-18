/**
 * Sleep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { GardenerContext } from './gardener-context.js';
import { safeBehavioralPatterns, DEFAULT_USER_ID } from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
import { dream } from './dream.js';
import type { DreamResult } from './dream.js';
import { reflect } from './reflection.js';
import { scanForGaps } from './gap-scanner.js';
import { runGapPipeline } from './gap-pipeline.js';

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
    const userId = DEFAULT_USER_ID;
    let totalFused = 0;
    let totalMerged = 0;
    let totalDiscoveries = 0;

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

    if (eligibleMemories.length >= 3) {
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
    const userId = DEFAULT_USER_ID;
    let totalInsights = 0;
    let soulUpdated = false;
    let usersReflected = 0;

    try {
      const allSummaries = ctx.db.getSessionSummariesByUser(userId, 50);
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const todaySummaries = allSummaries.filter(s => s.createdAt >= oneDayAgo);

      if (todaySummaries.length > 0) {
        // Read current SOUL.md
        let currentSoul: string | null = null;
        const soulPath = path.join(ctx.workspace, 'SOUL.md');
        try {
          currentSoul = await fsPromises.readFile(soulPath, 'utf-8');
        } catch {
          // First run — SOUL.md doesn't exist yet
        }

        const result = await reflect(todaySummaries, currentSoul, ctx.fusionProvider);

        if (!result.skipped) {
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
        } else {
          ctx.logger.debug({ userId, reason: result.skipReason }, 'Self-reflection skipped');
        }
      }
    } catch (err) {
      ctx.logger.warn({ error: (err as Error).message, userId }, 'Self-reflection failed for user');
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
    const userId = DEFAULT_USER_ID;
    let totalActions = 0;

    try {
      const sessionSummaries = ctx.db.getSessionSummariesByUser(userId, 20);
      const behavioralPatterns = ctx.db.getBehavioralPatterns(userId);
      const existingItems = ctx.db.getScheduledItemsByUser(userId);

      const GoalService = (await import('../goals/goal-service.js')).GoalService;
      const goalService = new GoalService({ db: ctx.db, logger: ctx.logger });
      const activeGoals = await goalService.listGoals(userId, { status: 'active' });

      // Stage 1: Scan for gaps (pure heuristics, no LLM)
      const safeBehavioral = behavioralPatterns ?? safeBehavioralPatterns(userId);

      // Include board items for stale/blocked detection
      const boardItems = existingItems
        .filter(i => i.boardStatus === 'in_progress' || i.boardStatus === 'waiting')
        .map(i => ({
          id: i.id,
          title: i.message,
          boardStatus: i.boardStatus!,
          updatedAt: i.updatedAt,
          priority: i.priority,
        }));

      const signals = scanForGaps({
        activeGoals,
        behavioralSignals: safeBehavioral,
        sessionSummaries,
        boardItems,
      });

      if (signals.length > 0) {
        // Stage 2: Unified gap pipeline (single LLM call → ready-to-schedule items)
        const dial = (safeBehavioral.responsePreferences?.proactivenessDial as string) ?? 'moderate';
        const affect = safeBehavioral.smoothedAffect ?? null;
        const recentTopics = sessionSummaries.slice(0, 5).flatMap(s => s.topics ?? []);
        const pendingItems = existingItems.filter(i => i.status === 'pending' || i.status === 'fired');

        // Count agent-sourced items created today for daily budget enforcement
        const tz = ctx.getTimezone?.(userId) ?? 'UTC';
        const todayStart = getTodayStartMs(tz);
        const todayItemCount = existingItems.filter(
          i => i.source === 'agent' && i.createdAt >= todayStart
        ).length;

        const gapItems = await runGapPipeline({
          signals,
          dial: dial as 'conservative' | 'moderate' | 'eager',
          affect,
          recentTopics,
          existingItems: pendingItems.map(i => ({ message: i.message, context: i.context })),
          userId,
          todayItemCount,
        }, ctx.fusionProvider);

        // Insert scheduled items with timing model
        const gapActiveHours = safeBehavioral.activeHours ?? [];
        const lastProactiveAt = getLastProactiveAt(ctx.db, userId);

        for (const item of gapItems) {
          const timingUrgency: 'low' | 'medium' | 'high' =
            item.severity === 'high' ? 'high' :
            item.severity === 'medium' ? 'medium' : 'low';

          scheduleProactiveItem({
            db: ctx.db,
            userId,
            message: item.message,
            context: item.context,
            type: 'follow_up',
            kind: item.kind,
            taskConfig: item.taskConfig,
            quietHours: ctx.quietHours,
            activeHours: gapActiveHours,
            lastProactiveAt,
            urgency: timingUrgency,
            timezone: ctx.getTimezone?.(userId),
          });
        }

        if (gapItems.length > 0) {
          ctx.logger.info({ userId, signalsFound: signals.length, actionsCreated: gapItems.length }, 'Gap scanner created actions');
          totalActions += gapItems.length;
        }
      }
    } catch (err) {
      ctx.logger.warn({ error: (err as Error).message, userId }, 'Gap scanner failed for user');
    }
    return { actionsCreated: totalActions };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Gap scanner phase failed');
    return { actionsCreated: 0 };
  }
}

// ============ C4: Board Review ============

export interface BoardReviewResult {
  itemsAutoArchived: number;
  staleItemsFound: number;
}

/**
 * C4: Board Review — overnight task board maintenance.
 *
 * - Auto-archives done items older than 7 days
 * - Identifies stale in_progress/waiting items
 * - Logs board state for morning digest awareness
 */
export async function runBoardReview(ctx: GardenerContext): Promise<BoardReviewResult> {
  try {
    const userId = DEFAULT_USER_ID;
    const { BoardService } = await import('../board/board-service.js');
    const boardService = new BoardService(ctx.db, ctx.logger);

    // Auto-archive old done items
    const archived = boardService.autoArchive(userId);

    // Get board state for logging
    const board = boardService.getBoard(userId);
    const staleItems = (board.columns.in_progress || [])
      .filter(i => Date.now() - i.updatedAt > 48 * 60 * 60 * 1000).length
      + (board.columns.waiting || [])
      .filter(i => Date.now() - i.updatedAt > 72 * 60 * 60 * 1000).length;

    if (archived > 0 || staleItems > 0) {
      ctx.logger.info(
        { userId, autoArchived: archived, staleItems, activeItems: board.stats.totalActive },
        'Board review completed'
      );
    }

    return { itemsAutoArchived: archived, staleItemsFound: staleItems };
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Board review phase failed');
    return { itemsAutoArchived: 0, staleItemsFound: 0 };
  }
}

// ============ Helpers ============

/**
 * Get the start of today (midnight) in the given timezone, as epoch ms.
 * Approximation: uses Intl to find the current local hour, then subtracts
 * that many hours from the current time (rounded down to the hour).
 */
export function getTodayStartMs(timezone: string, nowMs?: number): number {
  try {
    const now = new Date(nowMs ?? Date.now());
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    return now.getTime() - (hour * 3600_000 + minute * 60_000) - (now.getSeconds() * 1000) - now.getMilliseconds();
  } catch {
    // Fallback: midnight in server local time
    const now = new Date(nowMs ?? Date.now());
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
}
