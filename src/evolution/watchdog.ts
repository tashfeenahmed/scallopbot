/**
 * Self-healing auto-rollback watchdog.
 *
 * "Fully autonomous" promotion has no human gate, so this is what makes it safe:
 * after a mutation goes live, we keep watching its target. If the target accrues
 * enough fresh skill_failure signals after promotion (≥ rollbackWindow), the
 * mutation is judged a regression and automatically reverted to its snapshot
 * (or deleted, if there was no prior version), then the registry is hot-reloaded.
 *
 * Runs cheaply (no LLM) on a periodic tick alongside the gardener.
 */

import type { Logger } from 'pino';
import type { SkillStore, SkillFiles } from './skill-store.js';
import type { EvolutionConfig } from './config.js';
import type { StoredEvolutionSignal } from './types.js';

export interface WatchdogDb {
  getActiveEvolutionVersions(): Array<{ id: number; target: string; kind: string; at: number; baselineFitness: number | null }>;
  getActiveEvolutionVersion(target: string): { id: number; target: string; kind: string; at: number; baselineFitness: number | null; snapshot: string | null } | null;
  getRecentEvolutionSignals(limit: number): Array<StoredEvolutionSignal>;
  markEvolutionVersionRolledBack(id: number): void;
  rollbackPromptOverride(fragmentId: string, restoreContent: string | null, at: number): void;
  recordEvolutionDecision(d: {
    at: number; stage: string; outcome: string; reason?: string | null; target?: string | null; detail?: Record<string, unknown> | null;
  }): void;
}

export interface WatchdogDeps {
  db: WatchdogDb;
  store: SkillStore;
  reloadFromDisk: () => Promise<void>;
  config: EvolutionConfig;
  logger?: Logger;
  now?: number;
}

export interface WatchdogSummary {
  checked: number;
  rolledBack: string[];
}

export async function runRollbackWatchdog(deps: WatchdogDeps): Promise<WatchdogSummary> {
  const now = deps.now ?? Date.now();
  const summary: WatchdogSummary = { checked: 0, rolledBack: [] };
  if (!deps.config.enabled) return summary;

  const active = deps.db.getActiveEvolutionVersions();
  if (active.length === 0) return summary;

  const signals = deps.db.getRecentEvolutionSignals(2000);

  for (const version of active) {
    summary.checked++;
    const isPrompt = version.kind === 'patch_prompt';

    // Regression metric differs by kind: prompts regress via continued low-quality
    // answers; skills via continued failures of that skill.
    const failures = isPrompt
      ? signals.filter(s => s.type === 'low_quality' && s.at > version.at).length
      : signals.filter(s => s.type === 'skill_failure' && s.targetSkill === version.target && s.at > version.at).length;

    if (failures < deps.config.rollbackWindow) continue;

    try {
      if (isPrompt) {
        // target is 'prompt:<fragmentId>'. Restore prior content (or clear).
        const fragmentId = version.target.replace(/^prompt:/, '');
        const full = deps.db.getActiveEvolutionVersion(version.target);
        let restore: string | null = null;
        if (full?.snapshot) {
          try {
            restore = (JSON.parse(full.snapshot) as { content?: string }).content ?? null;
          } catch {
            restore = null;
          }
        }
        deps.db.rollbackPromptOverride(fragmentId, restore, now);
      } else {
        // Skill: restore the snapshot files (or delete if there was none).
        const full = deps.db.getActiveEvolutionVersion(version.target);
        let snapshot: SkillFiles | null = null;
        if (full?.snapshot) {
          try {
            snapshot = JSON.parse(full.snapshot) as SkillFiles;
          } catch {
            snapshot = null;
          }
        }
        await deps.store.rollback(version.target, snapshot);
        await deps.reloadFromDisk();
      }
      deps.db.markEvolutionVersionRolledBack(version.id);
      deps.db.recordEvolutionDecision({
        at: now, stage: 'rollback', outcome: 'rolled_back', reason: 'regressed', target: version.target,
        detail: { failuresSincePromotion: failures, kind: version.kind },
      });
      summary.rolledBack.push(version.target);
      deps.logger?.warn?.({ target: version.target, failures }, 'Evolution: auto-rolled-back a regressing mutation');
    } catch (e) {
      deps.db.recordEvolutionDecision({
        at: now, stage: 'rollback', outcome: 'failed', reason: 'rollback_failed', target: version.target,
        detail: { why: (e as Error).message },
      });
    }
  }

  return summary;
}
