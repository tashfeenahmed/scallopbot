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
import { evaluateArtifactFitness, type FitnessCase } from './fitness.js';
import { findUnsafeEvolutionContentReason, sanitizeEvolutionEvidence } from './privacy.js';

const WATERMARK_KEY = 'evolution:lastOptimizedAt';
const PENDING_SIGNAL_IDS_KEY = 'evolution:pendingSignalIds';
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
  /** Atomically activate prompt content and write/supersede its rollback ledger. */
  promotePromptEvolution(input: {
    fragmentId: string;
    content: string;
    at: number;
    baselineFitness?: number | null;
    snapshot?: string | null;
    detail?: Record<string, unknown> | null;
  }): { promptVersion: number; evolutionVersionId: number };
  getRuntimeKey(key: string): string | null;
  setRuntimeKey(key: string, value: string): void;
  /** Optional trajectory hydration; the optimizer degrades to signal previews. */
  getSessionMessages?(sessionId: string): Array<{ id?: number; role: string; content: string; created_at?: number }>;
}

export interface EvolutionSkillTargetState {
  exists: boolean;
  source?: 'workspace' | 'local' | 'bundled' | 'sdk';
  hasScripts?: boolean;
  createdBy?: 'agent' | 'user' | null;
}

export interface OptimizerDeps {
  db: OptimizerDb;
  provider: LLMProvider | undefined;
  /** Prefer a separately-routed evaluator to reduce proposer/judge coupling. */
  evalProvider?: LLMProvider;
  store: SkillStore;
  loader: SkillLoader;
  executor: SkillExecutor;
  reloadFromDisk: () => Promise<void>;
  config: EvolutionConfig;
  /** Optional: current files of a live skill (for patch context). */
  loadCurrentSkillFiles?: (name: string) => Promise<SkillFiles | null>;
  /** Registry + provenance lookup. Missing/erroring resolvers fail closed. */
  resolveSkillTarget?: (name: string) => Promise<EvolutionSkillTargetState>;
  logger?: Logger;
  now?: number;
}

export interface OptimizerSummary {
  proposed: number;
  promoted: number;
  rejected: number;
  skipped: string[];
}

export interface ClusterSplit {
  training: StoredEvolutionSignal[];
  holdout: StoredEvolutionSignal[];
}

/** Deterministically withhold roughly one third of evidence for promotion scoring. */
export function splitSignalsForHoldout(signals: StoredEvolutionSignal[]): ClusterSplit {
  if (signals.length <= 1) return { training: signals, holdout: signals };
  const holdoutCount = Math.max(1, Math.floor(signals.length / 3));
  return {
    training: signals.slice(holdoutCount),
    holdout: signals.slice(0, holdoutCount),
  };
}

function scrubTrajectory(text: string): string {
  return sanitizeEvolutionEvidence(text);
}

function getTrajectory(
  db: OptimizerDb,
  signal: StoredEvolutionSignal,
  includeSessionContent: boolean,
): string | undefined {
  if (!includeSessionContent || !signal.sessionId || !db.getSessionMessages) return undefined;
  try {
    const messages = db.getSessionMessages(signal.sessionId).slice(-6);
    if (messages.length === 0) return undefined;
    return scrubTrajectory(messages.map(message => `${message.role}: ${message.content}`).join('\n'));
  } catch {
    return undefined;
  }
}

function fitnessCases(
  db: OptimizerDb,
  signals: StoredEvolutionSignal[],
  includeSessionContent: boolean,
): FitnessCase[] {
  return signals.map((signal, index) => {
    const trajectory = getTrajectory(db, signal, includeSessionContent);
    const preview = includeSessionContent && typeof signal.detail?.preview === 'string'
      ? sanitizeEvolutionEvidence(signal.detail.preview)
      : '';
    return {
      id: `signal-${signal.id ?? index}`,
      task: trajectory || preview || `${signal.type} improvement case`,
      observed: scrubTrajectory(JSON.stringify({
        signal: signal.type,
        targetSkill: signal.targetSkill ?? undefined,
        criticScore: signal.criticScore ?? undefined,
        toolCallCount: signal.toolCallCount ?? undefined,
      })),
    };
  });
}

/** Remove content captured under earlier consent when consent is now revoked. */
function signalForReflection(
  signal: StoredEvolutionSignal,
  includeSessionContent: boolean,
): StoredEvolutionSignal {
  if (includeSessionContent) {
    const preview = typeof signal.detail?.preview === 'string'
      ? sanitizeEvolutionEvidence(signal.detail.preview)
      : undefined;
    // Unknown detail fields may have been captured by an older release. Only
    // the explicitly redacted preview is eligible for provider disclosure.
    return { ...signal, detail: preview ? { preview } : null };
  }
  return { ...signal, sessionId: null, detail: null };
}

async function resolveSkillTarget(
  deps: OptimizerDeps,
  name: string,
): Promise<EvolutionSkillTargetState | null> {
  if (!deps.resolveSkillTarget) return null;
  try {
    return await deps.resolveSkillTarget(name);
  } catch {
    return null;
  }
}

async function resolveCurrentSkillFiles(
  deps: OptimizerDeps,
  name: string,
): Promise<SkillFiles | null> {
  if (!deps.loadCurrentSkillFiles) return null;
  try {
    return await deps.loadCurrentSkillFiles(name);
  } catch {
    return null;
  }
}

function isCuratorOwnedDocumentationSkill(state: EvolutionSkillTargetState | null): boolean {
  return !!state
    && state.exists
    && state.source === 'local'
    && state.hasScripts === false
    && state.createdBy === 'agent';
}

function artifactText(files: SkillFiles | null | undefined): string {
  if (!files) return '';
  if (typeof files['SKILL.md'] === 'string' && Object.keys(files).length === 1) {
    return files['SKILL.md'];
  }
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n\n');
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
  if (!deps.config.requireFitnessGate) {
    decide('verify', 'rejected', { reason: 'fitness_gate_required' });
    summary.skipped.push('fitness_gate_required');
    return summary;
  }

  // --- Harvest (watermark-bounded) ---
  const watermark = Number(deps.db.getRuntimeKey(WATERMARK_KEY) ?? 0);
  const all = deps.db.getRecentEvolutionSignals(2000);
  let pendingIds = new Set<number>();
  try {
    const parsed = JSON.parse(deps.db.getRuntimeKey(PENDING_SIGNAL_IDS_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      pendingIds = new Set(parsed.filter((id): id is number => Number.isInteger(id) && id > 0));
    }
  } catch {
    // A malformed optional backlog must not stop optimization.
  }
  const candidates = all.filter(signal => signal.at > watermark || pendingIds.has(signal.id));
  if (candidates.length === 0) {
    decide('harvest', 'skipped', { reason: 'no_signals' });
    deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
    deps.db.setRuntimeKey(PENDING_SIGNAL_IDS_KEY, '[]');
    summary.skipped.push('no_signals');
    return summary;
  }

  const clusters = clusterSignals(candidates, deps.config.maxProposals);
  const clusteredIds = new Set(clusters.flatMap(cluster => cluster.signals.map(signal => signal.id)));
  const unclusteredIds = candidates
    .filter(signal => !clusteredIds.has(signal.id))
    .map(signal => signal.id)
    .slice(-2000);
  const deferredSignalIds = new Set(unclusteredIds);
  decide('harvest', 'harvested', {
    detail: { candidateSignals: candidates.length, pendingSignals: pendingIds.size, clusters: clusters.length },
  });

  // Preserve sub-threshold evidence across nightly watermarks. Without this,
  // one reusable workflow observed on three different nights never reached the
  // three-example creation threshold because every pass discarded the prior one.
  if (clusters.length === 0) {
    deps.db.setRuntimeKey(PENDING_SIGNAL_IDS_KEY, JSON.stringify(unclusteredIds));
    deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
    decide('harvest', 'skipped', { reason: 'insufficient_evidence', detail: { pendingSignals: unclusteredIds.length } });
    summary.skipped.push('insufficient_evidence');
    return summary;
  }

  // Creating a new procedure or global prompt without any task excerpt gives
  // the proposer no semantic grounding and risks a generic/hallucinated rule.
  // Keep the evidence pending until the operator explicitly enables redacted
  // task/session content. Existing-skill failure patches remain possible from
  // the target skill's current files alone.
  const runnableClusters = clusters.filter(cluster => {
    if (deps.config.includeSessionContent || cluster.intent === 'patch_skill') return true;
    for (const signal of cluster.signals) deferredSignalIds.add(signal.id);
    decide('reflect', 'skipped', {
      reason: 'content_consent_required',
      target: cluster.key,
      detail: { signalsRetained: cluster.signals.length },
    });
    return false;
  });
  if (runnableClusters.length === 0) {
    deps.db.setRuntimeKey(PENDING_SIGNAL_IDS_KEY, JSON.stringify([...deferredSignalIds].slice(-2000)));
    deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
    summary.skipped.push('content_consent_required');
    return summary;
  }

  if (!deps.provider) {
    decide('reflect', 'skipped', { reason: 'no_free_provider' });
    summary.skipped.push('no_free_provider');
    return summary;
  }

  // --- Per-cluster: reflect → stage → verify → promote ---
  for (const cluster of runnableClusters) {
    const split = splitSignalsForHoldout(cluster.signals);
    const reflectionCluster: SignalCluster = {
      ...cluster,
      signals: split.training.map(signal =>
        signalForReflection(signal, deps.config.includeSessionContent)),
      trajectories: split.training
        .map(signal => getTrajectory(deps.db, signal, deps.config.includeSessionContent))
        .filter((trajectory): trajectory is string => !!trajectory),
    };
    const holdoutCases = fitnessCases(deps.db, split.holdout, deps.config.includeSessionContent);

    // Autonomous patches are restricted to local, curator-owned documentation
    // skills. Bundled/native/user/executable targets are immutable here.
    if (cluster.intent === 'patch_skill') {
      const targetState = await resolveSkillTarget(deps, cluster.key);
      if (!isCuratorOwnedDocumentationSkill(targetState)) {
        decide('verify', 'rejected', {
          reason: targetState ? 'protected_patch_target' : 'target_resolution_failed',
          target: cluster.key,
          detail: targetState ? { ...targetState } : { why: 'target provenance unavailable' },
        });
        summary.rejected++;
        continue;
      }
      if (!deps.loadCurrentSkillFiles) {
        decide('verify', 'rejected', {
          reason: 'target_resolution_failed',
          target: cluster.key,
          detail: { why: 'current files resolver unavailable' },
        });
        summary.rejected++;
        continue;
      }
      reflectionCluster.currentFiles = (await resolveCurrentSkillFiles(deps, cluster.key)) ?? undefined;
      if (!reflectionCluster.currentFiles?.['SKILL.md']) {
        decide('verify', 'rejected', {
          reason: 'target_resolution_failed',
          target: cluster.key,
          detail: { why: 'current documentation skill could not be loaded' },
        });
        summary.rejected++;
        continue;
      }
      const currentVerdict = await verifyMutation({
        kind: 'patch_skill',
        target: cluster.key,
        rationale: 'current baseline validation',
        files: reflectionCluster.currentFiles,
      }, {});
      if (!currentVerdict.ok) {
        decide('verify', 'rejected', {
          reason: 'protected_patch_target',
          target: cluster.key,
          detail: { why: 'current artifact is outside the documentation-only boundary', gate: currentVerdict.reason },
        });
        summary.rejected++;
        continue;
      }
    }

    // Prompt mutations take a separate, lighter path (no disk staging / smoke test).
    if (cluster.intent === 'patch_prompt') {
      const pm = await reflectOnPromptCluster(reflectionCluster, deps.provider);
      if (!pm) {
        decide('reflect', 'skipped', { reason: 'reflect_failed', target: `prompt:${cluster.key}` });
        continue;
      }
      summary.proposed++;
      decide('reflect', 'proposed', { target: `prompt:${pm.fragmentId}`, detail: { kind: pm.kind, rationale: pm.rationale.slice(0, 300) } });
      const prior = deps.db.getActivePromptOverride(pm.fragmentId);
      const fitness = await evaluateArtifactFitness({
        kind: 'prompt',
        target: pm.fragmentId,
        baseline: prior?.content ?? '',
        candidate: pm.content,
      }, holdoutCases, deps.evalProvider ?? deps.provider, deps.config.fitnessEpsilon);
      if (!fitness.passed) {
        decide('verify', 'rejected', {
          reason: 'fitness_failed',
          target: `prompt:${pm.fragmentId}`,
          detail: { baseline: fitness.baseline, candidate: fitness.candidate, delta: fitness.delta, samples: fitness.samples, why: fitness.reason },
        });
        summary.rejected++;
        continue;
      }
      if (deps.config.useLlmJudge) {
        const verdict = await judgeMutation(describeMutationForJudge('patch_prompt', pm.fragmentId, pm.content), deps.provider);
        if (!verdict.approved) {
          decide('verify', 'rejected', { reason: 'judge_rejected', target: `prompt:${pm.fragmentId}`, detail: { judge: verdict.reason } });
          summary.rejected++;
          continue;
        }
      }
      try {
        deps.db.promotePromptEvolution({
          fragmentId: pm.fragmentId,
          content: pm.content,
          at: now,
          baselineFitness: fitness?.baseline ?? null,
          snapshot: prior ? JSON.stringify({ content: prior.content }) : null,
          detail: { rationale: pm.rationale.slice(0, 300), fitness },
        });
        decide('promote', 'promoted', { target: `prompt:${pm.fragmentId}`, detail: { kind: 'patch_prompt', hadPrior: !!prior } });
        summary.promoted++;
      } catch (e) {
        decide('promote', 'failed', { reason: 'promote_failed', target: `prompt:${pm.fragmentId}`, detail: { why: (e as Error).message } });
        summary.rejected++;
      }
      continue;
    }

    const mutation = await reflectOnCluster(reflectionCluster, deps.provider);
    if (!mutation) {
      decide('reflect', 'skipped', { reason: 'reflect_failed', target: cluster.key });
      continue;
    }
    summary.proposed++;
    const unsafeRationale = findUnsafeEvolutionContentReason(mutation.rationale);
    if (unsafeRationale) {
      decide('verify', 'rejected', {
        reason: unsafeRationale.startsWith('personal data:') ? 'privacy_failed' : 'safety_failed',
        target: mutation.target,
        detail: { why: 'mutation rationale failed deterministic content checks' },
      });
      summary.rejected++;
      continue;
    }
    decide('reflect', 'proposed', { target: mutation.target, detail: { kind: mutation.kind, rationale: mutation.rationale.slice(0, 300) } });

    if (cluster.intent === 'patch_skill' && mutation.target !== cluster.key) {
      decide('verify', 'rejected', {
        reason: 'target_mismatch',
        target: mutation.target,
        detail: { expected: cluster.key },
      });
      summary.rejected++;
      continue;
    }
    if (cluster.intent === 'create_skill') {
      const targetState = await resolveSkillTarget(deps, mutation.target);
      if (!targetState) {
        decide('verify', 'rejected', {
          reason: 'target_resolution_failed',
          target: mutation.target,
          detail: { why: 'skill existence resolver unavailable' },
        });
        summary.rejected++;
        continue;
      }
      if (targetState.exists) {
        decide('verify', 'rejected', {
          reason: 'target_collision',
          target: mutation.target,
          detail: { ...targetState },
        });
        summary.rejected++;
        continue;
      }
    }

    // Deterministic verification includes the strict documentation-only shape,
    // artifact cap, and complete-content privacy/secret/injection scan.
    const verdict = await verifyMutation(mutation, {});
    if (!verdict.ok) {
      decide('verify', 'rejected', { reason: verdict.reason, target: mutation.target, detail: verdict.detail });
      summary.rejected++;
      continue;
    }

    // The verified artifact is small enough to review in full: no truncation.
    if (deps.config.useLlmJudge) {
      const jv = await judgeMutation(
        describeMutationForJudge(mutation.kind, mutation.target, artifactText(mutation.files)),
        deps.provider,
      );
      if (!jv.approved) {
        decide('verify', 'rejected', { reason: 'judge_rejected', target: mutation.target, detail: { judge: jv.reason } });
        summary.rejected++;
        continue;
      }
    }
    decide('verify', 'verified', { target: mutation.target, detail: verdict.detail });

    // Holdout A/B fitness gate: a syntactically valid mutation still has to
    // demonstrate an improvement over the frozen baseline.
    const fitness = await evaluateArtifactFitness({
      kind: 'skill',
      target: mutation.target,
      baseline: artifactText(reflectionCluster.currentFiles),
      candidate: artifactText(mutation.files),
    }, holdoutCases, deps.evalProvider ?? deps.provider, deps.config.fitnessEpsilon);
    if (!fitness.passed) {
      decide('verify', 'rejected', {
        reason: 'fitness_failed',
        target: mutation.target,
        detail: { baseline: fitness.baseline, candidate: fitness.candidate, delta: fitness.delta, samples: fitness.samples, why: fitness.reason },
      });
      summary.rejected++;
      continue;
    }
    decide('verify', 'fitness_passed', {
      target: mutation.target,
      detail: { baseline: fitness.baseline, candidate: fitness.candidate, delta: fitness.delta, samples: fitness.samples },
    });

    // Close the LLM-evaluation race: registry/provenance may change while the
    // judge and fitness calls are running. Never shadow a newly installed skill
    // or overwrite a patch target whose ownership/content changed mid-flight.
    const latestTarget = await resolveSkillTarget(deps, mutation.target);
    if (mutation.kind === 'create_skill' && (!latestTarget || latestTarget.exists)) {
      decide('verify', 'rejected', {
        reason: latestTarget ? 'target_collision' : 'target_resolution_failed',
        target: mutation.target,
        detail: latestTarget ? { ...latestTarget } : { why: 'final target resolution failed' },
      });
      summary.rejected++;
      continue;
    }
    if (mutation.kind === 'patch_skill') {
      const latestFiles = await resolveCurrentSkillFiles(deps, mutation.target);
      if (
        !isCuratorOwnedDocumentationSkill(latestTarget)
        || !latestFiles
        || artifactText(latestFiles) !== artifactText(reflectionCluster.currentFiles)
      ) {
        decide('verify', 'rejected', {
          reason: 'patch_target_changed',
          target: mutation.target,
        });
        summary.rejected++;
        continue;
      }
    }

    // Stage only after every content/evaluation gate has passed.
    try {
      await deps.store.stage(mutation.target, mutation.files);
    } catch (e) {
      decide('verify', 'rejected', { reason: 'parse_failed', target: mutation.target, detail: { why: `stage failed: ${(e as Error).message}` } });
      summary.rejected++;
      continue;
    }

    // Promote: snapshot prior version, move staged → live, hot-reload.
    const snapshot = await deps.store.snapshotLive(mutation.target);
    let liveFilesReplaced = false;
    try {
      await deps.store.promote(mutation.target);
      liveFilesReplaced = true;
      await deps.reloadFromDisk();
      deps.db.recordEvolutionVersion({
        target: mutation.target,
        kind: mutation.kind,
        at: now,
        baselineFitness: fitness?.baseline ?? null,
        snapshot: snapshot ? JSON.stringify(snapshot) : null,
        detail: { rationale: mutation.rationale.slice(0, 300), fitness },
      });
      decide('promote', 'promoted', { target: mutation.target, detail: { kind: mutation.kind, hadPrior: !!snapshot } });
      summary.promoted++;
    } catch (e) {
      await deps.store.discardStaged(mutation.target);
      if (liveFilesReplaced) {
        try {
          await deps.store.rollback(mutation.target, snapshot);
          await deps.reloadFromDisk();
        } catch (rollbackError) {
          decide('rollback', 'failed', {
            reason: 'promotion_compensation_failed',
            target: mutation.target,
            detail: { why: (rollbackError as Error).message },
          });
        }
      }
      decide('promote', 'failed', { reason: 'promote_failed', target: mutation.target, detail: { why: (e as Error).message } });
      summary.rejected++;
      continue;
    }

    // Usage/provenance is observability, not part of the file+registry commit.
    // A sidecar write failure must never turn a successful promotion into an
    // unreported half-failure or leave the live state inconsistent.
    try {
      await deps.store.markAgentCreated(
        mutation.target,
        mutation.kind === 'patch_skill' ? 'patch' : 'create',
        now,
      );
    } catch (error) {
      decide('promote', 'telemetry_failed', {
        reason: 'usage_metadata_failed',
        target: mutation.target,
        detail: { why: (error as Error).message },
      });
    }
  }

  deps.db.setRuntimeKey(PENDING_SIGNAL_IDS_KEY, JSON.stringify([...deferredSignalIds].slice(-2000)));
  deps.db.setRuntimeKey(WATERMARK_KEY, String(now));
  return summary;
}
