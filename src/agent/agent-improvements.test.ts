import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { ScallopDatabase } from '../memory/db.js';

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
  });
  afterEach(async () => {
    db.close();
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
    });
  });
});
