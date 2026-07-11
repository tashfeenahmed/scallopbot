/**
 * SubAgentExecutor Integration Tests
 *
 * Exercises the enriched sub-agent system end-to-end:
 *  - Profile + memory injection in system prompt
 *  - Dedicated ContextManager with tight limits
 *  - Token budget enforcement
 *  - Skill filtering (including documentation skills like web_search)
 *  - NEVER_ALLOWED_SKILLS blocking
 *
 * Uses real ScallopMemoryStore + SessionManager (SQLite) with mock LLM/embedder.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import { SubAgentExecutor, type SubAgentExecutorOptions } from './executor.js';
import { SubAgentRegistry } from './registry.js';
import { AnnounceQueue } from './announce-queue.js';
import { SessionManager } from '../agent/session.js';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { Router } from '../routing/router.js';
import { createSkillRegistry } from '../skills/registry.js';
import { createSkillExecutor } from '../skills/executor.js';
import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from '../providers/types.js';
import { flattenSystem } from '../providers/types.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';
import { CostTracker } from '../routing/cost.js';
import { EvolutionRecorder } from '../evolution/signals.js';
import { DEFAULT_EVOLUTION_CONFIG } from '../evolution/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function createMockEmbeddingProvider(): EmbeddingProvider {
  const DIMENSION = 384;
  function hashEmbed(text: string): number[] {
    const vec = new Array(DIMENSION).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % DIMENSION] += text.charCodeAt(i);
    }
    const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < DIMENSION; i++) vec[i] /= magnitude;
    }
    return vec;
  }
  return {
    name: 'mock-embedder',
    dimension: DIMENSION,
    async embed(text: string) { return hashEmbed(text); },
    async embedBatch(texts: string[]) { return texts.map(hashEmbed); },
    isAvailable() { return true; },
  };
}

/** Track-capable mock LLM provider. Cycles through `responses`.
 *  Uses name 'openai' so the Router's tier mapping for 'fast' finds it. */
function createTrackingProvider(
  responses: string[]
): LLMProvider & {
  callCount: number;
  cumulativeInputTokens: number;
  allRequests: CompletionRequest[];
} {
  let callIndex = 0;
  const provider: LLMProvider & {
    callCount: number;
    cumulativeInputTokens: number;
    allRequests: CompletionRequest[];
  } = {
    name: 'openai', // Must match a tier-mapped name so Router.selectProvider('fast') works
    callCount: 0,
    cumulativeInputTokens: 0,
    allRequests: [],
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      provider.callCount++;
      provider.allRequests.push(request);
      const text = responses[callIndex % responses.length];
      callIndex++;
      const inputTokens = 500; // Realistic per-call count
      provider.cumulativeInputTokens += inputTokens;
      return {
        content: [{ type: 'text', text }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens, outputTokens: 100 },
        model: 'mock-model',
      };
    },
    isAvailable() { return true; },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Shared test context
// ---------------------------------------------------------------------------

interface TestContext {
  scallopStore: ScallopMemoryStore;
  sessionManager: SessionManager;
  dbPath: string;
}

let ctx: TestContext;

beforeAll(async () => {
  const dbPath = `/tmp/subagent-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;
  const scallopStore = new ScallopMemoryStore({
    dbPath,
    logger,
    embedder: createMockEmbeddingProvider(),
  });

  const sessionManager = new SessionManager(scallopStore.getDatabase());

  // Seed user profile
  const pm = scallopStore.getProfileManager();
  pm.setStaticValue('default', 'name', 'Alex');
  pm.setStaticValue('default', 'timezone', 'America/Chicago');
  pm.setStaticValue('default', 'location', 'Austin, TX');

  // Seed agent profile
  pm.setStaticValue('agent', 'name', 'Ayo');
  pm.setStaticValue('agent', 'personality', 'warm and research-oriented');

  // Seed some memories
  await scallopStore.add({
    content: 'Alex is building a personal AI assistant called SmartBot',
    userId: 'default',
    category: 'fact',
    importance: 8,
    confidence: 0.95,
  });
  await scallopStore.add({
    content: 'Alex prefers concise, direct answers without fluff',
    userId: 'default',
    category: 'preference',
    importance: 7,
    confidence: 0.9,
  });

  ctx = { scallopStore, sessionManager, dbPath };
}, 30_000);

afterAll(() => {
  ctx.scallopStore.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(ctx.dbPath + suffix); } catch { /* ignore */ }
  }
});

/** Helper: build a SubAgentExecutor with a given LLM provider + optional config overrides. */
async function buildExecutor(
  provider: LLMProvider,
  configOverrides: Record<string, unknown> = {},
  costTracker?: CostTracker,
  skillPolicyResolver?: SubAgentExecutorOptions['skillPolicyResolver'],
  evolutionRecorder?: EvolutionRecorder,
) {
  const skillRegistry = createSkillRegistry('/tmp', logger);
  await skillRegistry.initialize();
  const skillExecutor = createSkillExecutor(logger);

  // Fresh router per executor so mock providers don't collide
  const router = new Router({});
  router.registerProvider(provider);

  const registry = new SubAgentRegistry({ logger });
  const announceQueue = new AnnounceQueue({ logger });

  const executor = new SubAgentExecutor({
    registry,
    announceQueue,
    sessionManager: ctx.sessionManager,
    skillRegistry,
    skillExecutor,
    router,
    costTracker,
    skillPolicyResolver,
    scallopStore: ctx.scallopStore,
    workspace: '/tmp',
    logger,
    config: configOverrides,
    evolutionRecorder,
  });

  return { executor, registry, announceQueue, skillRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentExecutor integration', () => {
  it('feeds only verified successful child work into automatic skill learning', async () => {
    const signals: Array<{ type: string }> = [];
    const recorder = new EvolutionRecorder(
      { recordEvolutionSignal: signal => signals.push(signal) },
      { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, minToolCalls: 0, reusableScoreBar: 0 },
      logger,
    );
    const provider = createTrackingProvider([
      '{"status":"succeeded","summary":"Verified reusable workflow completed successfully.","acceptancePassed":true} [DONE]',
      '{"status":"succeeded","summary":"Claimed success without acceptance.","acceptancePassed":false} [DONE]',
    ]);
    const { executor } = await buildExecutor(provider, {}, undefined, undefined, recorder);
    const parent = await ctx.sessionManager.createSession({ label: 'parent' });
    await executor.spawnAndWait(parent.id, { task: 'Run reusable workflow' });
    expect(signals.some(signal => signal.type === 'reusable_task')).toBe(true);
    const countAfterSuccess = signals.length;
    await executor.spawnAndWait(parent.id, { task: 'Run unverified workflow', acceptanceCriteria: ['must pass'] });
    expect(signals).toHaveLength(countAfterSuccess);
  });

  it('keeps an explicit parent cancellation distinct from a timeout', async () => {
    const provider: LLMProvider = {
      name: 'openai',
      isAvailable: () => true,
      complete: request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };
    const { executor, registry } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });
    const { runId } = await executor.spawn(parentSession.id, { task: 'Wait for cancellation', idleTimeoutSeconds: 30 });
    await vi.waitFor(() => expect(registry.getRun(runId)?.status).toBe('running'));
    expect(executor.cancel(runId)).toBe(true);
    await vi.waitFor(() => expect(registry.getRun(runId)?.status).toBe('cancelled'));
    expect(registry.getRun(runId)?.status).not.toBe('timed_out');
  });

  it('keeps isolated context free of profiles and memories and forbids thought leakage', async () => {
    const provider = createTrackingProvider(['{"status":"succeeded","summary":"Checked","acceptancePassed":true} [DONE]']);
    const { executor } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });
    await executor.spawnAndWait(parentSession.id, {
      task: 'Check only the supplied context',
      context: 'ticket=42',
      contextMode: 'isolated',
    });
    const systemPrompt = flattenSystem(provider.allRequests[0].system!);
    expect(systemPrompt).toContain('ticket=42');
    expect(systemPrompt).not.toContain('America/Chicago');
    expect(systemPrompt).not.toContain('RELEVANT MEMORIES');
    expect(systemPrompt).toContain('Never reveal chain-of-thought');
    expect(systemPrompt).toContain('not sent directly to the user');
  });

  // -----------------------------------------------------------------------
  // Scenario 1: System prompt contains user profile + agent identity + memories
  // -----------------------------------------------------------------------
  it('injects user profile, agent identity, and relevant memories into the system prompt', async () => {
    const provider = createTrackingProvider([
      'SmartBot is Alex\'s personal AI project, focused on research-oriented sub-agents. [DONE]',
    ]);
    const { executor } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    await executor.spawnAndWait(parentSession.id, {
      task: 'What do you know about the SmartBot project?',
      label: 'profile-test',
    });

    // The sub-agent's LLM should have been called with a system prompt
    expect(provider.callCount).toBeGreaterThanOrEqual(1);
    const systemPrompt = provider.allRequests[0].system ? flattenSystem(provider.allRequests[0].system) : '';

    // Agent identity
    expect(systemPrompt).toContain('Ayo');
    expect(systemPrompt).toContain('warm and research-oriented');

    // User profile
    expect(systemPrompt).toContain('Alex');
    expect(systemPrompt).toContain('America/Chicago');
    expect(systemPrompt).toContain('Austin');

    // Relevant memories (seeded content should appear via search)
    expect(systemPrompt).toContain('RELEVANT MEMORIES');
    expect(systemPrompt).toContain('SmartBot');

    // Research workflow guidance
    expect(systemPrompt).toContain('RESEARCH WORKFLOW');
    expect(systemPrompt).toContain('memory_search');
    expect(systemPrompt).not.toContain('via bash');
  }, 30_000);

  // -----------------------------------------------------------------------
  // Scenario 2: Sub-agent completes within iteration budget (10)
  // -----------------------------------------------------------------------
  it('completes a simple research task within the 10-iteration budget', async () => {
    const provider = createTrackingProvider([
      'Based on existing memories, Alex is in Austin, TX, timezone America/Chicago. [DONE]',
    ]);
    const { executor, announceQueue } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'What timezone is the user in?',
      label: 'iteration-budget',
    });

    // Should complete in 1 iteration (simple question, mock answers immediately)
    expect(result.taskComplete).toBe(true);
    expect(result.completionSource).toBe('explicit_done');
    expect(result.iterationsUsed).toBeLessThanOrEqual(10);
    expect(result.response).toContain('Austin');
    expect(result.response).not.toContain('[DONE]'); // [DONE] should be stripped
    // Synchronous results are returned inline and must not be announced again
    // on the parent's next turn.
    expect(announceQueue.pendingCount(parentSession.id)).toBe(0);
  }, 30_000);

  it('does not treat an honest natural-end failure as completed work', async () => {
    const provider = createTrackingProvider([
      'The analytics API is unavailable, so I could not retrieve the report.',
    ]);
    const { executor } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'Retrieve the analytics report',
      label: 'natural-end-failure',
    });

    expect(result.response).toMatch(/unavailable/i);
    expect(result.taskComplete).toBe(false);
    expect(result.completionSource).toBeUndefined();
  }, 30_000);

  it('allows natural-end completion only when a real non-empty tool result verifies the work', async () => {
    const sourcePath = `/tmp/subagent-verified-${Date.now()}.txt`;
    fs.writeFileSync(sourcePath, 'verified source content');
    const responses: CompletionResponse[] = [
      {
        content: [{ type: 'tool_use', id: 'read-source', name: 'read_file', input: { path: sourcePath } }],
        stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 }, model: 'mock-model',
      },
      {
        content: [{ type: 'text', text: 'I read the source file successfully.' }],
        stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 }, model: 'mock-model',
      },
    ];
    let index = 0;
    const provider: LLMProvider = {
      name: 'openai',
      complete: vi.fn().mockImplementation(async () => responses[Math.min(index++, responses.length - 1)]),
      isAvailable: () => true,
    };
    try {
      const { executor } = await buildExecutor(provider);
      const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });
      const result = await executor.spawnAndWait(parentSession.id, {
        task: 'Read the source file', label: 'verified-tool-natural-end', skills: ['read_file'],
      });
      expect(result.taskComplete).toBe(true);
      expect(result.completionSource).toBe('verified_tool_evidence');
      expect(result.evidenceReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolName: 'read_file', success: true, outputBytes: expect.any(Number) }),
      ]));
    } finally {
      fs.rmSync(sourcePath, { force: true });
    }
  }, 30_000);

  it('does not let an explicit done marker override a failed final tool call', async () => {
    const responses: CompletionResponse[] = [
      {
        content: [{ type: 'tool_use', id: 'missing-source', name: 'read_file', input: { path: '/tmp/definitely-missing-scallop-file' } }],
        stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 }, model: 'mock-model',
      },
      {
        content: [{ type: 'text', text: 'The work is complete. [DONE]' }],
        stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 }, model: 'mock-model',
      },
    ];
    let index = 0;
    const provider: LLMProvider = {
      name: 'openai',
      complete: vi.fn().mockImplementation(async () => responses[Math.min(index++, responses.length - 1)]),
      isAvailable: () => true,
    };
    const { executor } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });
    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'Read the missing source file', label: 'failed-tool-explicit-done', skills: ['read_file'],
    });
    expect(result.taskComplete).toBe(false);
    expect(result.completionSource).toBeUndefined();
    expect(result.evidenceReceipts?.at(-1)).toMatchObject({ success: false });
  }, 30_000);

  it('returns the actual tracked dollar cost for the isolated child session', async () => {
    const provider = createTrackingProvider(['Costed result. [DONE]']);
    const tracker = new CostTracker({
      customPricing: {
        'mock-model': { inputPerMillion: 2, outputPerMillion: 4 },
      },
    });
    const { executor } = await buildExecutor(provider, {}, tracker);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'Return a costed result',
      label: 'cost-test',
    });

    // 500 input @ $2/M + 100 output @ $4/M = $0.0014.
    expect(result.costUsd).toBeCloseTo(0.0014, 8);
    expect(tracker.getUsageHistory()).toHaveLength(1);
    expect(tracker.getUsageHistory()[0].sessionId).not.toBe(parentSession.id);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Scenario 3: Token budget enforcement stops runaway sub-agents
  // -----------------------------------------------------------------------
  it('aborts when the token budget is exceeded', async () => {
    // Each call costs 500 input tokens. Set budget to 1 so the very first
    // call exceeds it. The budget check happens AFTER the first call returns,
    // so the first call succeeds but the second call (if any) is blocked.
    // To force a second call, we need tool_use. Instead, we set maxInputTokens
    // to 0 so the pre-call check fires immediately.
    const provider = createTrackingProvider([
      'This should never be returned',
    ]);

    const { executor } = await buildExecutor(provider, {
      maxInputTokens: 0,  // Pre-call check: cumulativeInputTokens(0) >= 0 → true → throw
      maxIterations: 20,
    });

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'Research everything about quantum computing history',
      label: 'token-budget',
    });

    // The wrapper throws before any LLM call, executor catches and returns error
    expect(result.response).toContain('token budget');
    expect(result.taskComplete).toBe(false);
    // No LLM calls should have been made
    expect(provider.callCount).toBe(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Scenario 4: NEVER_ALLOWED_SKILLS are blocked (manage_skills included)
  // -----------------------------------------------------------------------
  it('blocks manage_skills and other never-allowed skills', async () => {
    const provider = createTrackingProvider(['Skill check complete. [DONE]']);
    const { executor, skillRegistry } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    // Attempt to give the sub-agent manage_skills, spawn_agent, send_message
    await executor.spawnAndWait(parentSession.id, {
      task: 'Install a new communication skill',
      label: 'blocked-skills',
      skills: ['bash', 'manage_skills', 'spawn_agent', 'send_message', 'send_file', 'voice_reply'],
    });

    // Inspect what the sub-agent's filtered registry actually contained.
    // The tool definitions sent to the LLM should NOT include blocked skills.
    expect(provider.callCount).toBeGreaterThanOrEqual(1);
    const toolNames = (provider.allRequests[0].tools ?? []).map((t) => t.name);

    expect(toolNames).not.toContain('manage_skills');
    expect(toolNames).not.toContain('spawn_agent');
    expect(toolNames).not.toContain('send_message');
    expect(toolNames).not.toContain('send_file');
    expect(toolNames).not.toContain('voice_reply');
  }, 30_000);

  it('applies parent policy to explicitly requested sub-agent tools', async () => {
    const provider = createTrackingProvider(['Policy check complete. [DONE]']);
    const policy = vi.fn(async (skillName: string) => skillName !== 'bash');
    const { executor } = await buildExecutor(provider, {}, undefined, policy);
    const parentSession = await ctx.sessionManager.createSession({
      label: 'parent',
      channelId: 'api',
    });

    await executor.spawnAndWait(parentSession.id, {
      task: 'Read a file and run a shell command',
      label: 'policy-test',
      skills: ['read_file', 'bash'],
    });

    const toolNames = (provider.allRequests[0].tools ?? []).map(tool => tool.name);
    const systemPrompt = provider.allRequests[0].system ? flattenSystem(provider.allRequests[0].system) : '';
    expect(policy).toHaveBeenCalledWith('bash', expect.objectContaining({ parentSessionId: parentSession.id }));
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('bash');
    expect(systemPrompt).not.toContain('**bash**');
  }, 30_000);

  it('keeps implicit sub-agent tools read-only', async () => {
    const provider = createTrackingProvider(['Read-only defaults confirmed. [DONE]']);
    const { executor } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    await executor.spawnAndWait(parentSession.id, {
      task: 'Read the project file and summarize it',
      label: 'readonly-defaults',
    });

    const toolNames = (provider.allRequests[0].tools ?? []).map(tool => tool.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('edit_file');
    expect(toolNames).not.toContain('agent_browser');
  }, 30_000);

  // -----------------------------------------------------------------------
  // Scenario 5: memory_search is always available by default
  // -----------------------------------------------------------------------
  it('includes memory_search in default skill set', async () => {
    const provider = createTrackingProvider([
      'Found relevant memories about the user. [DONE]',
    ]);
    const { executor } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    // Don't specify skills — let the defaults kick in
    await executor.spawnAndWait(parentSession.id, {
      task: 'Look up what we know about the user\'s work',
      label: 'default-skills',
    });

    expect(provider.callCount).toBeGreaterThanOrEqual(1);

    // memory_search should be in the system prompt (generated by the skill prompt)
    // or in the tool definitions
    const systemPrompt = provider.allRequests[0].system ? flattenSystem(provider.allRequests[0].system) : '';
    const toolNames = (provider.allRequests[0].tools ?? []).map((t) => t.name);

    // memory_search is an executable skill registered by gateway, so in this
    // test env it may only appear in the system prompt guidance section
    const hasMemorySearch =
      toolNames.includes('memory_search') ||
      systemPrompt.includes('memory_search');

    expect(hasMemorySearch).toBe(true);
  }, 30_000);

  it('inherits the parent state owner without exposing another channel user', async () => {
    const profiles = ctx.scallopStore.getProfileManager();
    profiles.setStaticValue('telegram:isolated-alpha', 'name', 'Alpha Example');
    profiles.setStaticValue('telegram:isolated-beta', 'name', 'Beta Example');
    await ctx.scallopStore.add({
      content: 'Alpha Example keeps the synthetic Juniper roadmap private.',
      userId: 'telegram:isolated-alpha',
      category: 'fact',
      importance: 9,
      confidence: 1,
    });
    await ctx.scallopStore.add({
      content: 'Beta Example keeps the synthetic Magnolia roadmap private.',
      userId: 'telegram:isolated-beta',
      category: 'fact',
      importance: 9,
      confidence: 1,
    });

    const provider = createTrackingProvider(['The Juniper roadmap belongs to Alpha Example. [DONE]']);
    const { executor } = await buildExecutor(provider);
    const parentSession = await ctx.sessionManager.createSession({
      label: 'isolated-parent',
      userId: 'telegram:isolated-alpha',
      channelId: 'telegram',
    });

    await executor.spawnAndWait(parentSession.id, {
      task: 'Summarize the synthetic Juniper roadmap.',
      label: 'state-owner-inheritance',
    });

    const systemPrompt = provider.allRequests[0].system
      ? flattenSystem(provider.allRequests[0].system)
      : '';
    expect(systemPrompt).toContain('Alpha Example');
    expect(systemPrompt).toContain('Juniper');
    expect(systemPrompt).not.toContain('Beta Example');
    expect(systemPrompt).not.toContain('Magnolia');
  }, 30_000);
});
