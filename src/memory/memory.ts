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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ScallopMemoryStore } from './scallop-store.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';
import { performHealthPing } from './health-ping.js';
import type { GardenerContext } from './gardener-context.js';
import { DEFAULT_USER_ID } from './gardener-context.js';
import { isInQuietHours } from '../proactive/timing-model.js';
import {
  runFullDecay,
  runSessionSummarization,
  runEnhancedForgetting,
  runBehavioralInference,
  runTrustScoreUpdate,
  runGoalDeadlineCheck,
  runInnerThoughts,
  runSubAgentCleanup,
} from './gardener-deep-steps.js';
import {
  runDreamCycle,
  runSelfReflection,
  runGapScanner,
  runBoardReview,
} from './gardener-sleep-steps.js';

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
  /** Resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
  /** Callback fired once when transitioning out of quiet hours (morning digest) */
  onMorningDigest?: (userId: string) => Promise<void>;
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
  private getTimezone: (userId: string) => string;
  private onMorningDigest?: (userId: string) => Promise<void>;
  private wasInQuietHours = false;

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
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.onMorningDigest = options.onMorningDigest;
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

    // Detect quiet-hours → active-hours transition for morning digest
    const currentlyQuiet = this.isQuietHours();
    if (this.wasInQuietHours && !currentlyQuiet && this.onMorningDigest) {
      this.onMorningDigest(DEFAULT_USER_ID).catch(err => {
        this.logger.warn({ error: (err as Error).message }, 'Morning digest failed');
      });
    }
    this.wasInQuietHours = currentlyQuiet;
  }

  private buildContext(): GardenerContext {
    return {
      scallopStore: this.scallopStore,
      db: this.scallopStore.getDatabase(),
      logger: this.logger,
      fusionProvider: this.fusionProvider,
      sessionSummarizer: this.sessionSummarizer,
      quietHours: this.quietHours,
      workspace: this.workspace,
      disableArchival: this.disableArchival,
      getTimezone: this.getTimezone,
    };
  }

  /**
   * Deep tick: full decay, session summaries, pruning, behavioral inference
   */
  async deepTick(): Promise<void> {
    this.logger.info('Deep tick: full consolidation starting');
    const ctx = this.buildContext();

    runFullDecay(ctx);
    // Memory fusion removed — NREM consolidation (sleep tick) is a strict superset
    // with wider prominence window, cross-category clustering, and relation context.
    await runSessionSummarization(ctx);
    await runEnhancedForgetting(ctx);
    runBehavioralInference(ctx);
    runTrustScoreUpdate(ctx);
    await runGoalDeadlineCheck(ctx);
    await runInnerThoughts(ctx);
    runSubAgentCleanup(ctx);

    // Clean up stale agent-generated files
    if (this.workspace) {
      await this.cleanupOutputDir(this.workspace);
    }

    this.logger.info('Deep tick complete');
  }

  /**
   * Delete files older than 24h from the output/ directory to prevent workspace pollution.
   */
  private async cleanupOutputDir(workspace: string): Promise<void> {
    const outputDir = path.join(workspace, 'output');
    try {
      const entries = await fs.readdir(outputDir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const entry of entries) {
        const filePath = path.join(outputDir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            await fs.unlink(filePath);
            removed++;
          }
        } catch {
          // Skip files that can't be stat'd or deleted
        }
      }
      if (removed > 0) {
        this.logger.info({ removed, dir: outputDir }, 'Cleaned up stale output files');
      }
    } catch {
      // output/ directory doesn't exist yet — nothing to clean
    }
  }

  /**
   * Check if the current hour falls within configured quiet hours.
   * Uses the first known user's timezone (single-user system) instead of server time.
   */
  private isQuietHours(): boolean {
    let hour: number;
    try {
      const tz = this.getTimezone(DEFAULT_USER_ID);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }).formatToParts(new Date());
      const hourPart = parts.find(p => p.type === 'hour');
      const h = parseInt(hourPart?.value ?? '', 10);
      hour = isNaN(h) ? new Date().getHours() : h % 24;
    } catch {
      hour = new Date().getHours();
    }

    return isInQuietHours(hour, this.quietHours);
  }

  /**
   * Sleep tick: nightly cognitive processing (Tier 3).
   * Phase 27: NREM consolidation (wider prominence window, cross-category clustering)
   * Phase 28: REM exploration (creative association discovery via EXTENDS relations)
   * Phase 30: Self-reflection (composite reflection -> SOUL.md re-distillation)
   */
  async sleepTick(): Promise<void> {
    this.logger.info('Sleep tick: nightly cognitive processing starting');
    const ctx = this.buildContext();

    await runDreamCycle(ctx);
    await runSelfReflection(ctx);
    await runGapScanner(ctx);
    await runBoardReview(ctx);

    this.logger.info('Sleep tick complete');
  }

  /** Backward-compatible: processMemories calls lightTick */
  processMemories(): void {
    this.lightTick();
  }
}
