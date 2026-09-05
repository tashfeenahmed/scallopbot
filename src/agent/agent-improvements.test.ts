import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { ScallopDatabase } from '../memory/db.js';
import { toolOperationIdentity } from './tool-safety.js';
import { getToolRecipeStore, resetToolRecipeStore } from './tool-recipes.js';
import { EMPTY_TURN_NUDGE, UNMADE_TOOL_CALL_NUDGE } from './turn-recovery.js';
import {
  buildEvidenceExecutionContext,
  digestEvidenceClaim,
} from '../security/evidence-grounding.js';

/** Mock provider that returns queued responses by call order. */
function seqProvider(responses: CompletionResponse[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]),
  };
}

const endTurn = (text: string): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'mock',
});

const CAPABLE_MSG =
  'Design and architect a complex distributed system with a detailed step-by-step analysis and implementation plan for fault tolerance and scalability';

describe('Agent improvements integration', () => {
  let testDir: string;
  let db: ScallopDatabase;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-improve-test-'));
    db = new ScallopDatabase(path.join(testDir, 'test.db'));
    // Tool recipes persist per data dir; isolate every test from the others.
    process.env.SCALLOPBOT_DATA_DIR = testDir;
    resetToolRecipeStore();
  });
  afterEach(async () => {
    db.close();
    delete process.env.SCALLOPBOT_DATA_DIR;
    resetToolRecipeStore();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('best-of-N (inference-time scaling)', () => {
    it('SKIPS resampling when the first answer is already good (adaptive gate)', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');

      // Strong, relevant first answer on a capable turn → should NOT resample.
      const provider = seqProvider([
        endTurn('Here is a detailed architecture: use microservices with redundant nodes and Raft consensus for fault tolerance and scalability.'),
      ]);
      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 5,
        bestOfN: 3,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, CAPABLE_MSG);

      expect(result.response).toMatch(/microservices/);
      // First answer cleared the quality bar → only the single original call.
      expect(provider.complete).toHaveBeenCalledTimes(1);
    });

    it('samples extra candidates only when the first answer is weak, and keeps the best', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');

      // Candidate #0 is a weak refusal; the two sampled candidates are strong.
      const provider = seqProvider([
        endTurn('I cannot help with that.'),
        endTurn('Here is a detailed architecture: use a microservices design with redundant nodes and consensus for fault tolerance and horizontal scalability.'),
        endTurn('Use sharded services behind a load balancer with replicated state and a Raft consensus layer for fault tolerance.'),
      ]);

      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 5,
        bestOfN: 3,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, CAPABLE_MSG);

      // Picked a strong candidate, not the weak refusal.
      expect(result.response).not.toMatch(/I cannot help/);
      expect(result.response).toMatch(/fault tolerance/);
      // 1 main call + 2 extra candidate samples.
      expect(provider.complete).toHaveBeenCalledTimes(3);
    });

    it('does NOT sample extra candidates when bestOfN is 1 (default)', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');

      const provider = seqProvider([endTurn('Single answer.')]);
      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 5,
        // bestOfN omitted → defaults to 1 (disabled)
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, CAPABLE_MSG);

      expect(result.response).toBe('Single answer.');
      expect(provider.complete).toHaveBeenCalledTimes(1);
    });

    it('does NOT sample extra candidates on a low-tier turn even with bestOfN>1', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');

      const provider = seqProvider([endTurn('hey!')]);
      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 5,
        bestOfN: 3,
      });

      const session = await sessionManager.createSession();
      await agent.processMessage(session.id, 'hi there'); // fast tier → gate closed

      expect(provider.complete).toHaveBeenCalledTimes(1);
    });

    it('aborts stalled best-of-N candidates within the overall turn deadline', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      let calls = 0;
      const sampleSignals: AbortSignal[] = [];
      const provider: LLMProvider = {
        name: 'stalled-sampler',
        isAvailable: () => true,
        complete: vi.fn(async request => {
          calls++;
          if (calls === 1) return endTurn('I cannot help with that.');
          if (request.signal) sampleSignals.push(request.signal);
          return new Promise<CompletionResponse>(() => {});
        }),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider,
        sessionManager: sessions,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 2,
        bestOfN: 3,
        foregroundCallTimeoutMs: 50,
        turnTimeoutMs: 120,
      });

      const started = Date.now();
      const result = await agent.processMessage(session.id, CAPABLE_MSG);
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.response).toBe('I cannot help with that.');
      expect(provider.complete).toHaveBeenCalledTimes(3);
      expect(sampleSignals).toHaveLength(2);
      expect(sampleSignals.every(signal => signal.aborted)).toBe(true);
      const stored = await sessions.getSession(session.id);
      expect(JSON.stringify(stored?.messages.at(-1))).toContain(result.response);
    });
  });

  describe('proactive graduated compaction path', () => {
    it('compacts a large transcript and still returns a response', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const { ContextManager } = await import('../routing/context.js');

      const provider = seqProvider([endTurn('Done summarizing.')]);
      const sessionManager = new SessionManager(db);
      const session = await sessionManager.createSession();

      // Seed the session with a big history of bulky tool outputs to push past
      // the proactive compaction threshold (tiny max context window here).
      for (let i = 0; i < 8; i++) {
        await sessionManager.addMessage(session.id, {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: 'echo' } }],
        });
        await sessionManager.addMessage(session.id, {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'X'.repeat(8000) }],
        });
      }

      const agent = new Agent({
        provider,
        sessionManager,
        contextManager: new ContextManager({ maxContextTokens: 4000, hotWindowSize: 50 }),
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 3,
      });

      const result = await agent.processMessage(session.id, 'wrap up please');
      expect(result.response).toBe('Done summarizing.');
      expect(provider.complete).toHaveBeenCalled();
      const sent = JSON.stringify((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages);
      expect(sent).not.toContain('X'.repeat(100));
    });
  });

  describe('tool execution safety budgets', () => {
    it('never forwards model-authored planning text to progress callbacks', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const privatePlanning = 'INTERNAL: inspect secret payload and then decide what to reveal';
      const provider = seqProvider([
        {
          content: [
            { type: 'text', text: privatePlanning },
            { type: 'tool_use', id: 'unknown-read', name: 'read_file', input: { path: 'x' } },
          ],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('I could not read that file.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const progress: string[] = [];
      const agent = new Agent({
        provider, sessionManager: sessions, workspace: testDir,
        logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      await agent.processMessage(session.id, 'Check a file', undefined, async update => {
        progress.push(update.message);
      });

      expect(progress).toContain('Planning next steps…');
      expect(progress.join('\n')).not.toContain(privatePlanning);
      expect(progress.join('\n')).not.toContain('secret payload');
    });

    it('rejects an anomalous 186-call response without executing a partial batch', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const calls = Array.from({ length: 186 }, (_, index) => ({
        type: 'tool_use' as const,
        id: `tool-${index}`,
        name: 'read_file',
        input: { path: `file-${index}.txt` },
      }));
      const provider = seqProvider([
        {
          content: calls,
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'mock',
        },
        endTurn('I stopped the malformed batch safely.'),
      ]);
      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 3,
      });
      const session = await sessionManager.createSession();

      await agent.processMessage(session.id, 'Read the relevant files');

      const stored = await sessionManager.getSession(session.id);
      const persistedCalls = stored?.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === 'tool_use')
          : [],
      ) ?? [];
      expect(persistedCalls).toHaveLength(0);
      expect(JSON.stringify(stored?.messages)).toContain('above the anomalous-burst guard of 64');
    });

    it('allows more than twenty useful calls when each call makes progress', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn(async ({ args }: { args: Record<string, unknown> }) => ({
        success: true,
        output: `contents:${String(args.path)}`,
      }));
      const skill = {
        name: 'read_file', description: 'Read a file', path: '/tmp/read-file/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'read_file', description: 'Read a file' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'read_file' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const calls = Array.from({ length: 24 }, (_, index) => ({
        type: 'tool_use' as const,
        id: `read-${index}`,
        name: 'read_file',
        input: { path: `file-${index}.txt` },
      }));
      const provider = seqProvider([
        {
          content: calls,
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'mock',
        },
        endTurn('All 24 files were inspected.'),
      ]);
      const sessionManager = new SessionManager(db);
      const agent = new Agent({
        provider,
        sessionManager,
        skillRegistry: registry as any,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 3,
      });
      const session = await sessionManager.createSession();

      const result = await agent.processMessage(session.id, 'Read all 24 files');

      expect(handler).toHaveBeenCalledTimes(24);
      expect(result.response).toBe('All 24 files were inspected.');
      expect(result.completionReason).toBe('natural_end');
    });

    it('does not treat DONE beside a pending tool call as completion', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true,"id":"page-1"}' });
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [
            { type: 'text', text: 'Doing it now. [DONE]' },
            { type: 'tool_use', id: 'notion-1', name: 'notion', input: { action: 'create', date: '2026-07-11' } },
          ],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('The entry was created.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(session.id, 'Log this entry for 2026-07-11');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(result.response).toBe('The entry was created.');
    });

    it('overrides a false success claim when an external write failed', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true,
        hasScripts: true, handler: vi.fn().mockResolvedValue({ success: false, output: '', error: 'HTTP 500' }),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'notion-fail', name: 'notion', input: { action: 'create' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Done — it was successfully logged.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(session.id, 'Log this item');
      expect(result.response).toMatch(/could not verify/i);
      expect(result.completionReason).toBe('tool_loop');
    });

    it('continues a terse logging turn until a real mutation receipt exists', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({
        success: true,
        output: '{"success":true,"page_id":"page-leg-press"}',
      });
      const skill = {
        name: 'notion', description: 'Typed Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Typed Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Typed Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        endTurn('Done — Leg Press was logged to Notion.'),
        {
          content: [{
            type: 'tool_use', id: 'notion-leg-press', name: 'notion',
            input: { action: 'create', database_id: 'gym', properties: { Name: 'Leg Press' } },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Leg Press was logged to Notion.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      await sessions.addMessage(session.id, {
        role: 'assistant',
        content: 'Leg curls were logged to your Notion tracker. Anything else to add?',
      });
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4,
      });

      const result = await agent.processMessage(session.id, 'Leg press - 3x8x110kg');

      expect(provider.complete).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.response).toBe('Leg Press was logged to Notion.');
      expect(result.completionReason).toBe('natural_end');
    });

    it('uses the durable latest reply and exact prior tool for a bare yes continuation', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({
        success: true,
        output: '{"success":true,"page_id":"page-pectoral"}',
      });
      const skill = {
        name: 'notion', description: 'Typed Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Typed Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Typed Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{
            type: 'tool_use', id: 'continue-notion', name: 'notion',
            input: { action: 'create', properties: { Name: 'Pectoral Machine', Weight: 40 } },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Added those exercises to the workout log.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      await sessions.addMessage(session.id, {
        role: 'assistant', content: 'The first three entries were logged.',
      });
      // Simulate a scheduler/background component appending a public message
      // without updating SessionManager's in-memory cache.
      db.addSessionMessage(
        session.id,
        'assistant',
        'Want me to add those last two exercises to your workout log?',
        'assistant_final',
      );
      sessions.reserveToolOperation({
        operationId: 'prior-notion-operation', sessionId: session.id, toolName: 'notion',
        callSignature: 'prior-call', userIntentDigest: 'prior-intent',
      });
      sessions.completeToolOperation('prior-notion-operation', 'succeeded', 'prior-result');
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(session.id, 'Yes!');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.response).toBe('Added those exercises to the workout log.');
      expect(JSON.stringify(handler.mock.calls[0][0].args)).toContain('Pectoral Machine');
    });

    it('lets the model select an arbitrary authoritative capability from metadata', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({
        success: true,
        output: JSON.stringify({
          success: true,
          result: { items: [{ sku: 'A-17', quantity: 12 }, { sku: 'B-04', quantity: 3 }] },
        }),
      });
      const skill = {
        name: 'inventory_lookup',
        description: 'Read current warehouse inventory',
        path: '/tmp/inventory/SKILL.md', source: 'workspace' as const,
        frontmatter: {
          name: 'inventory_lookup', description: 'Read current warehouse inventory',
          metadata: { openclaw: { evidence: { authoritative: true, source: 'inventory-api:v1' } } },
        },
        content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'inventory_lookup' ? skill : null),
        getToolDefinitions: vi.fn(() => [{
          name: 'inventory_lookup', description: 'Read current warehouse inventory',
          input_schema: { type: 'object', properties: { location: { type: 'string' } } },
        }]),
        generateSkillPrompt: vi.fn(() => 'Use inventory_lookup for current warehouse inventory.'),
      };
      const provider = seqProvider([
        {
          content: [{
            type: 'tool_use', id: 'inventory-live-query', name: 'inventory_lookup',
            input: { location: 'main' },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('The live inventory has 12 units of A-17 and 3 units of B-04.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(
        session.id,
        'Check the main warehouse inventory and tell me what is currently in it.',
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(result.response).toContain('12 units of A-17');
      const systemPrompt = JSON.stringify(
        (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].system,
      );
      expect(systemPrompt).toMatch(/choose capabilities|name, description, schema/i);
      expect(systemPrompt).not.toMatch(/\bgym\b|\bworkout\b|chest press/i);
    });

    it('does not rewrite a normal model response with domain-specific postprocessing', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const provider = seqProvider([
        endTurn('Hey! Ready when you are.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 2,
      });

      const result = await agent.processMessage(session.id, 'Hey');
      expect(result.response).toBe('Hey! Ready when you are.');
    });

    it('records real empty output rather than synthetic Success as evidence', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true,
        hasScripts: true, handler: vi.fn().mockResolvedValue({ success: true, output: '' }),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'empty-output', name: 'notion', input: { action: 'create' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Created.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const evidence: Array<{ outputBytes: number; verified: boolean }> = [];
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      await agent.processMessage(session.id, 'Create this Notion page', undefined, async update => {
        if (update.evidence) evidence.push(update.evidence);
      });
      expect(evidence).toContainEqual(expect.objectContaining({ outputBytes: 0, verified: true }));
    });

    it('captures bounded claim digests before raw tool output is discarded', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const skill = {
        name: 'webfetch', description: 'Fetch metrics', path: '/tmp/webfetch/SKILL.md', source: 'workspace' as const,
        frontmatter: {
          name: 'webfetch', description: 'Fetch metrics',
          metadata: { openclaw: { evidence: { authoritative: true, source: 'metrics-api:v1' } } },
        }, content: '', available: true,
        hasScripts: true, handler: vi.fn().mockResolvedValue({ success: true, output: '{"subscribers":455}' }),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'webfetch' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'webfetch', description: 'Fetch metrics', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'metrics-output', name: 'webfetch', input: { url: 'https://example.test' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('The channel has 455 subscribers. [DONE]'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const evidenceUpdates: Array<NonNullable<import('./agent.js').ProgressUpdate['evidence']>> = [];
      const evidenceExecutionContext = buildEvidenceExecutionContext('subscriber report', 'account-a');
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
        evidenceExecutionContext,
      });

      await agent.processMessage(session.id, 'Check the subscriber count', undefined, async update => {
        if (update.evidence) evidenceUpdates.push(update.evidence);
      });
      expect(evidenceUpdates).toContainEqual(expect.objectContaining({
        authority: 'authoritative',
        taskRequestDigest: evidenceExecutionContext.taskRequestDigest,
        accountScopeDigest: evidenceExecutionContext.accountScopeDigest,
        claimDigests: [digestEvidenceClaim('number:455|metric:subscriber')],
      }));
      expect(JSON.stringify(evidenceUpdates)).not.toContain('455');
    });

    it('persists external operation identity and blocks the same write after restart-like retry', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const idempotencyKeys: string[] = [];
      const handler = vi.fn().mockImplementation(async (context: { idempotencyKey?: string }) => {
        idempotencyKeys.push(context.idempotencyKey ?? '');
        return { success: true, output: '{"success":true,"id":"mail-1"}' };
      });
      const skill = {
        name: 'gmail', description: 'Gmail API', path: '/tmp/gmail/SKILL.md', source: 'workspace' as const,
        frontmatter: {
          name: 'gmail', description: 'Gmail API',
          metadata: { openclaw: { safety: { externalWrite: true } } },
        },
        content: '', available: true, hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'gmail' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'gmail', description: 'Gmail API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const toolUse = { type: 'tool_use' as const, id: 'mail-1', name: 'gmail', input: { action: 'send', to: 'a@example.com' } };
      const provider = seqProvider([
        { content: [toolUse], stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock' },
        endTurn('Sent.'),
        { content: [{ ...toolUse, id: 'mail-2' }], stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock' },
        endTurn('Sent.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });
      const message = 'Send this email';

      await agent.processMessage(session.id, message);
      await agent.processMessage(session.id, message);

      expect(handler).toHaveBeenCalledTimes(1);
      const identity = toolOperationIdentity(session.id, message, toolUse);
      expect(db.getToolOperation(identity.operationId)).toEqual(expect.objectContaining({
        status: 'succeeded',
        attemptCount: 1,
      }));
      expect(idempotencyKeys).toEqual([identity.operationId]);
      expect(JSON.stringify(db.getToolOperation(identity.operationId))).not.toContain('a@example.com');
    });

    it('binds a bare confirmation to the prior visible assistant prompt', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true}' });
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'confirmed-write', name: 'notion', input: { action: 'create' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Created.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      await sessions.addMessage(session.id, {
        role: 'assistant',
        content: 'This will create a project entry in Notion. Shall I proceed?',
      });
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      await agent.processMessage(session.id, 'yes');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('executes a requested Notion curl write directly without asking for confirmation', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"object":"page","id":"workout-1"}' });
      const skill = {
        name: 'bash', description: 'Shell', path: '/tmp/bash/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'bash', description: 'Shell' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'bash' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'bash', description: 'Shell', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{
            type: 'tool_use', id: 'confirmed-notion-curl', name: 'bash', input: {
              command: `curl -s -X POST https://api.notion.com/v1/pages --data '{"properties":{"Weight":{"number":14}}}'`,
            },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Logged all four exercises.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(
        session.id,
        'For today, can you log my gym session in our Notion tracker? It was 14 kg, 8 reps, 3 sets.',
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.response).toBe('Logged all four exercises.');
      expect(JSON.stringify(await sessions.getSession(session.id))).not.toContain('SAFETY_EXTERNAL_INTENT_REQUIRED');
      expect(JSON.stringify((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].system))
        .toContain('never ask for a separate confirmation');
    });

    it('captures a planning check-in reply directly and keeps today\'s tasks pending', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true,"id":"board-item"}' });
      const skill = {
        name: 'board', description: 'Task board', path: '/tmp/board/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'board', description: 'Task board' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'board' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'board', description: 'Task board', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [
            { type: 'tool_use', id: 'board-gym', name: 'board', input: { action: 'add', kind: 'task', title: 'Gym', status: 'inbox' } },
            { type: 'tool_use', id: 'board-project', name: 'board', input: { action: 'add', kind: 'task', title: 'Personal projects', status: 'inbox' } },
            { type: 'tool_use', id: 'board-bin', name: 'board', input: { action: 'add', kind: 'nudge', title: 'Put the bin out', trigger_time: 'today 7pm' } },
          ],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Added today\'s priorities and scheduled the bin reminder.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      await sessions.addMessage(session.id, {
        role: 'assistant',
        content: "What's your main priority for today—any deadlines looming or things that need attention?",
      });
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(
        session.id,
        'Gym\nPersonal projects\nWork projects\nMeetings\nPut the bin out at 7pm',
      );

      expect(handler).toHaveBeenCalledTimes(3);
      expect(result.response).toContain('scheduled the bin reminder');
      const stored = JSON.stringify(await sessions.getSession(session.id));
      expect(stored).not.toContain('SAFETY_LOCAL_INTENT_REQUIRED');
      expect(stored).not.toContain('explicitly instruct');
    });

    it('cancels a stale tool plan and re-locks intent when a mid-turn interrupt arrives', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const { InterruptQueue } = await import('./interrupt-queue.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true}' });
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const interrupts = new InterruptQueue({ logger: pino({ level: 'silent' }) });
      let call = 0;
      const toolResponse = (id: string): CompletionResponse => ({
        content: [{ type: 'tool_use', id, name: 'notion', input: { action: 'create' } }],
        stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
      });
      const provider: LLMProvider = {
        name: 'interrupting', isAvailable: () => true,
        complete: vi.fn(async () => {
          call++;
          if (call === 1) {
            interrupts.enqueue({
              sessionId: session.id,
              text: 'Actually, only explain what would happen',
              timestamp: Date.now(),
            });
            return toolResponse('stale-plan');
          }
          if (call === 2) return toolResponse('still-stale');
          return endTurn('I only explained it; nothing was written.');
        }),
      };
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        interruptQueue: interrupts,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4,
      });

      const result = await agent.processMessage(session.id, 'Log this project update');
      expect(handler).not.toHaveBeenCalled();
      expect(result.response).toContain('nothing was written');
      const stored = await sessions.getSession(session.id);
      expect(JSON.stringify(stored?.messages)).toContain('newer user message superseded');
    });
  });

  describe('foreground response watchdog', () => {
    it('does not impose a cumulative deadline on a progressing multi-step turn', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const toolUse = {
        type: 'tool_use' as const,
        id: 'slow-read',
        name: 'slow_read',
        input: {},
      };
      let modelCalls = 0;
      const provider: LLMProvider = {
        name: 'deliberate',
        isAvailable: () => true,
        complete: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 60));
          modelCalls++;
          return modelCalls === 1
            ? {
                content: [toolUse],
                stopReason: 'tool_use',
                usage: { inputTokens: 5, outputTokens: 5 },
                model: 'mock',
              }
            : endTurn('The multi-step result is complete.');
        }),
      };
      const skill = {
        name: 'slow_read', description: 'A deliberate read', path: '/tmp/slow-read/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'slow_read', description: 'A deliberate read' },
        content: '', available: true, hasScripts: true,
        handler: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 60));
          return { success: true, output: 'Verified read result' };
        }),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'slow_read' ? skill : null),
        getToolDefinitions: vi.fn(() => [{
          name: 'slow_read', description: 'A deliberate read',
          input_schema: { type: 'object', properties: {} },
        }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider,
        sessionManager: sessions,
        skillRegistry: registry as any,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 3,
        // No timeout options: neither individual model calls nor the complete
        // progressing turn may inherit a hidden default wall-clock cutoff.
      });

      const started = Date.now();
      const result = await agent.processMessage(session.id, 'Read it, then answer');

      expect(Date.now() - started).toBeGreaterThanOrEqual(160);
      expect(result.response).toBe('The multi-step result is complete.');
      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(skill.handler).toHaveBeenCalledTimes(1);
    });

    it('returns and persists an honest final response when the model stalls', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      let signal: AbortSignal | undefined;
      const provider: LLMProvider = {
        name: 'stalled',
        isAvailable: () => true,
        complete: vi.fn((request) => {
          signal = request.signal;
          return new Promise(() => {});
        }),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider,
        sessionManager: sessions,
        workspace: testDir,
        logger: pino({ level: 'silent' }),
        maxIterations: 2,
        foregroundCallTimeoutMs: 60,
        turnTimeoutMs: 100,
      });

      const started = Date.now();
      const result = await agent.processMessage(session.id, 'Please answer');
      expect(Date.now() - started).toBeLessThan(500);
      expect(signal?.aborted).toBe(true);
      expect(result.response).toMatch(/configured per-call limit/i);
      const stored = await sessions.getSession(session.id);
      expect(JSON.stringify(stored?.messages.at(-1))).toContain(result.response);
    });

    it('covers a stalled native tool with the same turn deadline and marks its write uncertain', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      let handlerSignal: AbortSignal | undefined;
      let idempotencyKey = '';
      const handler = vi.fn().mockImplementation((context: { signal?: AbortSignal; idempotencyKey?: string }) => {
        handlerSignal = context.signal;
        idempotencyKey = context.idempotencyKey ?? '';
        return new Promise(() => {});
      });
      const skill = {
        name: 'gmail', description: 'Gmail API', path: '/tmp/gmail/SKILL.md', source: 'workspace' as const,
        frontmatter: {
          name: 'gmail', description: 'Gmail API',
          metadata: { openclaw: { safety: { externalWrite: true } } },
        },
        content: '', available: true, hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'gmail' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'gmail', description: 'Gmail API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const toolUse = { type: 'tool_use' as const, id: 'mail-stall', name: 'gmail', input: { action: 'send', to: 'a@example.com' } };
      const provider = seqProvider([{
        content: [toolUse], stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
      }]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
        foregroundCallTimeoutMs: 50, turnTimeoutMs: 100,
      });

      const started = Date.now();
      const result = await agent.processMessage(session.id, 'Send this email');
      expect(Date.now() - started).toBeLessThan(500);
      expect(handlerSignal?.aborted).toBe(true);
      expect(result.response).toMatch(/whole-turn limit/i);
      expect(db.getToolOperation(idempotencyKey)?.status).toBe('uncertain');
      const stored = await sessions.getSession(session.id);
      expect(JSON.stringify(stored?.messages.at(-1))).toContain(result.response);
    });
  });

  describe('Kimi stress regressions', () => {
    it('blocks user-facing success progress before any mutation receipt exists', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const send = vi.fn(async () => ({ success: true, output: 'Message sent' }));
      const skill = {
        name: 'send_message', description: 'send', path: '/tmp/send/SKILL.md', source: 'sdk' as const,
        frontmatter: { name: 'send_message', description: 'send', metadata: { openclaw: { safety: { externalWrite: true } } } },
        content: '', available: true, hasScripts: true, handler: send,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'send_message' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'send_message', description: 'send', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'progress', name: 'send_message', input: { message: 'Done — the 8 page PDF was created successfully.' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'kimi-mock',
        },
        endTurn('I have not created the PDF yet.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, skillRegistry: registry as any, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3 });
      const result = await agent.processMessage(session.id, 'Build a competitor report PDF');
      expect(send).not.toHaveBeenCalled();
      expect(result.response).toMatch(/not created/i);
      expect(JSON.stringify((await sessions.getSession(session.id))?.messages)).toContain('UNVERIFIED_PROGRESS_CLAIM');
    });

    it('quarantines invented competitor figures while retaining sourced figures', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const webfetch = {
        name: 'webfetch', description: 'fetch', path: '/tmp/webfetch/SKILL.md', source: 'bundled' as const,
        frontmatter: { name: 'webfetch', description: 'fetch', metadata: { openclaw: { safety: { readOnly: true } } } },
        content: '', available: true, hasScripts: true,
        handler: vi.fn(async () => ({ success: true, output: 'LandTech says it is trusted by 5,000 UK developers.' })),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'webfetch' ? webfetch : null),
        getToolDefinitions: vi.fn(() => [{ name: 'webfetch', description: 'fetch', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'source', name: 'webfetch', input: { url: 'https://land.tech' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'kimi-mock',
        },
        endTurn('LandTech is trusted by 5,000 UK developers.\nIt has £30M in funding and could enter Ireland with €1M.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, skillRegistry: registry as any, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3 });
      const result = await agent.processMessage(session.id, 'Research and analyze the competitor market');
      expect(result.response).toContain('5,000 UK developers');
      expect(result.response).not.toContain('£30M');
      expect(result.response).not.toContain('€1M');
      expect(result.response).toContain('omitted factual figures');
    });

    // Was six: the per-turn failure-family breaker now ends the loop at the 4th failure.
    it('stops changing tools after four identical safety failures', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      let calls = 0;
      const provider: LLMProvider = {
        name: 'kimi-stress-mock', isAvailable: () => true,
        complete: vi.fn(async () => ({
          content: [{ type: 'tool_use', id: `write-${calls}`, name: 'run_code', input: { language: 'python', code: `open("file-${calls++}","w").write("x")` } }],
          stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 }, model: 'kimi-mock',
        })),
      };
      const runCode = {
        name: 'run_code', description: 'run', path: '/tmp/run/SKILL.md', source: 'bundled' as const,
        frontmatter: { name: 'run_code', description: 'run', metadata: { openclaw: { safety: { localWrite: true } } } },
        content: '', available: true, hasScripts: true,
        handler: vi.fn(async () => ({ success: true, output: 'should never run' })),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'run_code' ? runCode : null),
        getToolDefinitions: vi.fn(() => [{ name: 'run_code', description: 'run', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, skillRegistry: registry as any, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 20 });
      const result = await agent.processMessage(session.id, 'Explain why PDF creation failed; do not change files');
      expect(result.completionReason).toBe('tool_loop');
      expect(provider.complete).toHaveBeenCalledTimes(4);
      expect(runCode.handler).not.toHaveBeenCalled();
      expect(result.response).toMatch(/Repeated failure circuit breaker/i);
    });
  });

  describe('receipt-less promises, identical-call refusal and escalation guard', () => {
    const NOTION_REQUEST = 'For today, can you log my gym session in our Notion tracker? It was 14 kg, 8 reps, 3 sets.';
    const PROMISE = "Logging today's session (2026-08-10):\n- Pectoral machine 45kg x6x3\n\nI'll get these into Notion now.";

    function bashRegistry(handler: ReturnType<typeof vi.fn>) {
      const skill = {
        name: 'bash', description: 'Shell', path: '/tmp/bash/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'bash', description: 'Shell' }, content: '', available: true,
        hasScripts: true, handler,
      };
      return {
        getSkill: vi.fn((name: string) => name === 'bash' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'bash', description: 'Shell', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
    }

    const notionCurl = (id: string) => ({
      content: [{
        type: 'tool_use' as const, id, name: 'bash', input: {
          command: `curl -s -X POST https://api.notion.com/v1/pages --data '{"properties":{"Weight":{"number":14}}}'`,
        },
      }],
      stopReason: 'tool_use' as const, usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
    });

    it('replaces a receipt-less write promise with an honest reply after one corrective retry', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: 'never called' });
      const provider = seqProvider([endTurn(PROMISE), endTurn(PROMISE)]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: bashRegistry(handler) as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4,
      });

      // "log" sits mid-sentence, so this must not depend on the intent regex
      // recognising the turn as a mutation: the draft itself promises one.
      const result = await agent.processMessage(
        session.id,
        'In my notion tracker log this for today\n\nPectoral machine 45kgx6x3',
      );

      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(JSON.stringify((provider.complete as ReturnType<typeof vi.fn>).mock.calls[1][0]))
        .toContain('Your draft promises to perform a write');
      expect(handler).not.toHaveBeenCalled();
      expect(result.response).toMatch(/^I have not written this anywhere yet\./);
      expect(result.response).toContain('Pectoral machine 45kg x6x3');
      expect(result.response).not.toMatch(/I'll|Logging today/);
      expect(result.completionReason).toBe('tool_loop');
    });

    it('lets the model recover from a promise by calling the tool on the corrective retry', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"object":"page","id":"workout-1"}' });
      const provider = seqProvider([
        endTurn("I'll add these to Notion now."),
        notionCurl('promise-then-write'),
        endTurn('Logged your session to Notion.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: bashRegistry(handler) as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4,
      });

      const result = await agent.processMessage(session.id, NOTION_REQUEST);

      expect(provider.complete).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.response).toBe('Logged your session to Notion.');
      expect(result.completionReason).toBe('natural_end');
    });

    it('never sends "All logged" for a bare Yes to a proactive proposal when no tool ran', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true}' });
      const skill = {
        name: 'notion', description: 'Typed Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Typed Notion API' }, content: '', available: true,
        hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Typed Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      // The 14 Jul transcript: proposal → "Yes!" → "All logged! ✅" with no tool call.
      const provider = seqProvider([endTurn('All logged! ✅'), endTurn('All logged! ✅')]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      db.addSessionMessage(
        session.id, 'assistant',
        'Want me to add those last two exercises to your workout log?',
        'assistant_final',
      );
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 3,
      });

      const result = await agent.processMessage(
        session.id,
        '[Replying to You (assistant): "Want me to add those last two exercises to your workout log?"]\n\nYes!',
      );

      expect(handler).not.toHaveBeenCalled();
      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(result.response).not.toMatch(/All logged/);
      expect(result.response).toMatch(/have not|did not/i);
      expect(result.completionReason).toBe('tool_loop');
    });

    it('refuses the identical failing call after three tries and ends the turn on the fourth', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({
        success: false, output: '', error: 'HTTP 400 body.properties.Name.id should be defined',
      });
      let calls = 0;
      const provider: LLMProvider = {
        name: 'retry-mock', isAvailable: () => true,
        complete: vi.fn(async () => notionCurl(`same-${calls++}`)),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: bashRegistry(handler) as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 20,
      });

      const result = await agent.processMessage(session.id, NOTION_REQUEST);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(provider.complete).toHaveBeenCalledTimes(4);
      const transcript = JSON.stringify(await sessions.getSession(session.id));
      expect(transcript).toContain('Identical call already failed 3 times; change the arguments or stop');
      expect(transcript).toContain('will be refused from now on');
      expect(result.completionReason).toBe('tool_loop');
      expect(result.response).toMatch(/Repeated failure circuit breaker/i);
    });

    it('short-circuits bash escalation to a policy-blocked target and states the real cause', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const notionHandler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true}' });
      const bashHandler = vi.fn().mockResolvedValue({ success: true, output: '{"object":"page"}' });
      const skills: Record<string, any> = {
        notion: {
          name: 'notion', description: 'Typed Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
          frontmatter: { name: 'notion', description: 'Typed Notion API' }, content: '', available: true,
          hasScripts: true, handler: notionHandler,
        },
        bash: {
          name: 'bash', description: 'Shell', path: '/tmp/bash/SKILL.md', source: 'workspace' as const,
          frontmatter: { name: 'bash', description: 'Shell' }, content: '', available: true,
          hasScripts: true, handler: bashHandler,
        },
      };
      const registry = {
        getSkill: vi.fn((name: string) => skills[name] ?? null),
        getToolDefinitions: vi.fn(() => Object.keys(skills).map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } }))),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        {
          content: [{
            type: 'tool_use', id: 'unrequested-notion', name: 'notion',
            input: { action: 'create', database_id: '1801c5f6-386c-927e-228b-2a0b29321df0', properties: { Name: 'Leg press' } },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        notionCurl('escalate-curl'),
        endTurn('The clawdbot integration lacks access to the database. Please share the database with the integration and add it manually.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 5,
      });

      const result = await agent.processMessage(
        session.id,
        'Explain why my last Notion log failed; do not change anything.',
      );

      expect(notionHandler).not.toHaveBeenCalled();
      expect(bashHandler).not.toHaveBeenCalled();
      const transcript = JSON.stringify(await sessions.getSession(session.id));
      expect(transcript).toContain('SAFETY_EXTERNAL_INTENT_REQUIRED');
      expect(transcript).toContain('BLOCKED_ESCALATION: the same policy applies to every tool. Ask the user the one-line confirmation question instead.');
      expect(result.response).toContain('not because of any integration, permission, or platform limit');
      expect(result.response).toContain('Reply "yes"');
    });
  });

  describe('Kimi stress regressions (context bounding)', () => {

    it('bounds the active-turn working set instead of replaying every large result', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const requestSizes: number[] = [];
      let modelCall = 0;
      const provider: LLMProvider = {
        name: 'kimi-context-stress', isAvailable: () => true,
        complete: vi.fn(async request => {
          requestSizes.push(JSON.stringify(request.messages).length);
          modelCall++;
          if (modelCall === 10) return endTurn('Finished with a bounded working set.');
          return {
            content: [{ type: 'tool_use', id: `large-${modelCall}`, name: 'large_read', input: { page: modelCall } }],
            stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 }, model: 'kimi-mock',
          };
        }),
      };
      const largeRead = {
        name: 'large_read', description: 'large read', path: '/tmp/large/SKILL.md', source: 'sdk' as const,
        frontmatter: { name: 'large_read', description: 'large read', metadata: { openclaw: { safety: { readOnly: true } } } },
        content: '', available: true, hasScripts: true,
        handler: vi.fn(async ({ args }: { args: Record<string, unknown> }) => ({
          success: true,
          output: `page:${args.page}\n${String(args.page).repeat(22_000)}`,
        })),
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'large_read' ? largeRead : null),
        getToolDefinitions: vi.fn(() => [{ name: 'large_read', description: 'large read', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, skillRegistry: registry as any, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 12 });
      const result = await agent.processMessage(session.id, 'Inspect these large pages and summarize');
      expect(result.response).toContain('bounded working set');
      expect(requestSizes).toHaveLength(10);
      expect(requestSizes[7]).toBeLessThan(requestSizes[6]);
      expect(Math.max(...requestSizes.slice(7))).toBeLessThan(requestSizes[6] * 1.4);
    });
  });

  describe('tool recipes (procedural memory)', () => {
    const GYM_DB = '1801c5f6-386c-927e-228b-2a0b29321df0';

    function notionRegistry(handler: ReturnType<typeof vi.fn>) {
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API', triggers: ['notion', 'database', 'tracker'] },
        content: '', available: true, hasScripts: true, handler,
      };
      return {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
    }

    const systemPromptOf = (provider: LLMProvider, call: number): string =>
      JSON.stringify((provider.complete as ReturnType<typeof vi.fn>).mock.calls[call][0].system ?? '');

    it('records a successful mutating call and injects WORKING CALLS on the next turn that mentions the tool', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"success":true,"id":"page-1"}' });
      const provider = seqProvider([
        {
          content: [{
            type: 'tool_use', id: 'notion-1', name: 'notion',
            input: { action: 'create', database_id: GYM_DB, notion_token: 'secret-x', properties: { Name: 'Leg Press', Date: '2026-08-21', Type: 'Machine', Sets: 3, Reps: 9, 'Weight (kg)': 110 } },
          }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Logged: Leg Press 110kg x9x3.'),
        endTurn('Logged: Pectoral machine 40kg x9x3.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: notionRegistry(handler) as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4,
      });

      await agent.processMessage(session.id, 'Log in notion tracker: Leg Press 110kg x9x3');
      expect(handler).toHaveBeenCalledTimes(1);
      // First turn had no recipe yet.
      expect(systemPromptOf(provider, 0)).not.toContain('## WORKING CALLS');

      const recipes = getToolRecipeStore().list('default', 'notion');
      expect(recipes).toHaveLength(1);
      expect(recipes[0].action).toBe('create');
      expect(recipes[0].targetSummary).toBe(`database_id ${GYM_DB}`);
      expect(recipes[0].inputShape.properties).toMatchObject({ Name: 'string', Date: 'date', Sets: 'number' });
      expect(JSON.stringify(recipes[0].exampleInput)).not.toContain('secret-x');
      // Persisted to the configured data dir with owner-only permissions.
      const file = path.join(testDir, 'tool-recipes.json');
      expect(((await fs.stat(file)).mode & 0o777)).toBe(0o600);

      // Second turn: a bare data continuation after the bot's Notion confirmation.
      await agent.processMessage(session.id, 'Pectoral machine - 40kg x9x3');
      const prompt = systemPromptOf(provider, 2);
      expect(prompt).toContain('## WORKING CALLS (recent successes');
      expect(prompt).toContain(`notion create → database_id ${GYM_DB}, properties {Name: string, Date: date, Type: string, Sets: number, Reps: number, Weight (kg): number}`);
      expect(prompt).toContain('Use ids only from tool output in this conversation or from WORKING CALLS');
    });

    it('does not record failed mutating calls but keeps the error family for the next success', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn()
        .mockResolvedValueOnce({ success: false, output: '', error: 'HTTP 404 object_not_found: Could not find database with ID: bogus. Make sure the relevant pages and databases are shared' })
        .mockResolvedValueOnce({ success: true, output: '{"success":true,"id":"page-2"}' });
      const provider = seqProvider([
        {
          content: [{ type: 'tool_use', id: 'n-fail', name: 'notion', input: { action: 'create', database_id: 'bogus', properties: { Name: 'Row' } } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        {
          content: [{ type: 'tool_use', id: 'n-ok', name: 'notion', input: { action: 'create', database_id: GYM_DB, properties: { Name: 'Row', Sets: 3 } } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Logged: Row.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: notionRegistry(handler) as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 5,
      });

      await agent.processMessage(session.id, 'Log in notion: Row 3 sets');
      const [recipe] = getToolRecipeStore().list('default', 'notion');
      expect(recipe.successCount).toBe(1);
      expect(recipe.targetSummary).toBe(`database_id ${GYM_DB}`);
      expect(recipe.lastFailureHint).toBe('not_found (HTTP 404)');
    });
  });

  describe('malformed-turn recovery nudges', () => {
    it('nudges an empty end_turn with "continue exactly where you left off" and returns the follow-up', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const provider = seqProvider([
        { content: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 }, model: 'mock' },
        endTurn('The capital of France is Paris.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 4 });

      const result = await agent.processMessage(session.id, 'What is the capital of France?');
      expect(result.response).toBe('The capital of France is Paris.');
      expect(provider.complete).toHaveBeenCalledTimes(2);
      const secondRequest = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const nudge = secondRequest.messages.at(-1);
      expect(nudge.role).toBe('user');
      expect(nudge.content).toBe(EMPTY_TURN_NUDGE);
    });

    it('nudges "Let me check…" prose that made no tool call, then runs the call', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const handler = vi.fn().mockResolvedValue({ success: true, output: '{"results":[{"Name":"Leg Press","Sets":3}]}' });
      const skill = {
        name: 'notion', description: 'Notion API', path: '/tmp/notion/SKILL.md', source: 'workspace' as const,
        frontmatter: { name: 'notion', description: 'Notion API' }, content: '', available: true, hasScripts: true, handler,
      };
      const registry = {
        getSkill: vi.fn((name: string) => name === 'notion' ? skill : null),
        getToolDefinitions: vi.fn(() => [{ name: 'notion', description: 'Notion API', input_schema: { type: 'object', properties: {} } }]),
        generateSkillPrompt: vi.fn(() => ''),
      };
      const provider = seqProvider([
        endTurn('Let me check the tracker for your last session.'),
        {
          content: [{ type: 'tool_use', id: 'q1', name: 'notion', input: { action: 'query', database_id: 'db-1' } }],
          stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 }, model: 'mock',
        },
        endTurn('Your last session was Leg Press, 3 sets.'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({
        provider, sessionManager: sessions, skillRegistry: registry as any,
        workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 5,
      });

      const result = await agent.processMessage(session.id, 'What did I do last session?');
      expect(result.response).toBe('Your last session was Leg Press, 3 sets.');
      expect(handler).toHaveBeenCalledTimes(1);
      const secondRequest = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(secondRequest.messages.at(-1).content).toBe(UNMADE_TOOL_CALL_NUDGE);
    });

    it('stops after two nudges instead of looping', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      const provider = seqProvider([
        endTurn('Let me check the calendar now.'),
        endTurn('Let me check the calendar now.'),
        endTurn('Let me check the calendar now.'),
        endTurn('should never be reached'),
      ]);
      const sessions = new SessionManager(db);
      const session = await sessions.createSession();
      const agent = new Agent({ provider, sessionManager: sessions, workspace: testDir, logger: pino({ level: 'silent' }), maxIterations: 6 });

      const result = await agent.processMessage(session.id, 'What is on my calendar today?');
      expect(provider.complete).toHaveBeenCalledTimes(3);
      expect(result.response).toBe('Let me check the calendar now.');
    });
  });
});
