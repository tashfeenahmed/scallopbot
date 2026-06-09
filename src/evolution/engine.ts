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
import { SkillStore, type SkillFiles } from './skill-store.js';
import { runEvolutionOptimizer, type OptimizerDb, type OptimizerSummary } from './optimizer.js';
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
  executor: SkillExecutor;
  reloadFromDisk: () => Promise<void>;
  /** Find the on-disk SKILL.md path of a live skill, for patch context. */
  getLiveSkillPath: (name: string) => string | undefined;
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

  /** Run the reflective optimizer (heavy). Returns null if not due yet (unless forced). */
  async runOptimizer(now: number = Date.now(), force = false): Promise<OptimizerSummary | null> {
    if (!this.deps.config.enabled) return null;
    const last = Number(this.deps.db.getRuntimeKey(OPTIMIZER_TICK_KEY) ?? 0);
    if (!force && now - last < OPTIMIZER_INTERVAL_MS) return null;
    this.deps.db.setRuntimeKey(OPTIMIZER_TICK_KEY, String(now));

    const provider = await this.deps.resolveProvider();
    const summary = await runEvolutionOptimizer({
      db: this.deps.db,
      provider,
      store: this.store,
      loader: this.loader,
      executor: this.deps.executor,
      reloadFromDisk: this.deps.reloadFromDisk,
      config: this.deps.config,
      loadCurrentSkillFiles: this.loadCurrentSkillFiles,
      logger: this.logger,
      now,
    });
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
}
