/**
 * Tests for the unified gap pipeline.
 *
 * Covers:
 * - buildGapPipelinePrompt: prompt construction, dial guidance, affect, topics
 * - parseGapPipelineResponse: output parsing, skip/nudge/task handling, fail-safe
 * - wordOverlap + isDuplicate: deduplication helpers
 * - runGapPipeline: orchestrator with dedup, budget caps, hard cap
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildGapPipelinePrompt,
  parseGapPipelineResponse,
  runGapPipeline,
  wordOverlap,
  isDuplicate,
  DIAL_THRESHOLDS,
} from './gap-pipeline.js';
import type { GapSignal } from './gap-scanner.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

// ============ Test Helpers ============

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

function makeAffect(emotion: string = 'neutral'): SmoothedAffect {
  return {
    valence: 0,
    arousal: 0,
    emotion,
    confidence: 0.8,
  } as SmoothedAffect;
}

function makeMockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: response }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock',
    } satisfies CompletionResponse),
  };
}

// ============ buildGapPipelinePrompt ============

describe('buildGapPipelinePrompt', () => {
  it('returns a CompletionRequest with system and user messages', () => {
    const prompt = buildGapPipelinePrompt([makeSignal()], 'moderate', null, []);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe('user');
    expect(prompt.system).toBeTruthy();
  });

  it('includes dial guidance in system prompt', () => {
    const conservative = buildGapPipelinePrompt([makeSignal()], 'conservative', null, []);
    expect(conservative.system).toContain('conservative');
    expect(conservative.system).toContain('Only act on clearly stale');

    const eager = buildGapPipelinePrompt([makeSignal()], 'eager', null, []);
    expect(eager.system).toContain('eager');
    expect(eager.system).toContain('Act on most signals');
  });

  it('includes user mood from affect', () => {
    const prompt = buildGapPipelinePrompt([makeSignal()], 'moderate', makeAffect('happy'), []);
    expect(prompt.system).toContain('happy');
  });

  it('uses unknown when affect is null', () => {
    const prompt = buildGapPipelinePrompt([makeSignal()], 'moderate', null, []);
    expect(prompt.system).toContain('unknown');
  });

  it('includes recent topics when provided', () => {
    const prompt = buildGapPipelinePrompt([makeSignal()], 'moderate', null, ['rust', 'coding']);
    expect(prompt.system).toContain('rust');
    expect(prompt.system).toContain('coding');
  });

  it('includes numbered signal list in user message', () => {
    const signals = [makeSignal(), makeSignal({ type: 'unresolved_thread', description: 'Question about TypeScript' })];
    const prompt = buildGapPipelinePrompt(signals, 'moderate', null, []);
    expect(prompt.messages[0].content).toContain('1. [stale_goal]');
    expect(prompt.messages[0].content).toContain('2. [unresolved_thread]');
  });

  it('explains nudge vs task in system prompt', () => {
    const prompt = buildGapPipelinePrompt([makeSignal()], 'moderate', null, []);
    expect(prompt.system).toContain('nudge');
    expect(prompt.system).toContain('task');
    expect(prompt.system).toContain('skip');
  });
});

// ============ parseGapPipelineResponse ============

describe('parseGapPipelineResponse', () => {
  const signals = [makeSignal()];

  it('parses a nudge response correctly', () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'nudge', message: 'Hey, how is Rust going?' }],
    });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nudge');
    expect(result[0].message).toBe('Hey, how is Rust going?');
    expect(result[0].taskConfig).toBeNull();
    expect(result[0].gapType).toBe('stale_goal');
    expect(result[0].sourceId).toBe('goal-1');
  });

  it('parses a task response correctly', () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'task', message: 'Checking flight status...', goal: 'Look up flight EK204', tools: ['web_search'] }],
    });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('task');
    expect(result[0].taskConfig).toEqual({ goal: 'Look up flight EK204', tools: ['web_search'] });
  });

  it('skips entries with action=skip', () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'skip' }],
    });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(0);
  });

  it('returns empty array on invalid JSON', () => {
    const result = parseGapPipelineResponse('not json', signals);
    expect(result).toEqual([]);
  });

  it('returns empty array on empty response', () => {
    const result = parseGapPipelineResponse('', signals);
    expect(result).toEqual([]);
  });

  it('skips entries with out-of-range index', () => {
    const response = JSON.stringify({
      items: [{ index: 5, action: 'nudge', message: 'Hello' }],
    });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(0);
  });

  it('handles missing items array gracefully', () => {
    const response = JSON.stringify({ gaps: [] });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toEqual([]);
  });

  it('extracts JSON from response with surrounding text', () => {
    const response = `Here is my analysis:\n${JSON.stringify({
      items: [{ index: 1, action: 'nudge', message: 'Check in' }],
    })}\n\nDone.`;
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(1);
  });

  it('uses signal description as fallback when message missing', () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'nudge' }],
    });
    const result = parseGapPipelineResponse(response, signals);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('Learn Rust');
  });
});

// ============ wordOverlap + isDuplicate ============

describe('wordOverlap', () => {
  it('returns 1.0 for identical strings', () => {
    expect(wordOverlap('check the stale goal', 'check the stale goal')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(wordOverlap('hello world', 'foo bar baz')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(wordOverlap('', 'hello world')).toBe(0);
  });

  it('handles partial overlap', () => {
    const overlap = wordOverlap('check the stale goal progress', 'check the stale project status');
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });
});

describe('isDuplicate', () => {
  it('returns true for high word overlap', () => {
    expect(isDuplicate(
      'Check in on the stale goal and update progress',
      'goal-1',
      [{ message: 'Check in on the stale goal and update progress', context: null }],
    )).toBe(true);
  });

  it('returns true for matching sourceId', () => {
    expect(isDuplicate(
      'Completely different message',
      'goal-1',
      [{ message: 'Another message', context: JSON.stringify({ sourceId: 'goal-1' }) }],
    )).toBe(true);
  });

  it('returns false when no match', () => {
    expect(isDuplicate(
      'New unique message about something',
      'goal-new',
      [{ message: 'Existing different message', context: JSON.stringify({ sourceId: 'goal-2' }) }],
    )).toBe(false);
  });
});

// ============ DIAL_THRESHOLDS ============

describe('DIAL_THRESHOLDS', () => {
  it('conservative has lowest daily cap', () => {
    expect(DIAL_THRESHOLDS.conservative.maxDailyNotifications).toBe(1);
  });

  it('eager has highest daily cap', () => {
    expect(DIAL_THRESHOLDS.eager.maxDailyNotifications).toBe(5);
  });

  it('moderate is between conservative and eager', () => {
    expect(DIAL_THRESHOLDS.moderate.maxDailyNotifications).toBeGreaterThan(
      DIAL_THRESHOLDS.conservative.maxDailyNotifications,
    );
    expect(DIAL_THRESHOLDS.moderate.maxDailyNotifications).toBeLessThan(
      DIAL_THRESHOLDS.eager.maxDailyNotifications,
    );
  });
});

// ============ runGapPipeline ============

describe('runGapPipeline', () => {
  it('returns empty array when no signals', async () => {
    const provider = makeMockProvider('{}');
    const result = await runGapPipeline({
      signals: [],
      dial: 'moderate',
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('calls provider and returns parsed items', async () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'nudge', message: 'How is Rust going?' }],
    });
    const provider = makeMockProvider(response);
    const result = await runGapPipeline({
      signals: [makeSignal()],
      dial: 'moderate',
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nudge');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('deduplicates against existing items', async () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'nudge', message: 'How is Rust going?' }],
    });
    const provider = makeMockProvider(response);
    const result = await runGapPipeline({
      signals: [makeSignal()],
      dial: 'moderate',
      affect: null,
      recentTopics: [],
      existingItems: [{ message: 'How is Rust going?', context: null }],
      userId: 'user-1',
    }, provider);
    expect(result).toHaveLength(0);
  });

  it('enforces budget cap per dial', async () => {
    const signals = Array.from({ length: 5 }, (_, i) =>
      makeSignal({ sourceId: `goal-${i}`, description: `Stale goal #${i}` }),
    );
    const items = signals.map((_, i) => ({
      index: i + 1,
      action: 'nudge',
      message: `Check on goal ${i}`,
    }));
    const provider = makeMockProvider(JSON.stringify({ items }));

    const result = await runGapPipeline({
      signals,
      dial: 'conservative', // maxDailyNotifications=1, but hard cap is 3 → effective cap=1
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('enforces hard cap of 3', async () => {
    const signals = Array.from({ length: 5 }, (_, i) =>
      makeSignal({ sourceId: `goal-${i}`, description: `Stale goal #${i}` }),
    );
    const items = signals.map((_, i) => ({
      index: i + 1,
      action: 'nudge',
      message: `Check on goal ${i}`,
    }));
    const provider = makeMockProvider(JSON.stringify({ items }));

    const result = await runGapPipeline({
      signals,
      dial: 'eager', // maxDailyNotifications=5, but hard cap is 3
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array on provider error (fail-safe)', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      isAvailable: () => true,
      complete: vi.fn().mockRejectedValue(new Error('LLM failure')),
    };

    const result = await runGapPipeline({
      signals: [makeSignal()],
      dial: 'moderate',
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result).toEqual([]);
  });

  it('passes task items through with taskConfig', async () => {
    const response = JSON.stringify({
      items: [{ index: 1, action: 'task', message: 'Checking...', goal: 'Search weather', tools: ['web_search'] }],
    });
    const provider = makeMockProvider(response);
    const result = await runGapPipeline({
      signals: [makeSignal()],
      dial: 'moderate',
      affect: null,
      recentTopics: [],
      existingItems: [],
      userId: 'user-1',
    }, provider);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('task');
    expect(result[0].taskConfig?.goal).toBe('Search weather');
    expect(result[0].taskConfig?.tools).toEqual(['web_search']);
  });
});
