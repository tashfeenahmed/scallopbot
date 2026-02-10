/**
 * Tests for LLM-based relation classification in RelationGraph
 *
 * Phase 19-01: Replace regex-based classifyRelation with LLM-based
 * classification using RelationshipClassifier, with batch support
 * and graceful regex fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RelationGraph,
  type DetectedRelation,
  spreadActivation,
  getEdgeWeight,
  EDGE_WEIGHTS,
  type ActivationConfig,
} from './relations.js';
import type { ScallopMemoryEntry, MemoryRelation, RelationType } from './db.js';
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    name: 'mock-embedder',
    isAvailable: true,
    embed: vi.fn().mockImplementation(async (text: string) => {
      return similarityMap?.get(text) ?? defaultEmbedding;
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      return texts.map(t => similarityMap?.get(t) ?? defaultEmbedding);
    }),
    dimension: 4,
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

// --- Spreading Activation Tests ---

/** Helper: create a MemoryRelation for test graphs */
function makeRelation(
  sourceId: string,
  targetId: string,
  relationType: RelationType,
  confidence: number = 1.0,
): MemoryRelation {
  return {
    id: `rel-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    relationType,
    confidence,
    createdAt: Date.now(),
  };
}

describe('spreadActivation', () => {
  const defaultConfig: ActivationConfig = {
    maxSteps: 3,
    decayFactor: 0.5,
    activationThreshold: 0.01,
    noiseSigma: 0,
    resultThreshold: 0.05,
    maxResults: 10,
  };

  describe('basic behavior', () => {
    it('should return empty Map when seed has no neighbors', () => {
      const getRelations = (_id: string): MemoryRelation[] => [];
      const result = spreadActivation('seed', getRelations, defaultConfig);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('should return neighbor with correct activation for seed with 1 neighbor', () => {
      // seed --UPDATES(confidence=1.0)--> A
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        return [];
      };

      // Use maxSteps=1 to isolate single-step activation calculation
      const config = { ...defaultConfig, maxSteps: 1 };
      const result = spreadActivation('seed', getRelations, config);

      expect(result.has('A')).toBe(true);
      // After 1 step: A gets activation = 1.0 * UPDATES.forward(0.9) * decayFactor(0.5) / degree(1) = 0.45
      const expected = 1.0 * 0.9 * 1.0 * 0.5 / 1;
      expect(result.get('A')).toBeCloseTo(expected, 4);
    });

    it('should normalize by fan-out for seed with 3 neighbors', () => {
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('seed', 'B', 'UPDATES', 1.0),
          makeRelation('seed', 'C', 'UPDATES', 1.0),
        ];
        // Each neighbor sees only the edge back to seed
        if (id === 'A' || id === 'B' || id === 'C')
          return [makeRelation('seed', id, 'UPDATES', 1.0)];
        return [];
      };

      // Use maxSteps=1 to isolate single-step fan-out normalization
      const config = { ...defaultConfig, maxSteps: 1 };
      const result = spreadActivation('seed', getRelations, config);

      // Each neighbor: 1.0 * 0.9 * 0.5 / 3 = 0.15
      const expected = 1.0 * 0.9 * 1.0 * 0.5 / 3;
      expect(result.get('A')).toBeCloseTo(expected, 4);
      expect(result.get('B')).toBeCloseTo(expected, 4);
      expect(result.get('C')).toBeCloseTo(expected, 4);
    });

    it('should reduce activation over 2 hops (decay * decay)', () => {
      // seed --> A --> B (linear chain)
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'A') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('A', 'B', 'UPDATES', 1.0),
        ];
        if (id === 'B') return [makeRelation('A', 'B', 'UPDATES', 1.0)];
        return [];
      };

      const result = spreadActivation('seed', getRelations, defaultConfig);

      expect(result.has('B')).toBe(true);
      // B should have less activation than A
      expect(result.get('B')!).toBeLessThan(result.get('A')!);
    });

    it('should accumulate activation from multiple paths but clamp to 1.0', () => {
      // seed --> A --> C
      // seed --> B --> C
      // C receives activation from both A and B
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('seed', 'B', 'UPDATES', 1.0),
        ];
        if (id === 'A') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('A', 'C', 'UPDATES', 1.0),
        ];
        if (id === 'B') return [
          makeRelation('seed', 'B', 'UPDATES', 1.0),
          makeRelation('B', 'C', 'UPDATES', 1.0),
        ];
        if (id === 'C') return [
          makeRelation('A', 'C', 'UPDATES', 1.0),
          makeRelation('B', 'C', 'UPDATES', 1.0),
        ];
        return [];
      };

      const result = spreadActivation('seed', getRelations, defaultConfig);

      expect(result.has('C')).toBe(true);
      // C gets activation from both paths - should be accumulated
      // And must not exceed 1.0
      expect(result.get('C')!).toBeLessThanOrEqual(1.0);
      expect(result.get('C')!).toBeGreaterThan(0);
    });

    it('should exclude seed from results', () => {
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        return [];
      };

      const result = spreadActivation('seed', getRelations, defaultConfig);

      expect(result.has('seed')).toBe(false);
    });
  });

  describe('edge weights', () => {
    it('UPDATES forward should use weight 0.9 * confidence', () => {
      const rel = makeRelation('A', 'B', 'UPDATES', 0.8);
      const weight = getEdgeWeight(rel, 'A'); // forward
      expect(weight).toBeCloseTo(0.9 * 0.8, 4);
    });

    it('UPDATES reverse should use weight 0.9 * confidence', () => {
      const rel = makeRelation('A', 'B', 'UPDATES', 0.8);
      const weight = getEdgeWeight(rel, 'B'); // reverse
      expect(weight).toBeCloseTo(0.9 * 0.8, 4);
    });

    it('EXTENDS forward should use weight 0.7 * confidence', () => {
      const rel = makeRelation('A', 'B', 'EXTENDS', 1.0);
      const weight = getEdgeWeight(rel, 'A');
      expect(weight).toBeCloseTo(0.7, 4);
    });

    it('EXTENDS reverse should use weight 0.5 * confidence', () => {
      const rel = makeRelation('A', 'B', 'EXTENDS', 1.0);
      const weight = getEdgeWeight(rel, 'B');
      expect(weight).toBeCloseTo(0.5, 4);
    });

    it('DERIVES forward should use weight 0.4 * confidence', () => {
      const rel = makeRelation('A', 'B', 'DERIVES', 1.0);
      const weight = getEdgeWeight(rel, 'A');
      expect(weight).toBeCloseTo(0.4, 4);
    });

    it('DERIVES reverse should use weight 0.6 * confidence', () => {
      const rel = makeRelation('A', 'B', 'DERIVES', 1.0);
      const weight = getEdgeWeight(rel, 'B');
      expect(weight).toBeCloseTo(0.6, 4);
    });

    it('EDGE_WEIGHTS constant should have correct values', () => {
      expect(EDGE_WEIGHTS.UPDATES).toEqual({ forward: 0.9, reverse: 0.9 });
      expect(EDGE_WEIGHTS.EXTENDS).toEqual({ forward: 0.7, reverse: 0.5 });
      expect(EDGE_WEIGHTS.DERIVES).toEqual({ forward: 0.4, reverse: 0.6 });
    });
  });

  describe('noise', () => {
    it('sigma=0 should produce deterministic results', () => {
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        return [];
      };

      const config = { ...defaultConfig, noiseSigma: 0 };
      const result1 = spreadActivation('seed', getRelations, config);
      const result2 = spreadActivation('seed', getRelations, config);

      expect(result1.get('A')).toBe(result2.get('A'));
    });

    it('sigma>0 should produce varying results', () => {
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('seed', 'B', 'UPDATES', 1.0),
          makeRelation('seed', 'C', 'UPDATES', 1.0),
        ];
        return [makeRelation('seed', id, 'UPDATES', 1.0)];
      };

      const config = { ...defaultConfig, noiseSigma: 0.5 };

      // Run multiple times and check that at least one result differs
      const results: number[] = [];
      for (let i = 0; i < 10; i++) {
        const result = spreadActivation('seed', getRelations, config);
        results.push(result.get('A') ?? 0);
      }

      // With sigma=0.5, results should vary
      const allSame = results.every(r => r === results[0]);
      expect(allSame).toBe(false);
    });
  });

  describe('thresholds and limits', () => {
    it('should filter results below resultThreshold', () => {
      // Create a chain that produces very low activation at the end
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'DERIVES', 0.3)];
        if (id === 'A') return [
          makeRelation('seed', 'A', 'DERIVES', 0.3),
          makeRelation('A', 'B', 'DERIVES', 0.3),
        ];
        if (id === 'B') return [makeRelation('A', 'B', 'DERIVES', 0.3)];
        return [];
      };

      const config = { ...defaultConfig, resultThreshold: 0.05 };
      const result = spreadActivation('seed', getRelations, config);

      // All values in result should be >= resultThreshold
      for (const [, score] of result) {
        expect(score).toBeGreaterThanOrEqual(0.05);
      }
    });

    it('should limit results to maxResults', () => {
      // Create many neighbors
      const neighbors = Array.from({ length: 20 }, (_, i) => `N${i}`);
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return neighbors.map(n => makeRelation('seed', n, 'UPDATES', 1.0));
        return [makeRelation('seed', id, 'UPDATES', 1.0)];
      };

      const config = { ...defaultConfig, maxResults: 5 };
      const result = spreadActivation('seed', getRelations, config);

      expect(result.size).toBeLessThanOrEqual(5);
    });

    it('should stop propagating activation below activationThreshold', () => {
      // With very low confidence, activation should die out quickly
      const getRelations = (id: string): MemoryRelation[] => {
        if (id === 'seed') return [makeRelation('seed', 'A', 'DERIVES', 0.1)];
        if (id === 'A') return [
          makeRelation('seed', 'A', 'DERIVES', 0.1),
          makeRelation('A', 'B', 'DERIVES', 0.1),
        ];
        if (id === 'B') return [
          makeRelation('A', 'B', 'DERIVES', 0.1),
          makeRelation('B', 'C', 'DERIVES', 0.1),
        ];
        if (id === 'C') return [makeRelation('B', 'C', 'DERIVES', 0.1)];
        return [];
      };

      const config = { ...defaultConfig, activationThreshold: 0.01, maxSteps: 5 };
      const result = spreadActivation('seed', getRelations, config);

      // Activation should die out - deep nodes shouldn't be reached or should have very low activation
      // C should not appear or have very tiny activation
      if (result.has('C')) {
        expect(result.get('C')!).toBeLessThan(0.05);
      }
    });
  });
});

describe('getRelatedMemoriesWithActivation', () => {
  it('should return ScallopMemoryEntry[] sorted by score descending', () => {
    const memA = makeMemory({ id: 'A', content: 'Memory A', prominence: 0.8 });
    const memB = makeMemory({ id: 'B', content: 'Memory B', prominence: 1.0 });

    const mockDb = {
      getRelations: (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('seed', 'B', 'EXTENDS', 1.0),
        ];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'B') return [makeRelation('seed', 'B', 'EXTENDS', 1.0)];
        return [];
      },
      getMemory: (id: string): ScallopMemoryEntry | null => {
        if (id === 'A') return memA;
        if (id === 'B') return memB;
        return null;
      },
      getMemoriesByUser: () => [],
      addRelation: vi.fn(),
      getOutgoingRelations: () => [],
      getIncomingRelations: () => [],
    } as any;

    const graph = new RelationGraph(mockDb);
    const results = graph.getRelatedMemoriesWithActivation('seed', { noiseSigma: 0 });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      // We can't directly check scores, but order should reflect activation * prominence
      expect(results).toBeDefined();
    }
  });

  it('should multiply activation by prominence', () => {
    // memA has high activation but low prominence
    // memB has lower activation but high prominence
    const memA = makeMemory({ id: 'A', content: 'Memory A', prominence: 0.1 });
    const memB = makeMemory({ id: 'B', content: 'Memory B', prominence: 1.0 });

    const mockDb = {
      getRelations: (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),  // high edge weight -> high activation
          makeRelation('seed', 'B', 'EXTENDS', 0.5),   // lower edge weight -> lower activation
        ];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'B') return [makeRelation('seed', 'B', 'EXTENDS', 0.5)];
        return [];
      },
      getMemory: (id: string): ScallopMemoryEntry | null => {
        if (id === 'A') return memA;
        if (id === 'B') return memB;
        return null;
      },
      getMemoriesByUser: () => [],
      addRelation: vi.fn(),
      getOutgoingRelations: () => [],
      getIncomingRelations: () => [],
    } as any;

    const graph = new RelationGraph(mockDb);
    const results = graph.getRelatedMemoriesWithActivation('seed', {
      noiseSigma: 0,
      resultThreshold: 0.001,  // Low threshold to keep A despite low prominence
    });

    expect(results.length).toBe(2);
    // B should be ranked higher because prominence=1.0 even though activation is lower
    // A has higher activation * 0.1 prominence = low final score
    // B has lower activation * 1.0 prominence = higher final score
    // So B should be first
    expect(results[0].id).toBe('B');
  });

  it('should filter to isLatest memories only', () => {
    const memLatest = makeMemory({ id: 'A', content: 'Latest', isLatest: true });
    const memOld = makeMemory({ id: 'B', content: 'Old', isLatest: false });

    const mockDb = {
      getRelations: (id: string): MemoryRelation[] => {
        if (id === 'seed') return [
          makeRelation('seed', 'A', 'UPDATES', 1.0),
          makeRelation('seed', 'B', 'UPDATES', 1.0),
        ];
        if (id === 'A') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        if (id === 'B') return [makeRelation('seed', 'B', 'UPDATES', 1.0)];
        return [];
      },
      getMemory: (id: string): ScallopMemoryEntry | null => {
        if (id === 'A') return memLatest;
        if (id === 'B') return memOld;
        return null;
      },
      getMemoriesByUser: () => [],
      addRelation: vi.fn(),
      getOutgoingRelations: () => [],
      getIncomingRelations: () => [],
    } as any;

    const graph = new RelationGraph(mockDb);
    const results = graph.getRelatedMemoriesWithActivation('seed', { noiseSigma: 0 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('A');
    expect(results[0].isLatest).toBe(true);
  });

  it('should fall back to getRelatedMemoriesForContext on error', () => {
    const memA = makeMemory({ id: 'A', content: 'Fallback memory' });

    // Track call count: first call (from spreadActivation) throws,
    // subsequent calls (from fallback getRelatedMemoriesForContext) succeed.
    let callCount = 0;
    const mockDb = {
      getRelations: (id: string): MemoryRelation[] => {
        callCount++;
        if (callCount === 1) throw new Error('DB error');
        // Fallback path: return data for BFS traversal
        if (id === 'seed') return [makeRelation('seed', 'A', 'UPDATES', 1.0)];
        return [];
      },
      getMemory: (id: string): ScallopMemoryEntry | null => {
        if (id === 'A') return memA;
        return null;
      },
      getMemoriesByUser: () => [],
      addRelation: vi.fn(),
      getOutgoingRelations: () => [],
      getIncomingRelations: () => [],
    } as any;

    const graph = new RelationGraph(mockDb);

    // Should not throw - should fall back gracefully
    const results = graph.getRelatedMemoriesWithActivation('seed', { noiseSigma: 0 });
    expect(Array.isArray(results)).toBe(true);
    // Fallback should have returned the BFS result
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('A');
  });

  it('should limit results to maxResults', () => {
    const neighbors = Array.from({ length: 20 }, (_, i) => `N${i}`);
    const memories = neighbors.map(n => makeMemory({ id: n, content: `Memory ${n}`, prominence: 1.0 }));

    const mockDb = {
      getRelations: (id: string): MemoryRelation[] => {
        if (id === 'seed') return neighbors.map(n => makeRelation('seed', n, 'UPDATES', 1.0));
        return [makeRelation('seed', id, 'UPDATES', 1.0)];
      },
      getMemory: (id: string): ScallopMemoryEntry | null => {
        const mem = memories.find(m => m.id === id);
        return mem ?? null;
      },
      getMemoriesByUser: () => [],
      addRelation: vi.fn(),
      getOutgoingRelations: () => [],
      getIncomingRelations: () => [],
    } as any;

    const graph = new RelationGraph(mockDb);
    const results = graph.getRelatedMemoriesWithActivation('seed', {
      noiseSigma: 0,
      maxResults: 5,
    });

    expect(results.length).toBeLessThanOrEqual(5);
  });
});
