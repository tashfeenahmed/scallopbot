/**
 * Tests for Inner Thoughts Evaluation Module.
 *
 * Covers four exported functions:
 * 1. shouldRunInnerThoughts — pure pre-filter (no LLM)
 * 2. buildInnerThoughtsPrompt — pure prompt builder
 * 3. parseInnerThoughtsResponse — pure JSON response parser
 * 4. evaluateInnerThoughts — async orchestrator (mock provider)
 *
 * Fail-safe invariant: all error paths produce skip decision.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import type { GapSignal } from './gap-scanner.js';
import type { SessionSummaryRow } from './db.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import {
  shouldRunInnerThoughts,
  buildInnerThoughtsPrompt,
  parseInnerThoughtsResponse,
  evaluateInnerThoughts,
  type InnerThoughtsInput,
  type InnerThoughtsResult,
} from './inner-thoughts.js';

// ============ Test Helpers ============

/** Create a minimal SessionSummaryRow for testing */
function makeSession(overrides?: Partial<SessionSummaryRow>): SessionSummaryRow {
  return {
    id: 'sess-1',
    sessionId: 'session-abc',
    userId: 'user-1',
    summary: 'User discussed project progress and upcoming deadlines.',
    topics: ['project', 'deadlines'],
    messageCount: 10,
    durationMs: 600_000,
    embedding: null,
    createdAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

/** Create a minimal GapSignal for testing */
function makeSignal(overrides?: Partial<GapSignal>): GapSignal {
  return {
    type: 'stale_goal',
    severity: 'medium',
    description: 'Goal "Learn Rust" has not been updated in 20 days',
    context: { goalTitle: 'Learn Rust', daysSinceUpdate: 20 },
    sourceId: 'goal-1',
    ...overrides,
  };
}

/** Create a minimal SmoothedAffect for testing */
function makeAffect(overrides?: Partial<SmoothedAffect>): SmoothedAffect {
  return {
    valence: 0.5,
    arousal: 0.3,
    emotion: 'happy',
    goalSignal: 'stable',
    ...overrides,
  };
}

/** Create a minimal InnerThoughtsInput for testing */
function makeInput(overrides?: Partial<InnerThoughtsInput>): InnerThoughtsInput {
  return {
    sessionSummary: makeSession(),
    recentGapSignals: [],
    affect: null,
    dial: 'moderate',
    lastProactiveAt: null,
    activeHours: [9, 10, 11, 14, 15, 16],
    ...overrides,
  };
}

/** Create a mock LLMProvider that returns a single response text */
function createMockProvider(responseText: string): LLMProvider {
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

/** Create a mock LLMProvider that rejects with an error */
function createFailingProvider(error: Error): LLMProvider {
  return {
    name: 'mock-failing',
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(error),
  };
}

// ============ shouldRunInnerThoughts ============

describe('shouldRunInnerThoughts', () => {
  const NOW = 1_700_000_000_000;

  it('returns false when lastProactive within 6h', () => {
    const input = makeInput({
      lastProactiveAt: NOW - 3_600_000, // 1h ago
      recentGapSignals: [makeSignal()],
      dial: 'eager',
    });

    expect(shouldRunInnerThoughts(input, NOW)).toBe(false);
  });

  it('returns false when user distressed', () => {
    const input = makeInput({
      affect: makeAffect({ goalSignal: 'user_distressed' }),
      recentGapSignals: [makeSignal()],
      dial: 'eager',
    });

    expect(shouldRunInnerThoughts(input, NOW)).toBe(false);
  });

  it('returns false when session too short (< 3 messages)', () => {
    const input = makeInput({
      sessionSummary: makeSession({ messageCount: 2 }),
      recentGapSignals: [makeSignal()],
      dial: 'eager',
    });

    expect(shouldRunInnerThoughts(input, NOW)).toBe(false);
  });

  it('returns true when gap signals exist', () => {
    const input = makeInput({
      recentGapSignals: [makeSignal()],
      dial: 'conservative',
    });

    expect(shouldRunInnerThoughts(input, NOW)).toBe(true);
  });

  it('returns true when dial is moderate/eager with no signals', () => {
    const inputModerate = makeInput({ dial: 'moderate', recentGapSignals: [] });
    const inputEager = makeInput({ dial: 'eager', recentGapSignals: [] });

    expect(shouldRunInnerThoughts(inputModerate, NOW)).toBe(true);
    expect(shouldRunInnerThoughts(inputEager, NOW)).toBe(true);
  });

  it('returns false when conservative with no signals', () => {
    const input = makeInput({
      dial: 'conservative',
      recentGapSignals: [],
    });

    expect(shouldRunInnerThoughts(input, NOW)).toBe(false);
  });
});

// ============ buildInnerThoughtsPrompt ============

describe('buildInnerThoughtsPrompt', () => {
  it('returns CompletionRequest with correct structure', () => {
    const input = makeInput({ recentGapSignals: [makeSignal()] });
    const prompt = buildInnerThoughtsPrompt(input);

    expect(prompt.system).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe('user');
    expect(prompt.temperature).toBe(0.2);
    expect(prompt.maxTokens).toBe(200);
  });

  it('includes gap signals in user message when present', () => {
    const input = makeInput({
      recentGapSignals: [
        makeSignal({ type: 'stale_goal', description: 'Goal is stale' }),
        makeSignal({ type: 'behavioral_anomaly', description: 'Frequency drop', sourceId: 'sig-2' }),
      ],
    });
    const prompt = buildInnerThoughtsPrompt(input);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('stale_goal');
    expect(userContent).toContain('behavioral_anomaly');
    expect(userContent).toContain('Goal is stale');
    expect(userContent).toContain('Frequency drop');
  });

  it('includes "None" for gap signals when empty', () => {
    const input = makeInput({ recentGapSignals: [] });
    const prompt = buildInnerThoughtsPrompt(input);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('None');
  });

  it('includes affect emotion when available, "unknown" when null', () => {
    const withAffect = makeInput({
      affect: makeAffect({ emotion: 'happy' }),
    });
    const withoutAffect = makeInput({ affect: null });

    const promptWith = buildInnerThoughtsPrompt(withAffect);
    const promptWithout = buildInnerThoughtsPrompt(withoutAffect);

    expect(promptWith.system!).toContain('happy');
    expect(promptWithout.system!).toContain('unknown');
  });
});

// ============ parseInnerThoughtsResponse ============

describe('parseInnerThoughtsResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      decision: 'proact',
      reason: 'User has unresolved goal',
      message: 'How is your Rust learning going?',
      urgency: 'medium',
    });

    const result = parseInnerThoughtsResponse(response);

    expect(result.decision).toBe('proact');
    expect(result.reason).toBe('User has unresolved goal');
    expect(result.message).toBe('How is your Rust learning going?');
    expect(result.urgency).toBe('medium');
  });

  it('handles markdown-wrapped JSON', () => {
    const response = '```json\n{"decision": "wait", "reason": "Not urgent yet", "urgency": "low"}\n```';

    const result = parseInnerThoughtsResponse(response);

    expect(result.decision).toBe('wait');
    expect(result.reason).toBe('Not urgent yet');
    expect(result.urgency).toBe('low');
  });

  it('returns skip on invalid JSON', () => {
    const response = 'This is not valid JSON at all';

    const result = parseInnerThoughtsResponse(response);

    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('Failed to parse LLM response');
    expect(result.urgency).toBe('low');
  });

  it('returns skip on invalid decision value', () => {
    const response = JSON.stringify({
      decision: 'invalid_value',
      reason: 'Some reason',
      urgency: 'medium',
    });

    const result = parseInnerThoughtsResponse(response);

    expect(result.decision).toBe('skip');
    expect(result.urgency).toBe('low');
  });

  it('defaults urgency to low if missing', () => {
    const response = JSON.stringify({
      decision: 'proact',
      reason: 'Goal needs attention',
      message: 'Check in on goal',
    });

    const result = parseInnerThoughtsResponse(response);

    expect(result.decision).toBe('proact');
    expect(result.urgency).toBe('low');
  });
});

// ============ evaluateInnerThoughts ============

describe('evaluateInnerThoughts', () => {
  it('returns skip when pre-filter rejects', async () => {
    const input = makeInput({
      sessionSummary: makeSession({ messageCount: 1 }), // too short
    });
    const provider = createMockProvider('{}');

    const result = await evaluateInnerThoughts(input, provider);

    expect(result.decision).toBe('skip');
    expect(result.urgency).toBe('low');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('calls LLM and returns parsed result on success', async () => {
    const input = makeInput({
      recentGapSignals: [makeSignal()],
      dial: 'moderate',
    });
    const llmResponse = JSON.stringify({
      decision: 'proact',
      reason: 'Stale goal detected',
      message: 'How is your Rust learning going?',
      urgency: 'medium',
    });
    const provider = createMockProvider(llmResponse);

    const result = await evaluateInnerThoughts(input, provider);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.decision).toBe('proact');
    expect(result.reason).toBe('Stale goal detected');
    expect(result.message).toBe('How is your Rust learning going?');
    expect(result.urgency).toBe('medium');
  });

  it('returns skip on LLM error (fail-safe)', async () => {
    const input = makeInput({
      recentGapSignals: [makeSignal()],
      dial: 'eager',
    });
    const provider = createFailingProvider(new Error('API timeout'));

    const result = await evaluateInnerThoughts(input, provider);

    expect(result.decision).toBe('skip');
    expect(result.reason).toContain('LLM error');
    expect(result.reason).toContain('API timeout');
    expect(result.urgency).toBe('low');
  });
});
