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
        { content: 'Flatmate is Hamza', subject: 'user', category: 'relationship' },
        [] // No existing facts
      );

      expect(result.classification).toBe('NEW');
    });

    it('should classify UPDATES when new fact contradicts existing', async () => {
      const provider = createMockProvider('{"classification": "UPDATES", "targetId": "fact-1", "reason": "Location changed from Dublin to Wicklow"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Lives in Wicklow', subject: 'user', category: 'location' },
        [{ id: 'fact-1', content: 'Lives in Dublin', subject: 'user', category: 'location' }]
      );

      expect(result.classification).toBe('UPDATES');
      expect(result.targetId).toBe('fact-1');
    });

    it('should classify EXTENDS when new fact adds info about same entity', async () => {
      const provider = createMockProvider('{"classification": "EXTENDS", "targetId": "fact-1", "reason": "Adds work info to existing relationship"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Hamza works at Henry Schein', subject: 'Hamza', category: 'work' },
        [{ id: 'fact-1', content: 'Flatmate is Hamza', subject: 'user', category: 'relationship' }]
      );

      expect(result.classification).toBe('EXTENDS');
      expect(result.targetId).toBe('fact-1');
    });

    it('should classify wife and flatmate as separate NEW facts', async () => {
      const provider = createMockProvider('{"classification": "NEW", "reason": "Wife is a different relationship than flatmate"}');
      const classifier = createRelationshipClassifier(provider);

      const result = await classifier.classify(
        { content: 'Wife is Hayat', subject: 'user', category: 'relationship' },
        [{ id: 'fact-1', content: 'Flatmate is Hamza', subject: 'user', category: 'relationship' }]
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
        { content: 'Hayat is a TikToker', subject: 'Hayat', category: 'work' },
        [{ id: 'fact-1', content: 'Hayat is a tiktoker', subject: 'Hayat', category: 'work' }]
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
        { content: 'Lives in Wicklow', subject: 'user', category: 'location' },
        [{ id: 'fact-1', content: 'Works at Microsoft', subject: 'user', category: 'work' }]
      );

      // Verify the LLM was called with appropriate prompt
      expect(provider.complete).toHaveBeenCalled();
      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].messages[0].content).toContain('Lives in Wicklow');
      expect(call[0].messages[0].content).toContain('Works at Microsoft');
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

