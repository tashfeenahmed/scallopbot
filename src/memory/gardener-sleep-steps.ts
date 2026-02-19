/**
 * Sleep tick substeps — individually-exported async functions.
 * Each function wraps its logic in try/catch with ctx.logger.warn() on failure.
 */

import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { GardenerContext } from './gardener-context.js';
import { DEFAULT_USER_ID } from './gardener-context.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';
import { dream } from './dream.js';
import type { DreamResult } from './dream.js';
import { reflect } from './reflection.js';

// ============ Step functions ============

/**
 * C1: Dream cycle (NREM consolidation + REM exploration)
 */
export async function runDreamCycle(ctx: GardenerContext): Promise<void> {
  if (!ctx.fusionProvider) return;

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
  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Dream cycle failed');
  }
}

/**
 * C2: Self-reflection (composite reflection -> SOUL.md re-distillation)
 */
export async function runSelfReflection(ctx: GardenerContext): Promise<void> {
  if (!ctx.fusionProvider || !ctx.workspace) return;

  try {
    const userId = DEFAULT_USER_ID;
    let totalInsights = 0;
    let soulUpdated = false;

    const allSummaries = ctx.db.getSessionSummariesByUser(userId, 50);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const todaySummaries = allSummaries.filter(s => s.createdAt >= oneDayAgo);

    if (todaySummaries.length === 0) return;

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
      return;
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
    }, 'Self-reflection complete');

  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Self-reflection failed');
  }
}

/**
 * C3: Gap scanner — now a no-op.
 *
 * Gap scanning has been merged into the unified ProactiveEvaluator
 * that runs during the deep tick (B7). This function is kept for
 * backward compatibility with the sleep tick orchestration but
 * does nothing. The deep tick evaluator sees both session context
 * AND system gaps in a single LLM call.
 */
export async function runGapScanner(ctx: GardenerContext): Promise<void> {
  ctx.logger.debug('Gap scanning handled by deep tick proactive evaluator — skipping');
}

/**
 * C4: Board Review — overnight task board maintenance.
 *
 * - Auto-archives done items older than 7 days
 * - Identifies stale in_progress/waiting items
 * - Logs board state for morning digest awareness
 */
export async function runBoardReview(ctx: GardenerContext): Promise<void> {
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

  } catch (err) {
    ctx.logger.warn({ error: (err as Error).message }, 'Board review phase failed');
  }
}

// Re-export from shared utils for backward compatibility
export { getTodayStartMs } from '../proactive/proactive-utils.js';
