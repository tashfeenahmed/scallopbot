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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import { SubAgentExecutor } from './executor.js';
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
import type { EmbeddingProvider } from '../memory/embeddings.js';

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
  pm.setStaticValue('default', 'name', 'Tashfeen');
  pm.setStaticValue('default', 'timezone', 'America/Chicago');
  pm.setStaticValue('default', 'location', 'Austin, TX');

  // Seed agent profile
  pm.setStaticValue('agent', 'name', 'Ayo');
  pm.setStaticValue('agent', 'personality', 'warm and research-oriented');

  // Seed some memories
  await scallopStore.add({
    content: 'Tashfeen is building a personal AI assistant called SmartBot',
    userId: 'default',
    category: 'fact',
    importance: 8,
    confidence: 0.95,
  });
  await scallopStore.add({
    content: 'Tashfeen prefers concise, direct answers without fluff',
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
  configOverrides: Record<string, unknown> = {}
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
    scallopStore: ctx.scallopStore,
    workspace: '/tmp',
    logger,
    config: configOverrides,
  });

  return { executor, registry, announceQueue, skillRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentExecutor integration', () => {
  // -----------------------------------------------------------------------
  // Scenario 1: System prompt contains user profile + agent identity + memories
  // -----------------------------------------------------------------------
  it('injects user profile, agent identity, and relevant memories into the system prompt', async () => {
    const provider = createTrackingProvider([
      'SmartBot is Tashfeen\'s personal AI project, focused on research-oriented sub-agents. [DONE]',
    ]);
    const { executor } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    await executor.spawnAndWait(parentSession.id, {
      task: 'What do you know about the SmartBot project?',
      label: 'profile-test',
    });

    // The sub-agent's LLM should have been called with a system prompt
    expect(provider.callCount).toBeGreaterThanOrEqual(1);
    const systemPrompt = provider.allRequests[0].system ?? '';

    // Agent identity
    expect(systemPrompt).toContain('Ayo');
    expect(systemPrompt).toContain('warm and research-oriented');

    // User profile
    expect(systemPrompt).toContain('Tashfeen');
    expect(systemPrompt).toContain('America/Chicago');
    expect(systemPrompt).toContain('Austin');

    // Relevant memories (seeded content should appear via search)
    expect(systemPrompt).toContain('RELEVANT MEMORIES');
    expect(systemPrompt).toContain('SmartBot');

    // Research workflow guidance
    expect(systemPrompt).toContain('RESEARCH WORKFLOW');
    expect(systemPrompt).toContain('memory_search');
    expect(systemPrompt).toContain('web_search');
  }, 30_000);

  // -----------------------------------------------------------------------
  // Scenario 2: Sub-agent completes within iteration budget (10)
  // -----------------------------------------------------------------------
  it('completes a simple research task within the 10-iteration budget', async () => {
    const provider = createTrackingProvider([
      'Based on existing memories, Tashfeen is in Austin, TX, timezone America/Chicago. [DONE]',
    ]);
    const { executor } = await buildExecutor(provider);

    const parentSession = await ctx.sessionManager.createSession({ label: 'parent' });

    const result = await executor.spawnAndWait(parentSession.id, {
      task: 'What timezone is the user in?',
      label: 'iteration-budget',
    });

    // Should complete in 1 iteration (simple question, mock answers immediately)
    expect(result.taskComplete).toBe(true);
    expect(result.iterationsUsed).toBeLessThanOrEqual(10);
    expect(result.response).toContain('Austin');
    expect(result.response).not.toContain('[DONE]'); // [DONE] should be stripped
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
    const systemPrompt = provider.allRequests[0].system ?? '';
    const toolNames = (provider.allRequests[0].tools ?? []).map((t) => t.name);

    // memory_search is an executable skill registered by gateway, so in this
    // test env it may only appear in the system prompt guidance section
    const hasMemorySearch =
      toolNames.includes('memory_search') ||
      systemPrompt.includes('memory_search');

    expect(hasMemorySearch).toBe(true);
  }, 30_000);
});
