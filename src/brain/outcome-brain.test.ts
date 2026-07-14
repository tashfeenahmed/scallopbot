import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import { OutcomeBrain } from './outcome-brain.js';
import { Agent } from '../agent/agent.js';
import { SessionManager } from '../agent/session.js';

function routerDecision(payload: Record<string, unknown>) {
  return {
    executeWithFallback: vi.fn().mockResolvedValue({
      response: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'test-model',
      },
      provider: 'test',
      attemptedProviders: ['test'],
    }),
  };
}

describe('OutcomeBrain', () => {
  it('keeps foreground reasoning private and stores only hashed receipts', async () => {
    const db = new ScallopDatabase(':memory:');
    try {
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }) });
      const decision = await brain.decideMessage({
        source: 'foreground',
        userId: 'user-1',
        sessionId: 'session-1',
        activeRequest: 'What happened?',
        messages: [
          '<think>PRIVATE_CHAIN_OF_THOUGHT</think>\nWe need to answer the user clearly.\nHere is the useful answer.',
        ],
      });

      expect(decision).toMatchObject({
        brainId: 'outcome-brain:primary',
        decision: 'send',
        message: 'Here is the useful answer.',
        revised: true,
      });
      const receipts = db.getRecentBrainOutcomes('user-1');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        brainId: 'outcome-brain:primary',
        source: 'foreground',
        kind: 'message',
        decision: 'revised',
      });
      expect(JSON.stringify(receipts)).not.toContain('PRIVATE_CHAIN_OF_THOUGHT');
      expect(receipts[0].proposalDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(receipts[0].contextDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it('turns an internal proactive instruction into one natural final message', async () => {
    const db = new ScallopDatabase(':memory:');
    const router = routerDecision({
      decision: 'send',
      message: 'Anything from today worth carrying forward?',
      reason_code: 'timely_reflection',
    });
    try {
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }), router: router as any });
      const decision = await brain.decideMessage({
        source: 'proactive',
        userId: 'user-1',
        messages: ['Evening check-in with Jordan - recap what happened today, any follow-ups needed'],
      });

      expect(decision.message).toBe('Anything from today worth carrying forward?');
      expect(decision.message).not.toMatch(/check-in with|recap what happened|follow-ups needed/i);
      const request = router.executeWithFallback.mock.calls[0][0];
      expect(request.enableThinking).toBe(false);
      expect(request.purpose).toBe('outcome_brain');
      expect(request.system).toContain('single final outcome brain');
      expect(request.messages[0].content).toContain('recentConversation');
    } finally {
      db.close();
    }
  });

  it('durably suppresses a duplicate autonomous proposal before a second model call', async () => {
    const db = new ScallopDatabase(':memory:');
    const router = routerDecision({ decision: 'send', message: 'Your report is ready.', reason_code: 'useful_result' });
    try {
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }), router: router as any });
      const proposal = {
        source: 'task_result' as const,
        userId: 'user-1',
        messages: ['The verified report is ready.'],
        evidenceVerified: true,
      };
      expect((await brain.decideMessage(proposal)).decision).toBe('send');
      expect(await brain.decideMessage(proposal)).toMatchObject({
        decision: 'suppress',
        reasonCode: 'brain_exact_duplicate',
      });
      expect(router.executeWithFallback).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('fails closed for inferred outreach but preserves a safe verified result on model outage', async () => {
    const db = new ScallopDatabase(':memory:');
    const router = { executeWithFallback: vi.fn().mockRejectedValue(new Error('offline')) };
    try {
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }), router: router as any });
      expect(await brain.decideMessage({
        source: 'proactive',
        userId: 'user-1',
        messages: ['Maybe send the user a check-in.'],
      })).toMatchObject({ decision: 'suppress', reasonCode: 'brain_model_unavailable' });

      expect(await brain.decideMessage({
        source: 'task_result',
        userId: 'user-1',
        messages: ['The import failed after three verified attempts.'],
        evidenceVerified: true,
      })).toMatchObject({
        decision: 'send',
        message: 'The import failed after three verified attempts.',
        reasonCode: 'verified_fallback',
      });
    } finally {
      db.close();
    }
  });

  it('uses the same brain for actions and cleans public communication arguments', async () => {
    const db = new ScallopDatabase(':memory:');
    try {
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }) });
      const decision = await brain.decideAction({
        source: 'foreground',
        userId: 'user-1',
        sessionId: 'session-1',
        turn: { userMessage: 'Send me the update', timezone: 'UTC' },
        toolUse: {
          type: 'tool_use',
          id: 'call-1',
          name: 'send_message',
          input: { message: '<think>PRIVATE_TOOL_THOUGHT</think>The update is ready.' },
        },
        skill: {
          name: 'send_message',
          description: 'send a message',
          path: '',
          source: 'sdk',
          instructions: '',
          hasScripts: false,
          frontmatter: {
            name: 'send_message',
            description: 'send a message',
            metadata: { openclaw: { safety: { externalWrite: true, publicCommunication: true } } },
          },
        } as any,
      });

      expect(decision.brainId).toBe('outcome-brain:primary');
      expect(decision.assessment.allowed).toBe(true);
      expect(decision.toolUse.input).toEqual({ message: 'The update is ready.' });
      expect(db.getRecentBrainOutcomes('user-1')[0]).toMatchObject({ kind: 'action', decision: 'approved' });
    } finally {
      db.close();
    }
  });

  it('places the brain before both durable foreground history and the channel response', async () => {
    const db = new ScallopDatabase(':memory:');
    try {
      const sessions = new SessionManager(db);
      const session = await sessions.createSession({ userId: 'telegram:42' });
      const provider = {
        name: 'test',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: '<think>CHANNEL_SECRET</think>\nWe need to answer the user now.\nIt is sorted.',
          }],
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 5 },
          model: 'test-model',
        }),
      };
      const brain = new OutcomeBrain({ db, logger: pino({ level: 'silent' }) });
      const agent = new Agent({
        provider: provider as any,
        sessionManager: sessions,
        outcomeBrain: brain,
        workspace: process.cwd(),
        logger: pino({ level: 'silent' }),
        maxIterations: 3,
      });

      const result = await agent.processMessage(session.id, 'Sort it out');
      expect(result.response).toBe('It is sorted.');
      const stored = await sessions.getSession(session.id);
      expect(stored?.messages.at(-1)).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'It is sorted.' }],
      });
      expect(JSON.stringify(stored?.messages)).not.toContain('CHANNEL_SECRET');
      expect(db.getRecentBrainOutcomes('telegram:42')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
