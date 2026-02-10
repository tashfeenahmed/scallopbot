/**
 * Tests for LLM Gap Diagnosis (Stage 2).
 *
 * Covers three exported functions:
 * 1. buildGapDiagnosisPrompt — pure prompt builder
 * 2. parseGapDiagnosis — pure JSON response parser
 * 3. diagnoseGaps — async orchestrator (mock provider)
 *
 * Fail-safe invariant: all error paths produce not-actionable gaps.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import type { GapSignal } from './gap-scanner.js';
import {
  buildGapDiagnosisPrompt,
  parseGapDiagnosis,
  diagnoseGaps,
  type DiagnosedGap,
  type UserContext,
} from './gap-diagnosis.js';

// ============ Test Helpers ============

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

/** Create a minimal UserContext for testing */
function makeUserContext(overrides?: Partial<UserContext>): UserContext {
  return {
    affect: null,
    dial: 'moderate',
    recentTopics: [],
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

// ============ buildGapDiagnosisPrompt ============

describe('buildGapDiagnosisPrompt', () => {
  it('returns a CompletionRequest with system and user messages', () => {
    const signals = [makeSignal()];
    const ctx = makeUserContext();
    const prompt = buildGapDiagnosisPrompt(signals, ctx);

    expect(prompt.system).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe('user');
  });

  it('sets temperature to 0.2 and maxTokens to 800', () => {
    const prompt = buildGapDiagnosisPrompt([makeSignal()], makeUserContext());

    expect(prompt.temperature).toBe(0.2);
    expect(prompt.maxTokens).toBe(800);
  });

  it('system prompt contains proactive assistant role', () => {
    const prompt = buildGapDiagnosisPrompt([makeSignal()], makeUserContext());

    expect(prompt.system!.toLowerCase()).toContain('proactive');
    expect(prompt.system!.toLowerCase()).toContain('assistant');
  });

  it('system prompt contains "when in doubt NOT actionable" rule', () => {
    const prompt = buildGapDiagnosisPrompt([makeSignal()], makeUserContext());

    const system = prompt.system!.toLowerCase();
    expect(system).toContain('not actionable');
  });

  it('system prompt includes proactiveness dial value', () => {
    const prompt = buildGapDiagnosisPrompt(
      [makeSignal()],
      makeUserContext({ dial: 'eager' }),
    );

    expect(prompt.system!).toContain('eager');
  });

  it('system prompt includes user mood from affect', () => {
    const prompt = buildGapDiagnosisPrompt(
      [makeSignal()],
      makeUserContext({
        affect: {
          valence: 0.5,
          arousal: 0.3,
          emotion: 'happy',
          goalSignal: 'stable',
        },
      }),
    );

    expect(prompt.system!).toContain('happy');
  });

  it('system prompt uses "unknown" when affect is null', () => {
    const prompt = buildGapDiagnosisPrompt(
      [makeSignal()],
      makeUserContext({ affect: null }),
    );

    expect(prompt.system!).toContain('unknown');
  });

  it('system prompt instructs JSON-only response format', () => {
    const prompt = buildGapDiagnosisPrompt([makeSignal()], makeUserContext());

    expect(prompt.system!).toContain('JSON');
  });

  it('user message contains numbered signal list with type, severity, description', () => {
    const signals = [
      makeSignal({ type: 'stale_goal', severity: 'high', description: 'Overdue goal' }),
      makeSignal({ type: 'behavioral_anomaly', severity: 'low', description: 'Frequency drop', sourceId: 'sig-2' }),
    ];
    const prompt = buildGapDiagnosisPrompt(signals, makeUserContext());

    const userContent = prompt.messages[0].content as string;
    expect(userContent).toContain('1.');
    expect(userContent).toContain('2.');
    expect(userContent).toContain('stale_goal');
    expect(userContent).toContain('behavioral_anomaly');
    expect(userContent).toContain('high');
    expect(userContent).toContain('low');
    expect(userContent).toContain('Overdue goal');
    expect(userContent).toContain('Frequency drop');
  });

  it('handles empty signals array with valid prompt', () => {
    const prompt = buildGapDiagnosisPrompt([], makeUserContext());

    expect(prompt.system).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.temperature).toBe(0.2);
    expect(prompt.maxTokens).toBe(800);
  });

  it('includes recent topics in system prompt when provided', () => {
    const prompt = buildGapDiagnosisPrompt(
      [makeSignal()],
      makeUserContext({ recentTopics: ['rust', 'webdev'] }),
    );

    const system = prompt.system!;
    expect(system).toContain('rust');
    expect(system).toContain('webdev');
  });
});

// ============ parseGapDiagnosis ============

describe('parseGapDiagnosis', () => {
  it('parses valid JSON response and maps gaps to signals', () => {
    const signals = [
      makeSignal({ sourceId: 'g1', description: 'Stale goal' }),
      makeSignal({ sourceId: 'g2', description: 'Anomaly', type: 'behavioral_anomaly' }),
    ];

    const response = JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.85, diagnosis: 'This goal needs attention', suggestedAction: 'Ask about progress' },
        { index: 1, actionable: false, confidence: 0.3, diagnosis: 'Normal variation', suggestedAction: 'No action needed' },
      ],
    });

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(2);
    expect(result[0].signal).toBe(signals[0]);
    expect(result[0].actionable).toBe(true);
    expect(result[0].confidence).toBe(0.85);
    expect(result[0].diagnosis).toBe('This goal needs attention');
    expect(result[0].suggestedAction).toBe('Ask about progress');
    expect(result[1].signal).toBe(signals[1]);
    expect(result[1].actionable).toBe(false);
  });

  it('returns all signals as not-actionable on invalid JSON', () => {
    const signals = [makeSignal(), makeSignal({ sourceId: 'g2' })];
    const response = 'This is not valid JSON at all';

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(2);
    expect(result.every(g => g.actionable === false)).toBe(true);
    expect(result.every(g => g.confidence === 0)).toBe(true);
  });

  it('defaults missing fields to actionable=false, confidence=0', () => {
    const signals = [makeSignal()];
    const response = JSON.stringify({
      gaps: [
        { index: 0 }, // missing actionable, confidence, diagnosis, suggestedAction
      ],
    });

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(1);
    expect(result[0].actionable).toBe(false);
    expect(result[0].confidence).toBe(0);
    expect(result[0].diagnosis).toBe('');
    expect(result[0].suggestedAction).toBe('');
  });

  it('skips entries with out-of-range index', () => {
    const signals = [makeSignal()];
    const response = JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.9, diagnosis: 'Valid', suggestedAction: 'Do something' },
        { index: 5, actionable: true, confidence: 0.8, diagnosis: 'Invalid index', suggestedAction: 'Should be skipped' },
        { index: -1, actionable: true, confidence: 0.7, diagnosis: 'Negative index', suggestedAction: 'Also skipped' },
      ],
    });

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(1);
    expect(result[0].signal).toBe(signals[0]);
  });

  it('handles empty response string as invalid JSON', () => {
    const signals = [makeSignal()];
    const result = parseGapDiagnosis('', signals);

    expect(result).toHaveLength(1);
    expect(result[0].actionable).toBe(false);
    expect(result[0].confidence).toBe(0);
  });

  it('handles JSON with missing gaps array', () => {
    const signals = [makeSignal()];
    const response = JSON.stringify({ something: 'else' });

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(1);
    expect(result[0].actionable).toBe(false);
    expect(result[0].confidence).toBe(0);
  });

  it('handles empty signals array with valid JSON', () => {
    const response = JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.9, diagnosis: 'Something', suggestedAction: 'Do it' },
      ],
    });

    const result = parseGapDiagnosis(response, []);

    expect(result).toHaveLength(0);
  });

  it('extracts JSON from response with surrounding text', () => {
    const signals = [makeSignal()];
    const response = `Here is the analysis:\n${JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.7, diagnosis: 'Needs attention', suggestedAction: 'Follow up' },
      ],
    })}\nEnd of analysis.`;

    const result = parseGapDiagnosis(response, signals);

    expect(result).toHaveLength(1);
    expect(result[0].actionable).toBe(true);
    expect(result[0].confidence).toBe(0.7);
  });
});

// ============ diagnoseGaps ============

describe('diagnoseGaps', () => {
  it('returns empty array when signals are empty', async () => {
    const provider = createMockProvider('');
    const result = await diagnoseGaps([], makeUserContext(), provider);

    expect(result).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('calls provider.complete with built prompt and parses response', async () => {
    const signals = [
      makeSignal({ sourceId: 'g1', description: 'Stale goal' }),
    ];
    const ctx = makeUserContext({ dial: 'conservative' });

    const llmResponse = JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.8, diagnosis: 'Goal is stale', suggestedAction: 'Check in with user' },
      ],
    });

    const provider = createMockProvider(llmResponse);
    const result = await diagnoseGaps(signals, ctx, provider);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].signal).toBe(signals[0]);
    expect(result[0].actionable).toBe(true);
    expect(result[0].confidence).toBe(0.8);
    expect(result[0].diagnosis).toBe('Goal is stale');
    expect(result[0].suggestedAction).toBe('Check in with user');
  });

  it('returns all signals as not-actionable on LLM error (fail safe)', async () => {
    const signals = [
      makeSignal({ sourceId: 'g1' }),
      makeSignal({ sourceId: 'g2', type: 'unresolved_thread' }),
    ];
    const ctx = makeUserContext();

    const provider = createFailingProvider(new Error('LLM API timeout'));
    const result = await diagnoseGaps(signals, ctx, provider);

    expect(result).toHaveLength(2);
    expect(result.every(g => g.actionable === false)).toBe(true);
    expect(result.every(g => g.confidence === 0)).toBe(true);
    expect(result[0].signal).toBe(signals[0]);
    expect(result[1].signal).toBe(signals[1]);
  });

  it('returns DiagnosedGap[] with correct shape', async () => {
    const signals = [makeSignal()];
    const llmResponse = JSON.stringify({
      gaps: [
        { index: 0, actionable: false, confidence: 0.4, diagnosis: 'Not urgent', suggestedAction: 'Monitor' },
      ],
    });

    const provider = createMockProvider(llmResponse);
    const result = await diagnoseGaps(signals, makeUserContext(), provider);

    expect(result).toHaveLength(1);
    const gap = result[0];
    expect(gap).toHaveProperty('signal');
    expect(gap).toHaveProperty('diagnosis');
    expect(gap).toHaveProperty('actionable');
    expect(gap).toHaveProperty('suggestedAction');
    expect(gap).toHaveProperty('confidence');
    expect(typeof gap.diagnosis).toBe('string');
    expect(typeof gap.actionable).toBe('boolean');
    expect(typeof gap.suggestedAction).toBe('string');
    expect(typeof gap.confidence).toBe('number');
  });

  it('handles provider returning content as ContentBlock array', async () => {
    const signals = [makeSignal()];
    const llmResponse = JSON.stringify({
      gaps: [
        { index: 0, actionable: true, confidence: 0.6, diagnosis: 'Action needed', suggestedAction: 'Remind user' },
      ],
    });

    const provider: LLMProvider = {
      name: 'mock-blocks',
      isAvailable: () => true,
      complete: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: llmResponse.slice(0, 20) },
          { type: 'text', text: llmResponse.slice(20) },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse),
    };

    const result = await diagnoseGaps(signals, makeUserContext(), provider);

    expect(result).toHaveLength(1);
    expect(result[0].actionable).toBe(true);
  });
});
