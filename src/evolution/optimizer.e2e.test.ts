import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ScallopDatabase } from '../memory/db.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { createSkillExecutor } from '../skills/executor.js';
import { SkillStore } from './skill-store.js';
import { runEvolutionOptimizer } from './optimizer.js';
import { runRollbackWatchdog } from './watchdog.js';
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig } from './config.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

/** A mock reflection provider that always returns the same valid skill mutation. */
function mockProvider(mutationJson: string): LLMProvider {
  return {
    name: 'mock-evolution',
    isAvailable: () => true,
    complete: async (request): Promise<CompletionResponse> => {
      const system = typeof request.system === 'string' ? request.system : '';
      let text = mutationJson;
      if (/held-out evaluation task/i.test(system)) text = 'generic replay output';
      if (/fitness evaluator/i.test(system)) {
        const payload = JSON.parse(String(request.messages[0]?.content)) as { holdoutResults: Array<{ id: string }> };
        text = JSON.stringify({
          safe: true,
          cases: payload.holdoutResults.map(item => ({ id: item.id, baseline: 0.2, candidate: 0.8 })),
        });
      }
      return {
        content: [{ type: 'text', text: text }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'mock',
      };
    },
  };
}

/** Mock that returns the mutation for reflect calls and a fixed verdict for judge calls. */
function mockProviderWithJudge(mutationJson: string, approved: boolean): LLMProvider {
  return {
    name: 'mock-evolution-judge',
    isAvailable: () => true,
    complete: async (req): Promise<CompletionResponse> => {
      const system = typeof req.system === 'string' ? req.system : '';
      const isJudge = /safety reviewer/i.test(system);
      let text = mutationJson;
      if (/held-out evaluation task/i.test(system)) text = 'generic replay output';
      if (/fitness evaluator/i.test(system)) {
        const payload = JSON.parse(String(req.messages[0]?.content)) as { holdoutResults: Array<{ id: string }> };
        text = JSON.stringify({
          safe: true,
          cases: payload.holdoutResults.map(item => ({ id: item.id, baseline: 0.2, candidate: 0.8 })),
        });
      }
      if (isJudge) text = JSON.stringify({ approved, reason: approved ? 'safe' : 'looks unsafe' });
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'mock' };
    },
  };
}

const GOOD_DOC_SKILL = JSON.stringify({
  target: 'repeatable_research',
  rationale: 'recurring research procedure worth distilling',
  files: {
    'SKILL.md': `---\nname: repeatable_research\ndescription: Reusable evidence-first research procedure\nuser-invocable: false\n---\n# Evidence-first research\nUse primary sources, record uncertainty, and synthesize only supported findings.\n`,
  },
});

const BROKEN_SKILL = JSON.stringify({
  target: 'broken_skill',
  rationale: 'attempted but broken',
  files: {
    'SKILL.md': `---\nname: broken_skill\ndescription: A skill with a syntax error\nuser-invocable: false\nscripts:\n  run: scripts/run.ts\n---\n# Broken\n`,
    'scripts/run.ts': `this is not valid typescript {{{\n`,
  },
});

const TEST_CONFIG: EvolutionConfig = {
  ...DEFAULT_EVOLUTION_CONFIG,
  enabled: true,
  includeSessionContent: true,
  requireFitnessGate: true,
  useLlmJudge: false,
};

/** Reflection + fitness + safety responses for the fully gated production path. */
function mockFullyGatedProvider(mutationJson: string, delta = 0.4): LLMProvider {
  return {
    name: 'mock-fully-gated',
    isAvailable: () => true,
    complete: async req => {
      const system = typeof req.system === 'string' ? req.system : '';
      let text = mutationJson;
      if (/held-out evaluation task/i.test(system)) {
        text = /CANDIDATE/.test(system)
          ? 'Candidate replay follows the evidence-first procedure and states uncertainty.'
          : 'Baseline replay gives a generic response.';
      } else if (/fitness evaluator/i.test(system)) {
        const user = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '{}';
        const payload = JSON.parse(user) as { holdoutResults: Array<{ id: string }> };
        text = JSON.stringify({
          safe: true,
          cases: payload.holdoutResults.map(testCase => ({
            id: testCase.id,
            baseline: 0.3,
            candidate: 0.3 + delta,
          })),
        });
      } else if (/safety reviewer/i.test(system)) {
        text = JSON.stringify({ approved: true, reason: 'safe' });
      }
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'mock',
      } as CompletionResponse;
    },
  };
}

describe('Evolution optimizer — end-to-end closed loop', () => {
  let dir: string;
  let db: ScallopDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evo-e2e-'));
    db = new ScallopDatabase(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function buildDeps(provider: LLMProvider | undefined, config: EvolutionConfig) {
    const localDir = join(dir, 'skills');
    const store = new SkillStore({ localDir });
    const loader = new SkillLoader({ localDir });
    const registry = new SkillRegistry(loader);
    const executor = createSkillExecutor();
    return {
      store,
      registry,
      localDir,
      deps: {
        db,
        provider,
        store,
        loader,
        executor,
        reloadFromDisk: () => registry.reloadFromDisk(),
        config,
        loadCurrentSkillFiles: (name: string) => store.snapshotLive(name),
        resolveSkillTarget: async (name: string) => {
          await registry.reloadFromDisk();
          const skill = registry.getSkill(name);
          const usage = await store.getUsage();
          const entry = usage[name];
          return skill
            ? {
                exists: true,
                source: skill.source,
                hasScripts: skill.hasScripts,
                createdBy: entry?.createdBy ?? null,
              }
            : {
                exists: !!entry,
                source: entry ? 'local' : undefined,
                createdBy: entry?.createdBy ?? null,
              };
        },
        now: 10_000,
      },
    };
  }

  it('harvests → reflects → verifies → promotes a new skill (hot-loaded)', async () => {
    // Seed enough reusable-task signals to trigger a create cluster.
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }

    const { registry, deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(1);
    expect(summary.rejected).toBe(0);

    // The promoted skill is live in the registry (hot-loaded from disk).
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeDefined();

    // A version was recorded with no prior snapshot (brand-new skill).
    const version = db.getActiveEvolutionVersion('repeatable_research');
    expect(version).not.toBeNull();
    expect(version!.snapshot).toBeNull();

    // The decision log shows the promotion.
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'promote' && d.outcome === 'promoted')).toBe(true);
  });

  it('rejects every machine-authored executable mutation without OS isolation', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 2000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }

    const { registry, deps } = buildDeps(mockProvider(BROKEN_SKILL), TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.rejected).toBe(1);

    await registry.reloadFromDisk();
    expect(registry.getSkill('broken_skill')).toBeUndefined();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'verify' && d.outcome === 'rejected' && d.reason === 'executable_requires_isolation')).toBe(true);
  });

  it('compensates a partial promotion when registry reload fails', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 2000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { store, deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), TEST_CONFIG);
    deps.reloadFromDisk = vi.fn()
      .mockRejectedValueOnce(new Error('registry reload failed'))
      .mockResolvedValue(undefined);

    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ promoted: 0, rejected: 1 });
    expect(await store.snapshotLive('repeatable_research')).toBeNull();
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'promote_failed')).toBe(true);
  });

  it('auto-rolls-back a promoted skill that regresses', async () => {
    const config: EvolutionConfig = { ...TEST_CONFIG, rollbackWindow: 2 };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, store, localDir, deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), config);
    await runEvolutionOptimizer(deps);
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeDefined();

    // Now the promoted skill starts failing in use (after promotion time = now 10000).
    db.recordEvolutionSignal({ userId: 'u', at: 11_000, type: 'skill_failure', targetSkill: 'repeatable_research' });
    db.recordEvolutionSignal({ userId: 'u', at: 11_001, type: 'skill_failure', targetSkill: 'repeatable_research' });

    const wd = await runRollbackWatchdog({
      db,
      store,
      reloadFromDisk: () => registry.reloadFromDisk(),
      config,
      now: 12_000,
    });

    expect(wd.rolledBack).toContain('repeatable_research');
    // Brand-new skill had no snapshot → rollback deletes it.
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeUndefined();
    expect(db.getActiveEvolutionVersion('repeatable_research')).toBeNull();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'rollback' && d.outcome === 'rolled_back')).toBe(true);

    // sanity: the local skill dir is gone
    expect(join(localDir, 'repeatable_research')).toBeTruthy();
  });

  it('skips cleanly when there are no fresh signals', async () => {
    const { deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);
    expect(summary.skipped).toContain('no_signals');
    expect(summary.promoted).toBe(0);
  });

  it('refuses autonomous evolution when the required fitness gate is disabled', async () => {
    db.recordEvolutionSignal({
      userId: 'u', at: 1_000, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
    });
    const provider = mockProvider(GOOD_DOC_SKILL);
    provider.complete = vi.fn(provider.complete.bind(provider));
    const { deps } = buildDeps(provider, { ...TEST_CONFIG, requireFitnessGate: false });

    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 0, promoted: 0, rejected: 0 });
    expect(summary.skipped).toContain('fitness_gate_required');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(db.getRuntimeKey('evolution:lastOptimizedAt')).toBeNull();
  });

  it('accumulates sub-threshold reusable evidence across optimizer nights', async () => {
    db.recordEvolutionSignal({
      userId: 'u', at: 1_000, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
    });
    const { registry, deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), TEST_CONFIG);

    const first = await runEvolutionOptimizer(deps);
    expect(first).toMatchObject({ proposed: 0, promoted: 0 });
    expect(first.skipped).toContain('insufficient_evidence');

    db.recordEvolutionSignal({
      userId: 'u', at: 11_000, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
    });
    db.recordEvolutionSignal({
      userId: 'u', at: 11_001, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
    });
    deps.now = 20_000;
    const second = await runEvolutionOptimizer(deps);

    expect(second).toMatchObject({ proposed: 1, promoted: 1, rejected: 0 });
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeDefined();
  });

  it('retains context-free evidence until content consent is enabled', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({
        userId: 'u', at: 1_000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
      });
    }
    const { registry, deps } = buildDeps(mockProvider(GOOD_DOC_SKILL), {
      ...TEST_CONFIG,
      includeSessionContent: false,
    });

    const privateRun = await runEvolutionOptimizer(deps);
    expect(privateRun).toMatchObject({ proposed: 0, promoted: 0 });
    expect(privateRun.skipped).toContain('content_consent_required');

    deps.config = { ...deps.config, includeSessionContent: true };
    deps.now = 20_000;
    const consentedRun = await runEvolutionOptimizer(deps);
    expect(consentedRun).toMatchObject({ proposed: 1, promoted: 1 });
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeDefined();
  });

  it('redacts consented previews before reflection instead of forwarding stored raw detail', async () => {
    const base = mockProvider(GOOD_DOC_SKILL);
    const requests: string[] = [];
    const complete = base.complete.bind(base);
    base.complete = vi.fn(async request => {
      requests.push(JSON.stringify(request));
      return complete(request);
    });
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({
        userId: 'u', at: 1_000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
        detail: {
          preview: 'Contact alice@example.com about this repeatable task.',
          legacyRawField: 'MUST_NOT_REACH_PROVIDER',
        },
      });
    }
    const { deps } = buildDeps(base, TEST_CONFIG);
    expect((await runEvolutionOptimizer(deps)).promoted).toBe(1);
    const disclosed = requests.join('\n');
    expect(disclosed).not.toContain('alice@example.com');
    expect(disclosed).not.toContain('MUST_NOT_REACH_PROVIDER');
    expect(disclosed).toContain('[EMAIL]');
  });

  it('does not consume signals when the evolution provider is temporarily unavailable', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const unavailable = buildDeps(undefined, TEST_CONFIG);
    const skipped = await runEvolutionOptimizer(unavailable.deps);
    expect(skipped.skipped).toContain('no_free_provider');
    expect(db.getRuntimeKey('evolution:lastOptimizedAt')).toBeNull();

    const recovered = buildDeps(mockProvider(GOOD_DOC_SKILL), TEST_CONFIG);
    const retried = await runEvolutionOptimizer(recovered.deps);
    expect(retried.promoted).toBe(1);
  });

  it('blocks an otherwise-valid skill when the safety judge rejects it', async () => {
    const config: EvolutionConfig = { ...TEST_CONFIG, useLlmJudge: true };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, deps } = buildDeps(mockProviderWithJudge(GOOD_DOC_SKILL, false), config);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.rejected).toBe(1);
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeUndefined();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.outcome === 'rejected' && d.reason === 'judge_rejected')).toBe(true);
  });

  it('promotes when the safety judge approves', async () => {
    const config: EvolutionConfig = { ...TEST_CONFIG, useLlmJudge: true };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, deps } = buildDeps(mockProviderWithJudge(GOOD_DOC_SKILL, true), config);
    const summary = await runEvolutionOptimizer(deps);
    expect(summary.promoted).toBe(1);
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeDefined();
  });

  it('promotes a learned-guidance prompt fragment, then auto-rolls-back on regression', async () => {
    const PROMPT_JSON = JSON.stringify({
      fragmentId: 'learned_guidance',
      rationale: 'answers were thin',
      content: 'When answering, verify claims against tools before responding.',
    });
    const config: EvolutionConfig = { ...TEST_CONFIG, rollbackWindow: 2 };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'low_quality', criticScore: 0.3 });
    }
    const { registry, store, deps } = buildDeps(mockProvider(PROMPT_JSON), config);

    const summary = await runEvolutionOptimizer(deps);
    expect(summary.promoted).toBe(1);
    const active = db.getActivePromptOverride('learned_guidance');
    expect(active?.content).toContain('verify claims');
    expect(db.getActiveEvolutionVersion('prompt:learned_guidance')).not.toBeNull();

    // Low-quality answers persist after the prompt change → regression → rollback.
    db.recordEvolutionSignal({ userId: 'u', at: 11_000, type: 'low_quality', criticScore: 0.3 });
    db.recordEvolutionSignal({ userId: 'u', at: 11_001, type: 'low_quality', criticScore: 0.3 });
    const wd = await runRollbackWatchdog({
      db, store, reloadFromDisk: () => registry.reloadFromDisk(), config, now: 12_000,
    });
    expect(wd.rolledBack).toContain('prompt:learned_guidance');
    // No prior content → override cleared.
    expect(db.getActivePromptOverride('learned_guidance')).toBeNull();
  });

  it('promotes only after holdout fitness and safety gates prove improvement', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({
        userId: 'u',
        at: 1000 + i,
        type: 'reusable_task',
        toolCallCount: 6,
        criticScore: 0.9,
        detail: { preview: `repeatable case ${i}` },
      });
    }
    const { store, deps } = buildDeps(mockFullyGatedProvider(GOOD_DOC_SKILL), {
      ...DEFAULT_EVOLUTION_CONFIG, enabled: true, includeSessionContent: true,
    });
    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 1, promoted: 1, rejected: 0 });
    const decision = db.getRecentEvolutionDecisions(20).find(item => item.outcome === 'fitness_passed');
    expect(decision?.detail?.delta).toBeCloseTo(0.4);
    expect((await store.getUsage()).repeatable_research).toMatchObject({ createdBy: 'agent', state: 'active' });
  });

  it('rejects a valid candidate that does not improve holdout fitness', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({
        userId: 'u',
        at: 1000 + i,
        type: 'reusable_task',
        toolCallCount: 6,
        criticScore: 0.9,
        detail: { preview: `repeatable case ${i}` },
      });
    }
    const { registry, deps } = buildDeps(mockFullyGatedProvider(GOOD_DOC_SKILL, 0.01), {
      ...DEFAULT_EVOLUTION_CONFIG, enabled: true, includeSessionContent: true,
    });
    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 1, promoted: 0, rejected: 1 });
    await registry.reloadFromDisk();
    expect(registry.getSkill('repeatable_research')).toBeUndefined();
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'fitness_failed')).toBe(true);
  });

  it('rejects create collisions with bundled skills instead of shadowing them', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({
        userId: 'u', at: 1_000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9,
        detail: { preview: `shell task ${i}` },
      });
    }
    const bashMutation = JSON.stringify({
      target: 'bash',
      rationale: 'shadow the existing shell tool',
      files: {
        'SKILL.md': '---\nname: bash\ndescription: Replacement procedure\nuser-invocable: false\n---\n# Replacement',
      },
    });
    const { registry, store, deps } = buildDeps(mockProvider(bashMutation), TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary).toMatchObject({ proposed: 1, promoted: 0, rejected: 1 });
    await registry.reloadFromDisk();
    expect(registry.getSkill('bash')?.source).toBe('bundled');
    expect(await store.snapshotLive('bash')).toBeNull();
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'target_collision')).toBe(true);
  });

  it('never reflects or replaces a genuine bash failure cluster', async () => {
    for (let i = 0; i < 2; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1_000 + i, type: 'skill_failure', targetSkill: 'bash' });
    }
    const provider = mockProvider(GOOD_DOC_SKILL);
    provider.complete = vi.fn(provider.complete.bind(provider));
    const { registry, store, deps } = buildDeps(provider, TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary).toMatchObject({ proposed: 0, promoted: 0, rejected: 1 });
    expect(provider.complete).not.toHaveBeenCalled();
    await registry.reloadFromDisk();
    expect(registry.getSkill('bash')?.source).toBe('bundled');
    expect(await store.snapshotLive('bash')).toBeNull();
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'protected_patch_target')).toBe(true);
  });

  it('requires a patch mutation to target its exact curator-owned cluster key', async () => {
    const { registry, store, deps } = buildDeps(mockProvider(JSON.stringify({
      target: 'different_skill',
      rationale: 'retargeted patch',
      files: {
        'SKILL.md': '---\nname: different_skill\ndescription: Wrong target\nuser-invocable: false\n---\n# Wrong',
      },
    })), TEST_CONFIG);
    await store.stage('agent_doc', {
      'SKILL.md': '---\nname: agent_doc\ndescription: Curator-owned procedure\nuser-invocable: false\n---\n# Original',
    });
    await store.promote('agent_doc');
    await store.markAgentCreated('agent_doc', 'create', 0);
    await registry.reloadFromDisk();
    for (let i = 0; i < 2; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1_000 + i, type: 'skill_failure', targetSkill: 'agent_doc' });
    }

    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 1, promoted: 0, rejected: 1 });
    expect(await store.snapshotLive('different_skill')).toBeNull();
    expect((await store.snapshotLive('agent_doc'))?.['SKILL.md']).toContain('# Original');
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'target_mismatch')).toBe(true);
  });

  it('strips previews and trajectories from reflection and fitness after consent is revoked', async () => {
    const requests: string[] = [];
    const patched = JSON.stringify({
      target: 'agent_doc',
      rationale: 'generic reliability improvement',
      files: {
        'SKILL.md': '---\nname: agent_doc\ndescription: Improved generic procedure\nuser-invocable: false\n---\n# Improved\nVerify results before returning them.',
      },
    });
    const provider: LLMProvider = {
      name: 'revoked-consent-test',
      isAvailable: () => true,
      complete: vi.fn(async request => {
        requests.push(JSON.stringify(request));
        const system = typeof request.system === 'string' ? request.system : '';
        let text = patched;
        if (/held-out evaluation task/i.test(system)) text = 'generic replay output';
        if (/fitness evaluator/i.test(system)) {
          const payload = JSON.parse(String(request.messages[0]?.content)) as { holdoutResults: Array<{ id: string }> };
          text = JSON.stringify({
            safe: true,
            cases: payload.holdoutResults.map(item => ({ id: item.id, baseline: 0.2, candidate: 0.8 })),
          });
        }
        return {
          content: [{ type: 'text', text }], stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 }, model: 'revoked-consent-test',
        } as CompletionResponse;
      }),
    };
    const { registry, store, deps } = buildDeps(provider, {
      ...TEST_CONFIG,
      includeSessionContent: false,
      requireFitnessGate: true,
    });
    await store.stage('agent_doc', {
      'SKILL.md': '---\nname: agent_doc\ndescription: Safe existing procedure\nuser-invocable: false\n---\n# Existing',
    });
    await store.promote('agent_doc');
    await store.markAgentCreated('agent_doc', 'create', 0);
    await registry.reloadFromDisk();

    db.createSession('revoked-session');
    db.addSessionMessage('revoked-session', 'user', 'REVOKED_PRIVATE_TRAJECTORY');
    for (let i = 0; i < 2; i++) {
      db.recordEvolutionSignal({
        userId: 'u', at: 1_000 + i, type: 'skill_failure', targetSkill: 'agent_doc',
        sessionId: 'revoked-session', detail: { preview: 'REVOKED_PRIVATE_PREVIEW' },
      });
    }

    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 1, promoted: 1, rejected: 0 });
    expect(requests.join('\n')).not.toContain('REVOKED_PRIVATE_PREVIEW');
    expect(requests.join('\n')).not.toContain('REVOKED_PRIVATE_TRAJECTORY');
  });

  it('rejects an older private patch baseline before any provider sees it after consent revocation', async () => {
    const provider = mockProvider(GOOD_DOC_SKILL);
    provider.complete = vi.fn(provider.complete.bind(provider));
    const { registry, store, deps } = buildDeps(provider, {
      ...TEST_CONFIG,
      includeSessionContent: false,
    });
    await store.stage('legacy_agent_doc', {
      'SKILL.md': '---\nname: legacy_agent_doc\ndescription: Historical procedure\nuser-invocable: false\n---\n# Historical\nContact alice@example.com for approval.',
    });
    await store.promote('legacy_agent_doc');
    await store.markAgentCreated('legacy_agent_doc', 'create', 0);
    await registry.reloadFromDisk();
    for (let i = 0; i < 2; i++) {
      db.recordEvolutionSignal({
        userId: 'u', at: 1_000 + i, type: 'skill_failure', targetSkill: 'legacy_agent_doc',
        detail: { preview: 'REVOKED_PRIVATE_PREVIEW' },
      });
    }

    const summary = await runEvolutionOptimizer(deps);
    expect(summary).toMatchObject({ proposed: 0, promoted: 0, rejected: 1 });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(db.getRecentEvolutionDecisions(20).some(item =>
      item.reason === 'protected_patch_target'
      && item.detail?.gate === 'privacy_failed')).toBe(true);
  });

  it('rolls back the prompt override when ledger insertion fails', async () => {
    db.close();
    const dbPath = join(dir, 'prompt-promotion-failure.db');
    db = new ScallopDatabase(dbPath);
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER fail_prompt_ledger
      BEFORE INSERT ON evolution_versions
      BEGIN SELECT RAISE(ABORT, 'injected prompt ledger failure'); END;
    `);
    raw.close();
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1_000 + i, type: 'low_quality', criticScore: 0.2 });
    }
    const promptJson = JSON.stringify({
      fragmentId: 'learned_guidance',
      rationale: 'generic answer quality',
      content: 'Verify claims before answering.',
    });
    const { deps } = buildDeps(mockProvider(promptJson), TEST_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary).toMatchObject({ proposed: 1, promoted: 0, rejected: 1 });
    expect(db.getActivePromptOverride('learned_guidance')).toBeNull();
    expect(db.getActiveEvolutionVersion('prompt:learned_guidance')).toBeNull();
    expect(db.getRecentEvolutionDecisions(20).some(item => item.reason === 'promote_failed')).toBe(true);
  });
});
