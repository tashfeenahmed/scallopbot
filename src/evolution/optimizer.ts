/**
 * Layer 2 — the nightly self-evolution optimizer (skills only, P2).
 *
 * Pipeline:  harvest → cluster → reflect → stage → verify → promote
 * Each step appends an EvolutionDecision for the why-evolution diagnostic. The
 * loop is fully autonomous: a mutation that clears every automatic verify gate is
 * promoted live (registry hot-reload) with the prior version snapshotted, so the
 * runtime auto-rollback watchdog (see watchdog.ts) can heal a regression later.
 *
 * Reprocessing is bounded by a runtime_keys watermark: only signals newer than
 * the last run are harvested.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '../providers/types.js';
import type { SkillLoader } from '../skills/loader.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { EvolutionConfig } from './config.js';
import type { StoredEvolutionSignal, SkillFiles } from './types.js';
import { SkillStore } from './skill-store.js';
import { reflectOnCluster, reflectOnPromptCluster, type SignalCluster } from './reflect.js';
import { verifyMutation } from './verify.js';
import { judgeMutation, describeMutationForJudge } from './judge.js';

const WATERMARK_KEY = 'evolution:lastOptimizedAt';
/** A skill needs at least this many failure signals before it's worth patching. */
const MIN_FAILURES_TO_PATCH = 2;
/** Reusable-task signals needed before proposing a brand-new skill. */
const MIN_REUSABLE_TO_CREATE = 3;
/** Low-quality signals needed before proposing a learned-guidance prompt fragment. */
const MIN_LOW_QUALITY_TO_PATCH_PROMPT = 3;
/** The single prompt fragment the optimizer maintains. */
const PROMPT_FRAGMENT_ID = 'learned_guidance';

export interface OptimizerDb {
  getRecentEvolutionSignals(limit: number): Array<StoredEvolutionSignal>;
  recordEvolutionDecision(d: {
    at: number; stage: string; outcome: string; reason?: string | null; target?: string | null; detail?: Record<string, unknown> | null;
  }): void;
  recordEvolutionVersion(v: {
    target: string; kind: string; at: number; baselineFitness?: number | null; snapshot?: string | null; detail?: Record<string, unknown> | null;
  }): number;
  getActivePromptOverride(fragmentId: string): { content: string; version: number } | null;
  upsertPromptOverride(fragmentId: string, content: string, at: number): number;
  getRuntimeKey(key: string): string | null;
  setRuntimeKey(key: string, value: string): void;
}

export interface OptimizerDeps {
  db: OptimizerDb;
  provider: LLMProvider | undefined;
  store: SkillStore;
  loader: SkillLoader;
  executor: SkillExecutor;
  reloadFromDisk: () => Promise<void>;
  config: EvolutionConfig;
  /** Optional: current files of a live skill (for patch context). */
  loadCurrentSkillFiles?: (name: string) => Promise<SkillFiles | null>;
  logger?: Logger;
  now?: number;
}

export interface OptimizerSummary {
  proposed: number;
  promoted: number;
  rejected: number;
  skipped: string[];
}

/** Group new signals into reflection clusters (patches per failing skill + one create candidate). */
export function clusterSignals(signals: StoredEvolutionSignal[], max: number): SignalCluster[] {
  const clusters: SignalCluster[] = [];

  // Patch clusters: one per skill with enough failures.
  const bySkill = new Map<string, StoredEvolutionSignal[]>();
  for (const s of signals) {
    if (s.type === 'skill_failure' && s.targetSkill) {
      const arr = bySkill.get(s.targetSkill) ?? [];
      arr.push(s);
      bySkill.set(s.targetSkill, arr);
    }
  }
  for (const [skill, sigs] of bySkill) {
    if (sigs.length >= MIN_FAILURES_TO_PATCH) {
      clusters.push({ key: skill, intent: 'patch_skill', signals: sigs });
    }
  }

  // Create cluster: enough reusable-task evidence → propose one new skill.
  const reusable = signals.filter(s => s.type === 'reusable_task');
  if (reusable.length >= MIN_REUSABLE_TO_CREATE) {
    clusters.push({ key: 'new-skill', intent: 'create_skill', signals: reusable });
  }

  // Prompt cluster: enough low-quality answers → propose learned guidance.
  const lowQuality = signals.filter(s => s.type === 'low_quality');
  if (lowQuality.length >= MIN_LOW_QUALITY_TO_PATCH_PROMPT) {
    clusters.push({ key: PROMPT_FRAGMENT_ID, intent: 'patch_prompt', signals: lowQuality });
  }

  // Highest-evidence clusters first, capped.
  clusters.sort((a, b) => b.signals.length - a.signals.length);
  return clusters.slice(0, max);
}

export async function runEvolutionOptimizer(deps: OptimizerDeps): Promise<OptimizerSummary> {
  const now = deps.now ?? Date.now();
  const summary: OptimizerSummary = { proposed: 0, promoted: 0, rejected: 0, skipped: [] };
  const decide = (stage: string, outcome: string, extra: { reason?: string; target?: string; detail?: Record<string, unknown> } = {}) =>
    deps.db.recordEvolutionDecision({ at: now, stage, outcome, reason: extra.reason ?? null, target: extra.target ?? null, detail: extra.detail ?? null });

  if (!deps.config.enabled) {
    decide('harvest', 'skipped', { reason: 'disabled' });
    summary.skipped.push('disabled');
    return summary;
  }

  // --- Harvest (watermark-bounded) ---
  const watermark = Number(deps.db.getRuntimeKey(WATERMARK_KEY) ?? 0);
  const all = deps.db.getRecentEvolutionSignals(2000);
  const fresh = all.filter(s => s.at > watermark);
  if (fresh.length === 0) {
    decide('harvest', 'skipped', { reason: 'no_signals' });
    deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
    summary.skipped.push('no_signals');
    return summary;
  }

  const clusters = clusterSignals(fresh, deps.config.maxProposals);
  decide('harvest', 'harvested', { detail: { freshSignals: fresh.length, clusters: clusters.length } });

  if (!deps.provider) {
    decide('reflect', 'skipped', { reason: 'no_free_provider' });
    deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
    summary.skipped.push('no_free_provider');
    return summary;
  }

  // --- Per-cluster: reflect → stage → verify → promote ---
  for (const cluster of clusters) {
    // Prompt mutations take a separate, lighter path (no disk staging / smoke test).
    if (cluster.intent === 'patch_prompt') {
      const pm = await reflectOnPromptCluster(cluster, deps.provider);
      if (!pm) {
        decide('reflect', 'skipped', { reason: 'reflect_failed', target: `prompt:${cluster.key}` });
        continue;
      }
      summary.proposed++;
      decide('reflect', 'proposed', { target: `prompt:${pm.fragmentId}`, detail: { kind: pm.kind, rationale: pm.rationale.slice(0, 300) } });
      if (deps.config.useLlmJudge) {
        const verdict = await judgeMutation(describeMutationForJudge('patch_prompt', pm.fragmentId, pm.content), deps.provider);
        if (!verdict.approved) {
          decide('verify', 'rejected', { reason: 'judge_rejected', target: `prompt:${pm.fragmentId}`, detail: { judge: verdict.reason } });
          summary.rejected++;
          continue;
        }
      }
      try {
        const prior = deps.db.getActivePromptOverride(pm.fragmentId);
        deps.db.upsertPromptOverride(pm.fragmentId, pm.content, now);
        deps.db.recordEvolutionVersion({
          target: `prompt:${pm.fragmentId}`,
          kind: 'patch_prompt',
          at: now,
          snapshot: prior ? JSON.stringify({ content: prior.content }) : null,
          detail: { rationale: pm.rationale.slice(0, 300) },
        });
        decide('promote', 'promoted', { target: `prompt:${pm.fragmentId}`, detail: { kind: 'patch_prompt', hadPrior: !!prior } });
        summary.promoted++;
      } catch (e) {
        decide('promote', 'failed', { reason: 'promote_failed', target: `prompt:${pm.fragmentId}`, detail: { why: (e as Error).message } });
        summary.rejected++;
      }
      continue;
    }

    // Provide current files for patch context when available.
    if (cluster.intent === 'patch_skill' && deps.loadCurrentSkillFiles) {
      cluster.currentFiles = (await deps.loadCurrentSkillFiles(cluster.key)) ?? undefined;
    }

    const mutation = await reflectOnCluster(cluster, deps.provider);
    if (!mutation) {
      decide('reflect', 'skipped', { reason: 'reflect_failed', target: cluster.key });
      continue;
    }
    summary.proposed++;
    decide('reflect', 'proposed', { target: mutation.target, detail: { kind: mutation.kind, rationale: mutation.rationale.slice(0, 300) } });

    // Stage on disk (never live until promoted).
    let stagedPath: string;
    try {
      stagedPath = await deps.store.stage(mutation.target, mutation.files);
    } catch (e) {
      decide('verify', 'rejected', { reason: 'parse_failed', target: mutation.target, detail: { why: `stage failed: ${(e as Error).message}` } });
      summary.rejected++;
      continue;
    }

    // Verify.
    const smokeArgs = (cluster.signals[0]?.detail?.args as Record<string, unknown> | undefined) ?? {};
    const verdict = await verifyMutation(mutation, {
      loader: deps.loader,
      executor: deps.executor,
      stagedSkillMdPath: stagedPath,
      smokeArgs,
      logger: deps.logger,
    });
    if (!verdict.ok) {
      await deps.store.discardStaged(mutation.target);
      decide('verify', 'rejected', { reason: verdict.reason, target: mutation.target, detail: verdict.detail });
      summary.rejected++;
      continue;
    }
    decide('verify', 'verified', { target: mutation.target, detail: verdict.detail });

    // Optional adversarial safety judge before going live.
    if (deps.config.useLlmJudge) {
      const jv = await judgeMutation(describeMutationForJudge(mutation.kind, mutation.target, mutation.files['SKILL.md'] ?? ''), deps.provider);
      if (!jv.approved) {
        await deps.store.discardStaged(mutation.target);
        decide('verify', 'rejected', { reason: 'judge_rejected', target: mutation.target, detail: { judge: jv.reason } });
        summary.rejected++;
        continue;
      }
    }

    // Promote: snapshot prior version, move staged → live, hot-reload.
    try {
      const snapshot = await deps.store.snapshotLive(mutation.target);
      await deps.store.promote(mutation.target);
      await deps.reloadFromDisk();
      deps.db.recordEvolutionVersion({
        target: mutation.target,
        kind: mutation.kind,
        at: now,
        snapshot: snapshot ? JSON.stringify(snapshot) : null,
        detail: { rationale: mutation.rationale.slice(0, 300) },
      });
      decide('promote', 'promoted', { target: mutation.target, detail: { kind: mutation.kind, hadPrior: !!snapshot } });
      summary.promoted++;
    } catch (e) {
      await deps.store.discardStaged(mutation.target);
      decide('promote', 'failed', { reason: 'promote_failed', target: mutation.target, detail: { why: (e as Error).message } });
      summary.rejected++;
    }
  }

  deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
  return summary;
}
