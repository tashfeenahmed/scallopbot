/**
 * Tests for LLM-based relation classification in RelationGraph
 *
 * Phase 19-01: Replace regex-based classifyRelation with LLM-based
 * classification using RelationshipClassifier, with batch support
 * and graceful regex fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RelationGraph, type DetectedRelation } from './relations.js';
import type { ScallopMemoryEntry } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import type { EmbeddingProvider } from './embeddings.js';

// --- Helpers ---

/** Create a minimal ScallopMemoryEntry for testing */
function makeMemory(overrides: Partial<ScallopMemoryEntry> & { id: string; content: string }): ScallopMemoryEntry {
  return {
    userId: 'user1',
    category: 'fact',
    memoryType: 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: true,
    documentDate: Date.now(),
    eventDate: null,
    prominence: 1.0,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
    ...overrides,
  };
}

/** Create a mock EmbeddingProvider that returns deterministic embeddings */
function createMockEmbedder(similarityMap?: Map<string, number[]>): EmbeddingProvider {
  const defaultEmbedding = [1, 0, 0, 0];
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      return similarityMap?.get(text) ?? defaultEmbedding;
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      return texts.map(t => similarityMap?.get(t) ?? defaultEmbedding);
    }),
    dimensions: 4,
  };
}

/**
 * Create a mock LLMProvider for classifier.
 * Returns a JSON response based on the classification and targetId provided.
 */
function createMockClassifierProvider(
  response: { classification: string; targetId?: string; confidence: number; reason: string } |
            { classifications: Array<{ index: number; classification: string; targetId?: string | null; confidence: number; reason: string }> }
): LLMProvider {
  const text = JSON.stringify(response);
  return {
    name: 'mock-classifier',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

/** Create a failing LLMProvider */
function createFailingProvider(): LLMProvider {
  return {
    name: 'mock-failing',
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(new Error('LLM API error')),
  };
}

/**
 * Helper: creates embeddings that produce a specific cosine similarity.
 * Uses 2D unit vectors with a controlled angle.
 */
function embeddingsWithSimilarity(similarity: number): { a: number[]; b: number[] } {
  // cos(theta) = similarity, so theta = acos(similarity)
  const theta = Math.acos(Math.min(1, Math.max(-1, similarity)));
  return {
    a: [1, 0, 0, 0],
    b: [Math.cos(theta), Math.sin(theta), 0, 0],
  };
}

// --- Tests ---

describe('RelationGraph LLM-based classification', () => {
  describe('no LLM provider (backward compatible regex)', () => {
    it('should use regex classification when no classifierProvider is given', async () => {
      // Embeddings with similarity ~0.75 (above updateThreshold 0.7)
      const emb = embeddingsWithSimilarity(0.75);

      const embedder = createMockEmbedder(new Map([
        ['Lives in Dublin', emb.a],
        ['Lives in Wicklow', emb.b],
      ]));

      // No classifierProvider - should use regex fallback
      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Lives in Dublin', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Lives in Wicklow', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      // Regex detects contradiction (lives in X vs lives in Y) -> UPDATES
      expect(result.length).toBe(1);
      expect(result[0].relationType).toBe('UPDATES');
      expect(result[0].sourceId).toBe('new1');
      expect(result[0].targetId).toBe('old1');
    });
  });

  describe('LLM provider + single candidate', () => {
    it('should use LLM classify() for a single candidate and return DetectedRelation', async () => {
      const emb = embeddingsWithSimilarity(0.75);

      const embedder = createMockEmbedder(new Map([
        ['Works at Google', emb.a],
        ['Joined Google as SWE', emb.b],
      ]));

      const classifierProvider = createMockClassifierProvider({
        classification: 'UPDATES',
        targetId: 'old1',
        confidence: 0.92,
        reason: 'Same employer, more specific role info',
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Works at Google', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Joined Google as SWE', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      expect(classifierProvider.complete).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].relationType).toBe('UPDATES');
      expect(result[0].sourceId).toBe('new1');
      expect(result[0].targetId).toBe('old1');
      expect(result[0].confidence).toBe(0.92);
    });
  });

  describe('LLM provider + multiple candidates', () => {
    it('should use LLM classifyBatch() for multiple candidates', async () => {
      const emb = embeddingsWithSimilarity(0.75);

      const embedder = createMockEmbedder(new Map([
        ['Lives in Dublin', emb.a],
        ['Lives in Wicklow', emb.b],
        ['Works in Ireland', emb.b],
      ]));

      const classifierProvider = createMockClassifierProvider({
        classifications: [
          { index: 1, classification: 'UPDATES', targetId: 'old1', confidence: 0.8, reason: 'Location update' },
          { index: 2, classification: 'EXTENDS', targetId: 'old2', confidence: 0.7, reason: 'Related location info' },
        ],
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Lives in Dublin', embedding: emb.a });
      const candidates = [
        makeMemory({ id: 'old1', content: 'Lives in Wicklow', embedding: emb.b }),
        makeMemory({ id: 'old2', content: 'Works in Ireland', embedding: emb.b }),
      ];

      const result = await graph.detectRelations(newMem, candidates);

      expect(classifierProvider.complete).toHaveBeenCalled();
      expect(result.length).toBe(2);

      // Results sorted by confidence (highest first)
      expect(result[0].relationType).toBe('UPDATES');
      expect(result[0].confidence).toBe(0.8);
      expect(result[1].relationType).toBe('EXTENDS');
      expect(result[1].confidence).toBe(0.7);
    });
  });

  describe('LLM classification mapping', () => {
    it('should map UPDATES to DetectedRelation with relationType UPDATES', async () => {
      const emb = embeddingsWithSimilarity(0.75);
      const embedder = createMockEmbedder();

      const classifierProvider = createMockClassifierProvider({
        classification: 'UPDATES',
        targetId: 'old1',
        confidence: 0.88,
        reason: 'Changed location',
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Lives in London', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Lives in Paris', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      expect(result.length).toBe(1);
      expect(result[0].relationType).toBe('UPDATES');
      expect(result[0].confidence).toBe(0.88);
      expect(result[0].reason).toBe('Changed location');
    });

    it('should map EXTENDS to DetectedRelation with relationType EXTENDS', async () => {
      const emb = embeddingsWithSimilarity(0.6);
      const embedder = createMockEmbedder();

      const classifierProvider = createMockClassifierProvider({
        classification: 'EXTENDS',
        targetId: 'old1',
        confidence: 0.75,
        reason: 'Additional info about same entity',
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Hamza works at Google', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Flatmate is Hamza', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      expect(result.length).toBe(1);
      expect(result[0].relationType).toBe('EXTENDS');
      expect(result[0].confidence).toBe(0.75);
    });

    it('should filter out NEW classifications (no relation)', async () => {
      const emb = embeddingsWithSimilarity(0.6);
      const embedder = createMockEmbedder();

      const classifierProvider = createMockClassifierProvider({
        classification: 'NEW',
        confidence: 0.95,
        reason: 'Unrelated information',
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Likes sushi', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Works at Google', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      // NEW -> filtered out, no DetectedRelation
      expect(result.length).toBe(0);
    });
  });

  describe('LLM failure fallback', () => {
    it('should fall back to regex when LLM call fails', async () => {
      const emb = embeddingsWithSimilarity(0.75);

      const embedder = createMockEmbedder(new Map([
        ['Lives in Dublin', emb.a],
        ['Lives in Wicklow', emb.b],
      ]));

      const failingProvider = createFailingProvider();

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        failingProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Lives in Dublin', embedding: emb.a });
      const existing = makeMemory({ id: 'old1', content: 'Lives in Wicklow', embedding: emb.b });

      const result = await graph.detectRelations(newMem, [existing]);

      // LLM failed, should fall back to regex which detects the contradiction
      expect(failingProvider.complete).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].relationType).toBe('UPDATES');
    });
  });

  describe('empty candidates', () => {
    it('should return empty results without calling LLM when no candidates', async () => {
      const embedder = createMockEmbedder();

      const classifierProvider = createMockClassifierProvider({
        classification: 'NEW',
        confidence: 1.0,
        reason: 'No existing facts',
      });

      const graph = new RelationGraph(
        { getMemoriesByUser: () => [], addRelation: vi.fn(), getMemory: vi.fn() } as any,
        embedder,
        {},
        classifierProvider,
      );

      const newMem = makeMemory({ id: 'new1', content: 'Likes coffee', embedding: [1, 0, 0, 0] });

      const result = await graph.detectRelations(newMem, []);

      // No candidates -> no LLM call
      expect(classifierProvider.complete).not.toHaveBeenCalled();
      expect(result.length).toBe(0);
    });
  });
});
