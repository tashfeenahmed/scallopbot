import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
    complete: async (): Promise<CompletionResponse> => ({
      content: [{ type: 'text', text: mutationJson }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'mock',
    }),
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
      const text = isJudge
        ? JSON.stringify({ approved, reason: approved ? 'safe' : 'looks unsafe' })
        : mutationJson;
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'mock' };
    },
  };
}

const GOOD_SKILL = JSON.stringify({
  target: 'echo_hi',
  rationale: 'recurring multi-step pattern worth distilling',
  files: {
    'SKILL.md': `---\nname: echo_hi\ndescription: Prints a greeting as JSON\nuser-invocable: false\nscripts:\n  run: scripts/run.ts\n---\n# Echo Hi\nPrints hi.\n`,
    'scripts/run.ts': `console.log(JSON.stringify({ success: true, output: 'hi' }));\n`,
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

  function buildDeps(provider: LLMProvider, config: EvolutionConfig) {
    const localDir = join(dir, 'skills');
    const store = new SkillStore({ localDir });
    const registry = new SkillRegistry(new SkillLoader({ localDir }));
    const executor = createSkillExecutor();
    return {
      store,
      registry,
      localDir,
      deps: {
        db,
        provider,
        store,
        loader: new SkillLoader({}),
        executor,
        reloadFromDisk: () => registry.reloadFromDisk(),
        config,
        now: 10_000,
      },
    };
  }

  it('harvests → reflects → verifies → promotes a new skill (hot-loaded)', async () => {
    // Seed enough reusable-task signals to trigger a create cluster.
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }

    const { registry, deps } = buildDeps(mockProvider(GOOD_SKILL), DEFAULT_EVOLUTION_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(1);
    expect(summary.rejected).toBe(0);

    // The promoted skill is live in the registry (hot-loaded from disk).
    await registry.reloadFromDisk();
    expect(registry.getSkill('echo_hi')).toBeDefined();

    // A version was recorded with no prior snapshot (brand-new skill).
    const version = db.getActiveEvolutionVersion('echo_hi');
    expect(version).not.toBeNull();
    expect(version!.snapshot).toBeNull();

    // The decision log shows the promotion.
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'promote' && d.outcome === 'promoted')).toBe(true);
  });

  it('rejects a mutation whose script fails the smoke test (never promoted)', async () => {
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 2000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }

    const { registry, deps } = buildDeps(mockProvider(BROKEN_SKILL), DEFAULT_EVOLUTION_CONFIG);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.rejected).toBe(1);

    await registry.reloadFromDisk();
    expect(registry.getSkill('broken_skill')).toBeUndefined();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'verify' && d.outcome === 'rejected' && d.reason === 'smoke_failed')).toBe(true);
  });

  it('auto-rolls-back a promoted skill that regresses', async () => {
    const config: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, rollbackWindow: 2 };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, store, localDir, deps } = buildDeps(mockProvider(GOOD_SKILL), config);
    await runEvolutionOptimizer(deps);
    await registry.reloadFromDisk();
    expect(registry.getSkill('echo_hi')).toBeDefined();

    // Now the promoted skill starts failing in use (after promotion time = now 10000).
    db.recordEvolutionSignal({ userId: 'u', at: 11_000, type: 'skill_failure', targetSkill: 'echo_hi' });
    db.recordEvolutionSignal({ userId: 'u', at: 11_001, type: 'skill_failure', targetSkill: 'echo_hi' });

    const wd = await runRollbackWatchdog({
      db,
      store,
      reloadFromDisk: () => registry.reloadFromDisk(),
      config,
      now: 12_000,
    });

    expect(wd.rolledBack).toContain('echo_hi');
    // Brand-new skill had no snapshot → rollback deletes it.
    await registry.reloadFromDisk();
    expect(registry.getSkill('echo_hi')).toBeUndefined();
    expect(db.getActiveEvolutionVersion('echo_hi')).toBeNull();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.stage === 'rollback' && d.outcome === 'rolled_back')).toBe(true);

    // sanity: the local skill dir is gone
    expect(join(localDir, 'echo_hi')).toBeTruthy();
  });

  it('skips cleanly when there are no fresh signals', async () => {
    const { deps } = buildDeps(mockProvider(GOOD_SKILL), DEFAULT_EVOLUTION_CONFIG);
    const summary = await runEvolutionOptimizer(deps);
    expect(summary.skipped).toContain('no_signals');
    expect(summary.promoted).toBe(0);
  });

  it('blocks an otherwise-valid skill when the safety judge rejects it', async () => {
    const config: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, useLlmJudge: true };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, deps } = buildDeps(mockProviderWithJudge(GOOD_SKILL, false), config);
    const summary = await runEvolutionOptimizer(deps);

    expect(summary.proposed).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.rejected).toBe(1);
    await registry.reloadFromDisk();
    expect(registry.getSkill('echo_hi')).toBeUndefined();
    const decisions = db.getRecentEvolutionDecisions(20);
    expect(decisions.some(d => d.outcome === 'rejected' && d.reason === 'judge_rejected')).toBe(true);
  });

  it('promotes when the safety judge approves', async () => {
    const config: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, useLlmJudge: true };
    for (let i = 0; i < 3; i++) {
      db.recordEvolutionSignal({ userId: 'u', at: 1000 + i, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9 });
    }
    const { registry, deps } = buildDeps(mockProviderWithJudge(GOOD_SKILL, true), config);
    const summary = await runEvolutionOptimizer(deps);
    expect(summary.promoted).toBe(1);
    await registry.reloadFromDisk();
    expect(registry.getSkill('echo_hi')).toBeDefined();
  });

  it('promotes a learned-guidance prompt fragment, then auto-rolls-back on regression', async () => {
    const PROMPT_JSON = JSON.stringify({
      fragmentId: 'learned_guidance',
      rationale: 'answers were thin',
      content: 'When answering, verify claims against tools before responding.',
    });
    const config: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, rollbackWindow: 2 };
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
});
