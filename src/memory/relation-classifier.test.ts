/**
 * Tests for LLM-based Relationship Classifier
 *
 * The classifier determines how new facts relate to existing facts:
 * - NEW: Completely new information
 * - UPDATES: Replaces/contradicts existing fact
 * - EXTENDS: Adds more info about same entity/topic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RelationshipClassifier,
  ClassificationResult,
  createRelationshipClassifier
} from './relation-classifier.js';
import type { LLMProvider } from '../providers/types.js';

// Mock LLM provider
function createMockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    complete: vi.fn().mockResolvedValue({
      content: response,
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  } as unknown as LLMProvider;
}

describe('RelationshipClassifier', () => {
  describe('classify', () => {
    it('should classify a NEW fact when no similar facts exist', async () => {
      const provider = createMockProvider('{"classification": "NEW", "reason": "No similar facts found"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Flatmate is Bob', subject: 'user', category: 'relationship' },
        [] // No existing facts
      );

      expect(result.classification).toBe('NEW');
    });

    it('should classify UPDATES when new fact contradicts existing', async () => {
      const provider = createMockProvider('{"classification": "UPDATES", "targetId": "fact-1", "reason": "Location changed from Metropolis to Springfield"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Lives in Springfield', subject: 'user', category: 'location' },
        [{ id: 'fact-1', content: 'Lives in Metropolis', subject: 'user', category: 'location' }]
      );

      expect(result.classification).toBe('UPDATES');
      expect(result.targetId).toBe('fact-1');
    });

    it('should classify EXTENDS when new fact adds info about same entity', async () => {
      const provider = createMockProvider('{"classification": "EXTENDS", "targetId": "fact-1", "reason": "Adds work info to existing relationship"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Bob works at Globex', subject: 'Bob', category: 'work' },
        [{ id: 'fact-1', content: 'Flatmate is Bob', subject: 'user', category: 'relationship' }]
      );

      expect(result.classification).toBe('EXTENDS');
      expect(result.targetId).toBe('fact-1');
    });

    it('should classify wife and flatmate as separate NEW facts', async () => {
      const provider = createMockProvider('{"classification": "NEW", "reason": "Wife is a different relationship than flatmate"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Wife is Jamie', subject: 'user', category: 'relationship' },
        [{ id: 'fact-1', content: 'Flatmate is Bob', subject: 'user', category: 'relationship' }]
      );

      expect(result.classification).toBe('NEW');
      // Should NOT have a targetId since it's a new, unrelated fact
      expect(result.targetId).toBeUndefined();
    });

    it('should classify name and nationality as separate facts', async () => {
      const provider = createMockProvider('{"classification": "NEW", "reason": "Nationality is different from name"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Is Pakistani', subject: 'user', category: 'personal' },
        [{ id: 'fact-1', content: 'Name is Tash', subject: 'user', category: 'personal' }]
      );

      expect(result.classification).toBe('NEW');
    });

    it('should handle case sensitivity properly', async () => {
      const provider = createMockProvider('{"classification": "UPDATES", "targetId": "fact-1", "reason": "Same fact with case difference"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Jamie is a TikToker', subject: 'Jamie', category: 'work' },
        [{ id: 'fact-1', content: 'Jamie is a tiktoker', subject: 'Jamie', category: 'work' }]
      );

      expect(result.classification).toBe('UPDATES');
    });
  });

  describe('buildPrompt', () => {
    it('should create a prompt with proper context', async () => {
      const provider = createMockProvider('{"classification": "NEW"}');
      const classifier = createRelationshipClassifier(provider);

      // Access the buildPrompt method through classify call
      await classifier.classify(
        { content: 'Lives in Springfield', subject: 'user', category: 'location' },
        [{ id: 'fact-1', content: 'Works at Acme Corp', subject: 'user', category: 'work' }]
      );

      // Verify the LLM was called with appropriate prompt
      expect(provider.complete).toHaveBeenCalled();
      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].messages[0].content).toContain('Lives in Springfield');
      expect(call[0].messages[0].content).toContain('Works at Acme Corp');
    });
  });

  describe('edge cases', () => {
    it('should handle empty existing facts', async () => {
      const provider = createMockProvider('{"classification": "NEW"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Name is Tash', subject: 'user', category: 'personal' },
        []
      );

      expect(result.classification).toBe('NEW');
    });

    it('should handle malformed LLM response gracefully', async () => {
      const provider = createMockProvider('not valid json');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Name is Tash', subject: 'user', category: 'personal' },
        []
      );

      // Should default to NEW on parse failure
      expect(result.classification).toBe('NEW');
    });

    it('should handle LLM errors gracefully', async () => {
      const provider = {
        name: 'mock',
        model: 'mock-model',
        complete: vi.fn().mockRejectedValue(new Error('LLM error')),
      } as unknown as LLMProvider;
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Name is Tash', subject: 'user', category: 'personal' },
        []
      );

      // Should default to NEW on error
      expect(result.classification).toBe('NEW');
    });
  });
});


describe('RelationshipClassifier truncation handling (B6)', () => {
  const existing = [
    { id: 'fact-1', content: 'Lives in Metropolis', subject: 'user', category: 'location' },
  ];
  const facts = [
    { content: 'Lives in Springfield', subject: 'user', category: 'location' },
    { content: 'Has a cat', subject: 'user', category: 'personal' },
  ];
  const reply = (text: string, stopReason: string, outputTokens = 10) => ({
    content: [{ type: 'text', text }],
    stopReason,
    usage: { inputTokens: 10, outputTokens },
    model: 'qwen/qwen3.6-plus',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends thinking-off and the raised purpose budget on every classify call', async () => {
    const provider = createMockProvider('{"classification": "NEW", "reason": "x"}');
    await createRelationshipClassifier(provider).classify(facts[0], existing);
    await createRelationshipClassifier(provider).classifyBatch(facts, existing);

    for (const call of (provider.complete as ReturnType<typeof vi.fn>).mock.calls) {
      const request = call[0];
      expect(request.enableThinking).toBe(false);
      expect(request.purpose).toBe('relation_classify');
      expect(request.maxTokens).toBeGreaterThanOrEqual(1536);
    }
  });

  it('retries a max_tokens truncation once with a doubled budget instead of defaulting to NEW', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(reply('', 'max_tokens', 1538))
      .mockResolvedValueOnce(reply(JSON.stringify({
        classifications: [
          { index: 1, classification: 'UPDATES', targetId: 'fact-1', confidence: 0.9, reason: 'moved' },
          { index: 2, classification: 'NEW', confidence: 0.9, reason: 'new' },
        ],
      }), 'end_turn'));
    const provider = { name: 'openrouter', model: 'qwen/qwen3.6-plus', complete } as unknown as LLMProvider;
    const logger = { warn: vi.fn(), error: vi.fn() };

    const results = await createRelationshipClassifier(provider, { logger }).classifyBatch(facts, existing);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].maxTokens).toBe(complete.mock.calls[0][0].maxTokens * 2);
    expect(String(complete.mock.calls[1][0].messages[0].content)).toContain('Return ONLY the JSON.');
    expect(results.map((r) => r.classification)).toEqual(['UPDATES', 'NEW']);
    expect(results[0].targetId).toBe('fact-1');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('halves the batch only when the retry is also truncated', async () => {
    const one = (i: number, cls: string) => JSON.stringify({
      classifications: [{ index: 1, classification: cls, confidence: 0.9, reason: `r${i}` }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce(reply('', 'max_tokens'))     // batch of 2, attempt 1
      .mockResolvedValueOnce(reply('{"classi', 'max_tokens')) // batch of 2, retry
      .mockResolvedValueOnce(reply(one(1, 'UPDATES'), 'end_turn')) // first half
      .mockResolvedValueOnce(reply(one(2, 'NEW'), 'end_turn'));    // second half
    const provider = { name: 'openrouter', model: 'qwen/qwen3.6-plus', complete } as unknown as LLMProvider;

    const results = await createRelationshipClassifier(provider).classifyBatch(facts, existing);

    expect(complete).toHaveBeenCalledTimes(4);
    expect(results.map((r) => r.classification)).toEqual(['UPDATES', 'NEW']);
  });

  it('does not retry when the response finished normally but was garbage', async () => {
    const provider = createMockProvider('nothing useful here');
    const results = await createRelationshipClassifier(provider).classifyBatch(facts, existing);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.classification === 'NEW' && r.reason === 'Failed to parse batch response')).toBe(true);
  });
});
