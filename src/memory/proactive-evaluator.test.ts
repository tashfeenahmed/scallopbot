import { describe, it, expect } from 'vitest';
import { buildEvaluatorPrompt, parseEvaluatorResponse } from './proactive-evaluator.js';
import type { GapSignal } from './gap-scanner.js';

function makeSignal(overrides?: Partial<GapSignal>): GapSignal {
  return {
    type: 'unresolved_thread',
    severity: 'low',
    description: 'Recent session follow-up',
    context: { sessionId: 'session-1' },
    sourceId: 'summary-1',
    ...overrides,
  };
}

describe('parseEvaluatorResponse', () => {
  it('accepts user-facing nudge messages', () => {
    const result = parseEvaluatorResponse(
      JSON.stringify({
        items: [{ index: 1, action: 'nudge', message: 'Hey, how did the prototype review go?', urgency: 'low' }],
      }),
      [makeSignal()],
    );

    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Hey, how did the prototype review go?');
  });

  it('skips instruction-shaped nudge messages', () => {
    const result = parseEvaluatorResponse(
      JSON.stringify({
        items: [{ index: 1, action: 'nudge', message: 'The assistant should ask the user about the prototype.', urgency: 'low' }],
      }),
      [makeSignal()],
    );

    expect(result).toEqual([]);
  });

  it('grounds evaluation in the recent chat transcript', () => {
    const prompt = buildEvaluatorPrompt({
      sessionSummary: null,
      behavioralPatterns: null,
      activeGoals: [],
      boardItems: [],
      allSessionSummaries: [{
        id: 'earlier-session',
        sessionId: 'session-earlier',
        userId: 'telegram:42',
        summary: 'The user was preparing the prototype review and asked for a follow-up later.',
        topics: ['prototype review'],
        messageCount: 4,
        durationMs: 10 * 60_000,
        embedding: null,
        createdAt: 1_705_000_000_000,
      }],
      existingItems: [],
      dial: 'moderate',
      affect: null,
      lastProactiveAt: null,
      activeHours: [],
      userId: 'telegram:42',
      recentChatContext: 'User: I already finished the prototype review.\nAssistant: Great work.',
    }, [makeSignal()]);

    expect(prompt.system).toContain('Deliberate privately');
    expect(String(prompt.messages[0].content)).toContain('I already finished the prototype review.');
    expect(String(prompt.messages[0].content)).toContain('preparing the prototype review');
  });
});
