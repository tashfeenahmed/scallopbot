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

import type { ScallopMemoryStore } from './scallop-store.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';
import { performHealthPing } from './health-ping.js';
import type { GardenerContext } from './gardener-context.js';
import {
  runFullDecay,
  runMemoryFusion,
  runSessionSummarization,
  runEnhancedForgetting,
  runBehavioralInference,
  runTrustScoreUpdate,
  runGoalDeadlineCheck,
  runInnerThoughts,
} from './gardener-deep-steps.js';
import {
  runDreamCycle,
  runSelfReflection,
  runGapScanner,
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
    await runMemoryFusion(ctx);
    await runSessionSummarization(ctx);
    await runEnhancedForgetting(ctx);
    runBehavioralInference(ctx);
    runTrustScoreUpdate(ctx);
    await runGoalDeadlineCheck(ctx);
    await runInnerThoughts(ctx);

    this.logger.info('Deep tick complete');
  }

  /**
   * Check if the current hour falls within configured quiet hours.
   * Uses the first known user's timezone (single-user system) instead of server time.
   * Supports wrap-around ranges (e.g., start: 23, end: 5).
   */
  private isQuietHours(): boolean {
    let hour: number;
    try {
      // Resolve timezone from first known user
      const db = this.scallopStore.getDatabase();
      const userRows = db.raw<{ user_id: string }>('SELECT DISTINCT user_id FROM memories WHERE source != \'_cleaned_sentinel\' LIMIT 1', []);
      const userId = userRows.length > 0 ? userRows[0].user_id : null;
      if (userId) {
        const tz = this.getTimezone(userId);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour: 'numeric',
          hour12: false,
        }).formatToParts(new Date());
        const hourPart = parts.find(p => p.type === 'hour');
        const h = parseInt(hourPart?.value ?? '', 10);
        hour = isNaN(h) ? new Date().getHours() : h % 24;
      } else {
        hour = new Date().getHours();
      }
    } catch {
      hour = new Date().getHours();
    }

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
   * Phase 30: Self-reflection (composite reflection -> SOUL.md re-distillation)
   */
  async sleepTick(): Promise<void> {
    this.logger.info('Sleep tick: nightly cognitive processing starting');
    const ctx = this.buildContext();

    await runDreamCycle(ctx);
    await runSelfReflection(ctx);
    await runGapScanner(ctx);

    this.logger.info('Sleep tick complete');
  }

  /** Backward-compatible: processMemories calls lightTick */
  processMemories(): void {
    this.lightTick();
  }
}
