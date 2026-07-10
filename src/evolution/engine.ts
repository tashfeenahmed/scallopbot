/**
 * EvolutionEngine — the Layer 2 orchestrator wired into the runtime.
 *
 * Owns the optimizer + watchdog and decides when each runs:
 *   - runOptimizer(): heavy (LLM reflection), gated to ~once/day via a watermark;
 *     intended to fire from the gardener SLEEP tick (quiet hours).
 *   - runWatchdog(): cheap (no LLM), safe to run every gardener DEEP tick.
 *
 * The reflection model is resolved per-run via the injected provider factory
 * (config.models.evolution) so model choice stays centralized and picks up the
 * currently-available provider.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '../providers/types.js';
import type { SkillExecutor } from '../skills/executor.js';
import { SkillLoader } from '../skills/loader.js';
import { dirname } from 'path';
import type { EvolutionConfig } from './config.js';
import { SkillStore, type CuratorSummary, type SkillFiles, type SkillUsageEntry } from './skill-store.js';
import {
  runEvolutionOptimizer,
  type EvolutionSkillTargetState,
  type OptimizerDb,
  type OptimizerSummary,
} from './optimizer.js';
import { runRollbackWatchdog, type WatchdogDb, type WatchdogSummary } from './watchdog.js';

const OPTIMIZER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OPTIMIZER_TICK_KEY = 'evolution:lastEngineRunAt';

const SIGNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface EvolutionEngineDeps {
  db: OptimizerDb & WatchdogDb & {
    getRuntimeKey(k: string): string | null;
    setRuntimeKey(k: string, v: string): void;
    pruneEvolutionSignals(cutoffMs: number): number;
  };
  /** Resolves the current reflection provider (config.models.evolution). */
  resolveProvider: () => Promise<LLMProvider | undefined>;
  /** Optional independently-routed judge for holdout fitness evaluation. */
  resolveEvalProvider?: () => Promise<LLMProvider | undefined>;
  executor: SkillExecutor;
  reloadFromDisk: () => Promise<void>;
  /** Find the on-disk SKILL.md path of a live skill, for patch context. */
  getLiveSkillPath: (name: string) => string | undefined;
  /** Resolve registry source/executability for collision and patch ownership gates. */
  getLiveSkillMetadata: (name: string) => Omit<EvolutionSkillTargetState, 'createdBy'>;
  config: EvolutionConfig;
  /** Local skills dir the registry loads from (where promotions land). */
  localSkillsDir?: string;
  logger?: Logger;
}

export class EvolutionEngine {
  private readonly store: SkillStore;
  private readonly loader: SkillLoader;
  private readonly logger?: Logger;

  constructor(private readonly deps: EvolutionEngineDeps) {
    this.logger = deps.logger?.child({ component: 'evolution' });
    this.store = new SkillStore({ localDir: deps.localSkillsDir, logger: this.logger });
    // A standalone loader is enough for loadSkillFile(path) during verification.
    this.loader = new SkillLoader({}, this.logger);
  }

  /** Read the current files of a live skill (for patch context). */
  private loadCurrentSkillFiles = async (name: string): Promise<SkillFiles | null> => {
    const path = this.deps.getLiveSkillPath(name);
    if (!path) return null;
    const files = await this.store.readDir(dirname(path));
    return Object.keys(files).length > 0 ? files : null;
  };

  private resolveSkillTarget = async (name: string): Promise<EvolutionSkillTargetState> => {
    const registry = this.deps.getLiveSkillMetadata(name);
    const usage = await this.store.getUsage();
    const entry = usage[name];
    return {
      ...registry,
      // Archived curator skills are still existing names and must not be
      // silently recreated while a recoverable copy is retained.
      exists: registry.exists || !!entry,
      source: registry.source ?? (entry ? 'local' : undefined),
      createdBy: entry?.createdBy ?? null,
    };
  };

  /** Run the reflective optimizer (heavy). Returns null if not due yet (unless forced). */
  async runOptimizer(now: number = Date.now(), force = false): Promise<OptimizerSummary | null> {
    if (!this.deps.config.enabled) return null;
    const last = Number(this.deps.db.getRuntimeKey(OPTIMIZER_TICK_KEY) ?? 0);
    if (!force && now - last < OPTIMIZER_INTERVAL_MS) return null;

    const provider = await this.deps.resolveProvider();
    const evalProvider = this.deps.config.allowSeparateEvalProvider && this.deps.resolveEvalProvider
      ? await this.deps.resolveEvalProvider()
      : provider;
    const summary = await runEvolutionOptimizer({
      db: this.deps.db,
      provider,
      evalProvider,
      store: this.store,
      loader: this.loader,
      executor: this.deps.executor,
      reloadFromDisk: this.deps.reloadFromDisk,
      config: this.deps.config,
      loadCurrentSkillFiles: this.loadCurrentSkillFiles,
      resolveSkillTarget: this.resolveSkillTarget,
      logger: this.logger,
      now,
    });
    // Provider outages must not consume the daily opportunity or the signal
    // watermark. Retry on the next eligible background tick instead.
    if (!summary.skipped.includes('no_free_provider')) {
      this.deps.db.setRuntimeKey(OPTIMIZER_TICK_KEY, String(now));
    }
    // Housekeeping: drop signals older than the retention window.
    try {
      this.deps.db.pruneEvolutionSignals(now - SIGNAL_RETENTION_MS);
    } catch {
      // best-effort
    }
    this.logger?.info({ ...summary }, 'Evolution optimizer run complete');
    return summary;
  }

  /** Run the auto-rollback watchdog (cheap, no LLM). */
  async runWatchdog(now: number = Date.now()): Promise<WatchdogSummary> {
    return runRollbackWatchdog({
      db: this.deps.db,
      store: this.store,
      reloadFromDisk: this.deps.reloadFromDisk,
      config: this.deps.config,
      logger: this.logger,
      now,
    });
  }

  /** Usage hook supplied to SkillExecutor; serialized by SkillStore. */
  async recordSkillUse(name: string, now: number = Date.now()): Promise<void> {
    await this.store.recordUse(name, now);
  }

  /** Deterministic, recoverable lifecycle maintenance for agent-created skills. */
  async runCurator(now: number = Date.now()): Promise<CuratorSummary | null> {
    if (!this.deps.config.curatorEnabled) return null;
    const summary = await this.store.curate({
      now,
      staleAfterDays: this.deps.config.curatorStaleDays,
      archiveAfterDays: this.deps.config.curatorArchiveDays,
      backupKeep: this.deps.config.curatorBackupKeep,
    });
    if (summary.archived.length > 0) await this.deps.reloadFromDisk();
    this.logger?.info({ ...summary }, 'Evolution skill curator run complete');
    return summary;
  }

  async getSkillUsage(): Promise<Record<string, SkillUsageEntry>> {
    return this.store.getUsage();
  }

  async pinSkill(name: string, pinned = true): Promise<boolean> {
    return this.store.pin(name, pinned);
  }

  async restoreSkill(name: string, now: number = Date.now()): Promise<boolean> {
    const restored = await this.store.restoreArchived(name, now);
    if (restored) await this.deps.reloadFromDisk();
    return restored;
  }
}
