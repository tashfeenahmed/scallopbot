import { describe, it, expect } from 'vitest';
import { parseEvaluatorResponse } from './proactive-evaluator.js';
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
});
