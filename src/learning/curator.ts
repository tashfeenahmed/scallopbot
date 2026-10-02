/**
 * Nightly skill curator, independent of the evolution optimizer.
 *
 * The SkillStore already tracks usage/provenance (.usage.json: useCount,
 * lastUsedAt, lastPatchedAt, createdBy, pinned) and can recoverably archive.
 * Until now it only ran through EvolutionEngine.runCurator(), i.e. only when
 * EVOLUTION_ENABLED=true, yet the learning loop creates skills either way.
 * This module runs the same deterministic curation from the gardener sleep tick:
 *
 *   - only agent-created skills are touched (bundled/user/workspace exempt)
 *   - pinned skills are exempt
 *   - unused for staleAfterDays → marked stale; for archiveAfterDays (30) →
 *     moved to <skills>/.archive after a backup (restorable)
 *
 * Usage counts come from load_procedure (onUse) and the skill executor's
 * onSkillExecuted hook; record them with recordSkillUse().
 */

import type { Logger } from 'pino';
import { SkillStore, type CuratorSummary } from '../evolution/skill-store.js';

export const CURATOR_ARCHIVE_DAYS = 30;
export const CURATOR_STALE_DAYS = 14;
const CURATOR_INTERVAL_MS = 20 * 60 * 60 * 1000;
const CURATOR_TICK_KEY = 'curator:lastRunAt';

export interface SkillCuratorOptions {
  store?: SkillStore;
  localSkillsDir?: string;
  reloadFromDisk: () => Promise<void>;
  enabled?: boolean;
  staleAfterDays?: number;
  archiveAfterDays?: number;
  backupKeep?: number;
  /** Optional persistence so restarts don't re-run within the same night. */
  runtimeKeys?: { getRuntimeKey(key: string): string | null; setRuntimeKey(key: string, value: string): void };
  logger?: Logger;
}

export class SkillCurator {
  readonly store: SkillStore;

  constructor(private readonly options: SkillCuratorOptions) {
    this.store = options.store ?? new SkillStore({ localDir: options.localSkillsDir, logger: options.logger });
  }

  /** Usage hook for load_procedure / the skill executor. Best effort. */
  async recordSkillUse(name: string, now: number = Date.now()): Promise<void> {
    try {
      await this.store.recordUse(name, now);
    } catch (error) {
      this.options.logger?.debug({ skill: name, error: (error as Error).message }, 'Skill usage record failed');
    }
  }

  /**
   * Run once per night (sleep tick). Returns null when disabled or already run
   * within the last ~20h (unless forced).
   */
  async runNightly(now: number = Date.now(), force = false): Promise<CuratorSummary | null> {
    if (this.options.enabled === false) return null;
    const keys = this.options.runtimeKeys;
    if (!force && keys) {
      const last = Number(keys.getRuntimeKey(CURATOR_TICK_KEY) ?? 0);
      if (now - last < CURATOR_INTERVAL_MS) return null;
    }
    const summary = await this.store.curate({
      now,
      staleAfterDays: this.options.staleAfterDays ?? CURATOR_STALE_DAYS,
      archiveAfterDays: this.options.archiveAfterDays ?? CURATOR_ARCHIVE_DAYS,
      backupKeep: this.options.backupKeep ?? 5,
    });
    keys?.setRuntimeKey(CURATOR_TICK_KEY, String(now));
    if (summary.archived.length > 0) await this.options.reloadFromDisk();
    this.options.logger?.info({ ...summary }, 'Skill curator run complete');
    return summary;
  }
}
