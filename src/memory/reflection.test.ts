/**
 * Tests for Self-Reflection Module
 *
 * Tests the reflect() pure function that generates composite reflections
 * from session summaries and re-distills SOUL.md behavioral guidelines.
 *
 * Covers all 7 behavior cases:
 * 1. No sessions → skipped
 * 2. Sessions below minMessages threshold → skipped
 * 3. Valid sessions, null SOUL → insights + initial SOUL
 * 4. Valid sessions, existing SOUL → insights + re-distilled SOUL
 * 5. Malformed JSON for reflection → fallback single raw insight
 * 6. Malformed JSON for SOUL → updatedSoul: null
 * 7. SOUL output exceeds maxSoulWords → truncate at sentence boundary
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionSummaryRow } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import {
  reflect,
  buildReflectionPrompt,
  buildSoulDistillationPrompt,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionResult,
  type ReflectionInsight,
} from './reflection.js';

// ============ Test Helpers ============

/** Create a minimal SessionSummaryRow for testing */
function makeSummary(overrides: Partial<SessionSummaryRow> & { sessionId: string }): SessionSummaryRow {
  return {
    id: `summary-${overrides.sessionId}`,
    userId: 'default',
    summary: `Summary of session ${overrides.sessionId}`,
    topics: ['general'],
    messageCount: 10,
    durationMs: 60000,
    embedding: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Create a mock LLMProvider that returns controlled responses for sequential calls */
function createSequentialMockProvider(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-sequential',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => {
      const text = responses[callIndex] ?? '';
      callIndex++;
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse;
    }),
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

// ============ Tests: DEFAULT_REFLECTION_CONFIG ============

describe('DEFAULT_REFLECTION_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_REFLECTION_CONFIG.minSessions).toBe(1);
    expect(DEFAULT_REFLECTION_CONFIG.minMessagesPerSession).toBe(3);
    expect(DEFAULT_REFLECTION_CONFIG.maxSoulWords).toBe(600);
  });
});

// ============ Tests: buildReflectionPrompt ============

describe('buildReflectionPrompt', () => {
  it('returns a CompletionRequest with system prompt for composite reflection', () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'Discussed TypeScript best practices', topics: ['typescript', 'coding'], messageCount: 10 }),
      makeSummary({ sessionId: 's2', summary: 'Debugged a React component', topics: ['react', 'debugging'], messageCount: 8 }),
    ];

    const prompt = buildReflectionPrompt(summaries);

    expect(prompt.system).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe('user');
    // Should request JSON output with insights and principles
    expect(prompt.system).toContain('JSON');
    expect(prompt.system).toContain('insights');
    expect(prompt.system).toContain('principles');
  });

  it('includes session summaries with topics and message counts in user message', () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'Discussed TypeScript best practices', topics: ['typescript', 'coding'], messageCount: 10 }),
    ];

    const prompt = buildReflectionPrompt(summaries);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('Discussed TypeScript best practices');
    expect(userContent).toContain('typescript');
    expect(userContent).toContain('10');
  });

  it('follows composite reflection type: explanation + principles + advice', () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'A session', topics: ['topic1'], messageCount: 5 }),
    ];

    const prompt = buildReflectionPrompt(summaries);

    // System prompt should reference composite reflection elements
    const system = prompt.system!.toLowerCase();
    expect(system).toMatch(/explain|explanation/);
    expect(system).toMatch(/principle/);
    expect(system).toMatch(/pattern|advice|procedure/);
  });
});

// ============ Tests: buildSoulDistillationPrompt ============

describe('buildSoulDistillationPrompt', () => {
  it('creates initial SOUL prompt when currentSoul is null', () => {
    const insights: ReflectionInsight[] = [
      { content: 'User prefers concise answers', topics: ['communication'], sourceSessionIds: ['s1'] },
    ];
    const principles = ['Be concise', 'Avoid jargon'];

    const prompt = buildSoulDistillationPrompt(null, insights, principles);

    expect(prompt.system).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe('user');

    const userContent = prompt.messages[0].content as string;
    expect(userContent).toContain('User prefers concise answers');
    expect(userContent).toContain('Be concise');
  });

  it('creates re-distillation prompt when currentSoul exists', () => {
    const currentSoul = '# SOUL\nBe helpful and kind.';
    const insights: ReflectionInsight[] = [
      { content: 'User prefers technical depth', topics: ['communication'], sourceSessionIds: ['s1'] },
    ];
    const principles = ['Go deeper technically'];

    const prompt = buildSoulDistillationPrompt(currentSoul, insights, principles);

    const userContent = prompt.messages[0].content as string;
    expect(userContent).toContain('Be helpful and kind');
    expect(userContent).toContain('User prefers technical depth');
    expect(userContent).toContain('Go deeper technically');
  });

  it('enforces 400-600 word target in prompt', () => {
    const prompt = buildSoulDistillationPrompt(null, [], []);

    const system = prompt.system!;
    expect(system).toContain('400');
    expect(system).toContain('600');
  });
});

// ============ Tests: reflect() — 7 behavior cases ============

describe('reflect', () => {
  // Case 1: No sessions
  it('returns skipped when no sessions provided', async () => {
    const provider = createMockProvider('');

    const result = await reflect([], null, provider);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No qualifying sessions');
    expect(result.insights).toHaveLength(0);
    expect(result.updatedSoul).toBeNull();
    // LLM should not be called
    expect(provider.complete).not.toHaveBeenCalled();
  });

  // Case 2: Sessions below minMessages threshold
  it('returns skipped when all sessions have fewer than minMessagesPerSession messages', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', messageCount: 2 }),
      makeSummary({ sessionId: 's2', messageCount: 1 }),
    ];

    const provider = createMockProvider('');

    const result = await reflect(summaries, null, provider);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No sessions with sufficient depth');
    expect(result.insights).toHaveLength(0);
    expect(result.updatedSoul).toBeNull();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  // Case 3: Valid sessions, null SOUL → LLM call 1 + LLM call 2
  it('generates insights and creates initial SOUL when currentSoul is null', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'Discussed TypeScript patterns', topics: ['typescript'], messageCount: 10 }),
      makeSummary({ sessionId: 's2', summary: 'Debugged a React component', topics: ['react'], messageCount: 8 }),
    ];

    const reflectionResponse = JSON.stringify({
      insights: [
        { content: 'User values type safety in code', topics: ['typescript', 'coding'] },
        { content: 'User prefers step-by-step debugging', topics: ['debugging'] },
      ],
      principles: ['Always provide type annotations', 'Break down debugging into steps'],
    });

    const soulResponse = '# SOUL Guidelines\n\nYou are a technical assistant. Always provide type annotations in code examples. Break down debugging into clear steps.';

    const provider = createSequentialMockProvider([reflectionResponse, soulResponse]);

    const result = await reflect(summaries, null, provider);

    expect(result.skipped).toBe(false);
    expect(result.insights).toHaveLength(2);
    expect(result.insights[0].content).toBe('User values type safety in code');
    expect(result.insights[0].topics).toContain('typescript');
    expect(result.insights[0].sourceSessionIds).toContain('s1');
    expect(result.insights[0].sourceSessionIds).toContain('s2');
    expect(result.updatedSoul).toContain('SOUL');
    // Two LLM calls: reflection + distillation
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  // Case 4: Valid sessions, existing SOUL → re-distillation
  it('generates insights and re-distills existing SOUL', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'Explored advanced Node.js patterns', topics: ['nodejs'], messageCount: 5 }),
    ];

    const currentSoul = '# Existing SOUL\n\nBe helpful and thorough.';

    const reflectionResponse = JSON.stringify({
      insights: [
        { content: 'User is interested in advanced Node.js patterns', topics: ['nodejs'] },
      ],
      principles: ['Provide advanced examples when appropriate'],
    });

    const soulResponse = '# Updated SOUL\n\nBe helpful and thorough. Provide advanced Node.js examples when the user shows interest in advanced patterns.';

    const provider = createSequentialMockProvider([reflectionResponse, soulResponse]);

    const result = await reflect(summaries, currentSoul, provider);

    expect(result.skipped).toBe(false);
    expect(result.insights).toHaveLength(1);
    expect(result.updatedSoul).toContain('Updated SOUL');
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  // Case 5: LLM returns malformed JSON for reflection → fallback single raw insight
  it('creates fallback raw insight when reflection LLM returns malformed JSON', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'A conversation about coding', topics: ['coding'], messageCount: 5 }),
    ];

    const malformedReflection = 'The user seems to prefer concise explanations and dislikes verbose responses.';
    const soulResponse = '# SOUL\n\nKeep responses concise.';

    const provider = createSequentialMockProvider([malformedReflection, soulResponse]);

    const result = await reflect(summaries, null, provider);

    expect(result.skipped).toBe(false);
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].content).toBe(malformedReflection);
    expect(result.insights[0].sourceSessionIds).toContain('s1');
    // SOUL distillation should still be attempted
    expect(result.updatedSoul).toContain('SOUL');
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  // Case 6: LLM returns malformed JSON for SOUL → updatedSoul: null
  it('sets updatedSoul to null when SOUL LLM returns empty/malformed response', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'A conversation', topics: ['general'], messageCount: 5 }),
    ];

    const reflectionResponse = JSON.stringify({
      insights: [
        { content: 'User likes clear answers', topics: ['communication'] },
      ],
      principles: ['Be clear'],
    });

    const emptySoulResponse = '';

    const provider = createSequentialMockProvider([reflectionResponse, emptySoulResponse]);

    const result = await reflect(summaries, 'existing soul content', provider);

    expect(result.skipped).toBe(false);
    expect(result.insights).toHaveLength(1);
    expect(result.updatedSoul).toBeNull();
  });

  // Case 7: SOUL output exceeds maxSoulWords → truncate at sentence boundary
  it('truncates SOUL output to maxSoulWords at last complete sentence', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'A conversation', topics: ['general'], messageCount: 5 }),
    ];

    const reflectionResponse = JSON.stringify({
      insights: [
        { content: 'An insight', topics: ['topic'] },
      ],
      principles: ['A principle'],
    });

    // Generate a SOUL response that exceeds 10 words (we'll use maxSoulWords: 10 for testing)
    const longSoulResponse = 'First sentence here. Second sentence goes here. Third sentence is also here. Fourth sentence too.';

    const provider = createSequentialMockProvider([reflectionResponse, longSoulResponse]);

    const config: ReflectionConfig = {
      ...DEFAULT_REFLECTION_CONFIG,
      maxSoulWords: 10,
    };

    const result = await reflect(summaries, null, provider, config);

    expect(result.skipped).toBe(false);
    expect(result.updatedSoul).not.toBeNull();
    // Should be truncated — word count should not exceed maxSoulWords
    const wordCount = result.updatedSoul!.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(10);
    // Should end at a sentence boundary (period, exclamation, or question mark)
    expect(result.updatedSoul!.trim()).toMatch(/[.!?]$/);
  });

  // Additional: filters sessions by minMessagesPerSession
  it('only passes sessions meeting minMessagesPerSession to LLM', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', summary: 'Short session', topics: ['a'], messageCount: 2 }),
      makeSummary({ sessionId: 's2', summary: 'Long session about coding', topics: ['coding'], messageCount: 10 }),
    ];

    const reflectionResponse = JSON.stringify({
      insights: [
        { content: 'User enjoys coding', topics: ['coding'] },
      ],
      principles: ['Focus on code'],
    });

    const soulResponse = '# SOUL\n\nFocus on code.';

    const provider = createSequentialMockProvider([reflectionResponse, soulResponse]);

    const result = await reflect(summaries, null, provider);

    expect(result.skipped).toBe(false);
    // Only s2 qualifies, so sourceSessionIds should only contain s2
    expect(result.insights[0].sourceSessionIds).toContain('s2');
    expect(result.insights[0].sourceSessionIds).not.toContain('s1');
  });

  // Additional: custom config override
  it('accepts partial config overrides', async () => {
    const summaries = [
      makeSummary({ sessionId: 's1', messageCount: 5 }),
    ];

    const reflectionResponse = JSON.stringify({
      insights: [{ content: 'Insight', topics: ['t'] }],
      principles: ['p'],
    });

    const soulResponse = 'Short soul.';

    const provider = createSequentialMockProvider([reflectionResponse, soulResponse]);

    // Override minMessagesPerSession to require 10 messages
    const result = await reflect(summaries, null, provider, { minMessagesPerSession: 10 });

    // Session with 5 messages should be filtered out
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No sessions with sufficient depth');
  });
});
