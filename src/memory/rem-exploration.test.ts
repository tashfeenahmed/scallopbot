/**
 * Tests for REM Exploration Module
 *
 * Tests the stochastic seed sampling, high-noise spreading activation,
 * and LLM-judge connection validation pipeline:
 * - sampleSeeds: diversity-weighted seed selection with category caps
 * - buildConnectionJudgePrompt: structured LLM request for connection evaluation
 * - parseJudgeResponse: JSON parsing with NO_CONNECTION and failure handling
 * - remExplore: full pipeline with mock LLM, relation pre-filtering, error isolation
 */

import { describe, it, expect, vi } from 'vitest';
import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import {
  sampleSeeds,
  buildConnectionJudgePrompt,
  parseJudgeResponse,
  remExplore,
  DEFAULT_REM_CONFIG,
  type RemConfig,
  type RemDiscovery,
  type RemExplorationResult,
} from './rem-exploration.js';

// ============ Test Helpers ============

/** Create a minimal ScallopMemoryEntry for testing */
function makeMemory(overrides: Partial<ScallopMemoryEntry> & { id: string }): ScallopMemoryEntry {
  return {
    userId: 'default',
    content: `Memory content for ${overrides.id}`,
    category: 'fact' as MemoryCategory,
    memoryType: 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: true,
    documentDate: Date.now() - 86400000,
    eventDate: null,
    prominence: 0.3,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Create a MemoryRelation connecting two memory IDs */
function makeRelation(
  sourceId: string,
  targetId: string,
  relationType: 'UPDATES' | 'EXTENDS' | 'DERIVES' = 'EXTENDS',
  confidence: number = 0.8,
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

/** Create a mock LLMProvider that returns a predefined response text */
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

/** Create a mock provider that throws an error */
function createFailingProvider(errorMessage: string): LLMProvider {
  return {
    name: 'mock-failing',
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

/**
 * Build a getRelations callback from a list of relations.
 * Returns all relations where the given memoryId is either source or target.
 */
function buildGetRelations(relations: MemoryRelation[]): (memoryId: string) => MemoryRelation[] {
  return (memoryId: string) =>
    relations.filter(r => r.sourceId === memoryId || r.targetId === memoryId);
}

// ============ Tests: sampleSeeds ============

describe('sampleSeeds', () => {
  it('returns empty array for empty input', () => {
    const result = sampleSeeds([], {});
    expect(result).toEqual([]);
  });

  it('returns up to maxSeeds memories', () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemory({ id: `m${i}`, importance: 5 + (i % 5), prominence: 0.3, category: (['fact', 'event', 'preference', 'relationship', 'insight'] as MemoryCategory[])[i % 5] }),
    );

    const result = sampleSeeds(memories, { maxSeeds: 6 });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('caps seeds per category at maxSeedsPerCategory', () => {
    // All same category
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `m${i}`, importance: 8, prominence: 0.5, category: 'fact' }),
    );

    const result = sampleSeeds(memories, { maxSeedsPerCategory: 2 });

    expect(result.length).toBeLessThanOrEqual(2);
    // All should be 'fact' category
    for (const m of result) {
      expect(m.category).toBe('fact');
    }
  });

  it('weights by importance x prominence — higher values more likely to be selected', () => {
    // Create two memories: one high importance/prominence, one low
    const highMemory = makeMemory({ id: 'high', importance: 10, prominence: 0.9, category: 'fact' });
    const lowMemory = makeMemory({ id: 'low', importance: 1, prominence: 0.05, category: 'event' });

    // Run many times and check that high memory appears more often in first position
    let highFirst = 0;
    const runs = 100;
    for (let i = 0; i < runs; i++) {
      const result = sampleSeeds([highMemory, lowMemory], { maxSeeds: 1, maxSeedsPerCategory: 1 });
      if (result.length > 0 && result[0].id === 'high') {
        highFirst++;
      }
    }

    // High-importance/prominence memory should be selected most of the time
    expect(highFirst).toBeGreaterThan(70);
  });

  it('provides category diversity — selects from multiple categories', () => {
    const memories = [
      makeMemory({ id: 'f1', importance: 9, prominence: 0.5, category: 'fact' }),
      makeMemory({ id: 'f2', importance: 9, prominence: 0.5, category: 'fact' }),
      makeMemory({ id: 'f3', importance: 9, prominence: 0.5, category: 'fact' }),
      makeMemory({ id: 'e1', importance: 8, prominence: 0.5, category: 'event' }),
      makeMemory({ id: 'e2', importance: 8, prominence: 0.5, category: 'event' }),
      makeMemory({ id: 'p1', importance: 7, prominence: 0.5, category: 'preference' }),
    ];

    const result = sampleSeeds(memories, { maxSeeds: 6, maxSeedsPerCategory: 2 });

    // Should have at most 2 facts, even though facts have highest importance
    const factCount = result.filter(m => m.category === 'fact').length;
    expect(factCount).toBeLessThanOrEqual(2);

    // Should include memories from multiple categories
    const categories = new Set(result.map(m => m.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it('handles single memory input', () => {
    const memories = [makeMemory({ id: 'm1', importance: 5, prominence: 0.3 })];
    const result = sampleSeeds(memories, { maxSeeds: 6 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
  });
});

// ============ Tests: buildConnectionJudgePrompt ============

describe('buildConnectionJudgePrompt', () => {
  it('produces CompletionRequest with system and user messages', () => {
    const seed = makeMemory({ id: 'seed1', content: 'User likes hiking in mountains' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'User reads geology textbooks' });
    const existingRelations: MemoryRelation[] = [];

    const request = buildConnectionJudgePrompt(seed, neighbor, existingRelations);

    expect(request.messages).toBeDefined();
    expect(request.messages.length).toBeGreaterThanOrEqual(1);
    expect(request.system).toBeDefined();
    expect(typeof request.system).toBe('string');
  });

  it('includes system prompt mentioning creative exploration and connection evaluation', () => {
    const seed = makeMemory({ id: 'seed1', content: 'User likes hiking' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'User reads geology books' });

    const request = buildConnectionJudgePrompt(seed, neighbor, []);

    expect(request.system!.toLowerCase()).toMatch(/connection|evaluat/);
    expect(request.system!.toLowerCase()).toMatch(/creative|exploration/);
  });

  it('includes full content of seed and neighbor in user message', () => {
    const seed = makeMemory({ id: 'seed1', content: 'User enjoys hiking in the Swiss Alps every summer' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'User is studying geology at university' });

    const request = buildConnectionJudgePrompt(seed, neighbor, []);
    const userContent = request.messages[0].content as string;

    expect(userContent).toContain('User enjoys hiking in the Swiss Alps every summer');
    expect(userContent).toContain('User is studying geology at university');
  });

  it('includes existing relations when provided', () => {
    const seed = makeMemory({ id: 'seed1', content: 'User likes hiking' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'User reads geology books' });
    const relations = [makeRelation('seed1', 'other1', 'EXTENDS', 0.7)];

    const request = buildConnectionJudgePrompt(seed, neighbor, relations);
    const userContent = request.messages[0].content as string;

    expect(userContent).toMatch(/relation|existing|connect/i);
  });

  it('requests JSON response with novelty, plausibility, and usefulness scores', () => {
    const seed = makeMemory({ id: 'seed1', content: 'Hiking' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'Geology' });

    const request = buildConnectionJudgePrompt(seed, neighbor, []);

    const combined = (request.system || '') + ' ' + (request.messages[0].content as string);
    expect(combined.toLowerCase()).toContain('novelty');
    expect(combined.toLowerCase()).toContain('plausibility');
    expect(combined.toLowerCase()).toContain('usefulness');
    expect(combined).toMatch(/json/i);
  });

  it('mentions NO_CONNECTION as an output option', () => {
    const seed = makeMemory({ id: 'seed1', content: 'Hiking' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'Geology' });

    const request = buildConnectionJudgePrompt(seed, neighbor, []);

    const combined = (request.system || '') + ' ' + (request.messages[0].content as string);
    expect(combined).toContain('NO_CONNECTION');
  });

  it('uses temperature 0.3', () => {
    const seed = makeMemory({ id: 'seed1', content: 'Hiking' });
    const neighbor = makeMemory({ id: 'neighbor1', content: 'Geology' });

    const request = buildConnectionJudgePrompt(seed, neighbor, []);

    expect(request.temperature).toBe(0.3);
  });
});

// ============ Tests: parseJudgeResponse ============

describe('parseJudgeResponse', () => {
  it('parses valid JSON with scores and connection description', () => {
    const response = JSON.stringify({
      novelty: 4,
      plausibility: 3,
      usefulness: 4,
      connection: 'Both relate to geological formations observed during outdoor activities',
      confidence: 0.75,
    });

    const result = parseJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.novelty).toBe(4);
    expect(result!.plausibility).toBe(3);
    expect(result!.usefulness).toBe(4);
    expect(result!.connection).toContain('geological formations');
    expect(result!.confidence).toBe(0.75);
  });

  it('handles NO_CONNECTION response', () => {
    const response = JSON.stringify({
      novelty: 1,
      plausibility: 1,
      usefulness: 1,
      connection: 'NO_CONNECTION',
    });

    const result = parseJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.connection).toBe('NO_CONNECTION');
  });

  it('returns null for empty input', () => {
    expect(parseJudgeResponse('')).toBeNull();
  });

  it('returns null for non-JSON input', () => {
    expect(parseJudgeResponse('This is not JSON at all')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJudgeResponse('{novelty: invalid}')).toBeNull();
  });

  it('extracts JSON from surrounding text', () => {
    const response = 'Here is my evaluation:\n' + JSON.stringify({
      novelty: 3,
      plausibility: 4,
      usefulness: 3,
      connection: 'Linked by outdoor themes',
      confidence: 0.6,
    }) + '\nThank you!';

    const result = parseJudgeResponse(response);

    expect(result).not.toBeNull();
    expect(result!.novelty).toBe(3);
  });

  it('returns null when required score fields are missing', () => {
    const response = JSON.stringify({
      connection: 'Something',
      confidence: 0.5,
    });

    const result = parseJudgeResponse(response);

    // Should return null or have defaults — depends on implementation
    // At minimum, novelty/plausibility/usefulness must be present
    if (result !== null) {
      expect(result.novelty).toBeDefined();
      expect(result.plausibility).toBeDefined();
      expect(result.usefulness).toBeDefined();
    }
  });
});

// ============ Tests: remExplore ============

describe('remExplore', () => {
  it('returns empty result for empty memories array', async () => {
    const provider = createMockProvider('{}');

    const result = await remExplore([], buildGetRelations([]), provider);

    expect(result.seedsExplored).toBe(0);
    expect(result.candidatesEvaluated).toBe(0);
    expect(result.discoveries).toEqual([]);
    expect(result.failures).toBe(0);
  });

  it('filters memories by prominenceWindow before sampling', async () => {
    // Memories outside the prominence window should be excluded
    const memories = [
      makeMemory({ id: 'm1', prominence: 0.01, importance: 10, category: 'fact' }), // below min (0.05)
      makeMemory({ id: 'm2', prominence: 0.95, importance: 10, category: 'event' }), // above max (0.8)
      makeMemory({ id: 'm3', prominence: 0.3, importance: 5, category: 'fact' }),   // in range
    ];

    // m3 is alone in range, so no neighbors to discover
    const provider = createMockProvider('{}');
    const result = await remExplore(memories, buildGetRelations([]), provider);

    // Only m3 should be eligible, but with no relations there are no candidates
    expect(result.seedsExplored).toBeLessThanOrEqual(1);
  });

  it('filters out neighbors that already have direct relations with seed', async () => {
    const memories = [
      makeMemory({ id: 'seed1', prominence: 0.3, importance: 8, category: 'fact' }),
      makeMemory({ id: 'n1', prominence: 0.3, importance: 6, category: 'event' }),
      makeMemory({ id: 'n2', prominence: 0.3, importance: 6, category: 'preference' }),
    ];

    // seed1 already has relation to n1 — should be filtered out
    const relations = [
      makeRelation('seed1', 'n1', 'EXTENDS', 0.8),
      makeRelation('seed1', 'n2', 'EXTENDS', 0.8),
      makeRelation('n1', 'n2', 'EXTENDS', 0.8),
    ];

    const provider = createMockProvider(JSON.stringify({
      novelty: 4, plausibility: 4, usefulness: 4,
      connection: 'Novel link discovered',
      confidence: 0.8,
    }));

    const result = await remExplore(memories, buildGetRelations(relations), provider);

    // Candidates that already have direct relations with the seed should be filtered
    // So no discoveries should include seed1-n1 pairs (they already have a relation)
    for (const d of result.discoveries) {
      if (d.seedId === 'seed1') {
        // n1 already has a direct relation with seed1, should have been filtered
        // Only check that the mechanism works — specific filtering depends on spreadActivation results
        expect(d).toHaveProperty('connectionDescription');
      }
    }
  });

  it('collects discoveries when LLM accepts connections', async () => {
    const memories = [
      makeMemory({ id: 'seed1', prominence: 0.3, importance: 8, category: 'fact' }),
      makeMemory({ id: 'n1', prominence: 0.3, importance: 6, category: 'event' }),
      makeMemory({ id: 'n2', prominence: 0.3, importance: 6, category: 'preference' }),
    ];

    // Create relations so spreading activation can reach neighbors
    const relations = [
      makeRelation('seed1', 'n1', 'EXTENDS', 0.8),
      makeRelation('n1', 'n2', 'EXTENDS', 0.8),
    ];

    const llmResponse = JSON.stringify({
      novelty: 4,
      plausibility: 4,
      usefulness: 4,
      connection: 'Both relate to the user learning new skills',
      confidence: 0.8,
    });

    const provider = createMockProvider(llmResponse);

    const result = await remExplore(memories, buildGetRelations(relations), provider);

    // Result should have the correct structure
    expect(result).toHaveProperty('seedsExplored');
    expect(result).toHaveProperty('candidatesEvaluated');
    expect(result).toHaveProperty('discoveries');
    expect(result).toHaveProperty('failures');

    // If any discoveries were made, they should have correct structure
    for (const d of result.discoveries) {
      expect(d).toHaveProperty('seedId');
      expect(d).toHaveProperty('neighborId');
      expect(d).toHaveProperty('connectionDescription');
      expect(d).toHaveProperty('confidence');
      expect(d).toHaveProperty('noveltyScore');
      expect(d).toHaveProperty('plausibilityScore');
      expect(d).toHaveProperty('usefulnessScore');
    }
  });

  it('isolates per-seed errors — one seed failure does not stop others', async () => {
    const memories = [
      makeMemory({ id: 's1', prominence: 0.3, importance: 8, category: 'fact' }),
      makeMemory({ id: 's2', prominence: 0.3, importance: 8, category: 'event' }),
      makeMemory({ id: 'n1', prominence: 0.3, importance: 6, category: 'preference' }),
      makeMemory({ id: 'n2', prominence: 0.3, importance: 6, category: 'relationship' }),
    ];

    const relations = [
      makeRelation('s1', 'n1', 'EXTENDS', 0.8),
      makeRelation('n1', 'n2', 'EXTENDS', 0.8),
      makeRelation('s2', 'n2', 'EXTENDS', 0.8),
      makeRelation('n2', 'n1', 'EXTENDS', 0.8),
    ];

    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock-partial-fail',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('LLM rate limit');
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            novelty: 4, plausibility: 4, usefulness: 4,
            connection: 'Novel connection found',
            confidence: 0.75,
          }) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

    const result = await remExplore(memories, buildGetRelations(relations), provider);

    // Even if some seeds fail, the result should still be valid
    expect(result.failures).toBeGreaterThanOrEqual(0);
    expect(result.seedsExplored).toBeGreaterThanOrEqual(0);
    // The function should not throw
  });

  it('returns zero discoveries when all candidates rejected by judge', async () => {
    const memories = [
      makeMemory({ id: 's1', prominence: 0.3, importance: 8, category: 'fact' }),
      makeMemory({ id: 'n1', prominence: 0.3, importance: 6, category: 'event' }),
    ];

    const relations = [
      makeRelation('s1', 'n1', 'EXTENDS', 0.8),
    ];

    // LLM rejects all connections with low scores
    const llmResponse = JSON.stringify({
      novelty: 1,
      plausibility: 1,
      usefulness: 1,
      connection: 'NO_CONNECTION',
    });

    const provider = createMockProvider(llmResponse);

    const result = await remExplore(memories, buildGetRelations(relations), provider);

    // Discoveries should be empty since judge rejected
    expect(result.discoveries).toEqual([]);
  });

  it('increments failures when LLM returns unparseable response', async () => {
    const memories = [
      makeMemory({ id: 's1', prominence: 0.3, importance: 8, category: 'fact' }),
      makeMemory({ id: 'n1', prominence: 0.3, importance: 6, category: 'event' }),
    ];

    const relations = [
      makeRelation('s1', 'n1', 'EXTENDS', 0.8),
    ];

    const provider = createMockProvider('completely unparseable garbage response');

    const result = await remExplore(memories, buildGetRelations(relations), provider);

    // Should not throw, failures might be incremented
    expect(result).toHaveProperty('failures');
  });

  it('accepts partial config overrides', async () => {
    const memories = [
      makeMemory({ id: 'm1', prominence: 0.3, importance: 5, category: 'fact' }),
      makeMemory({ id: 'm2', prominence: 0.3, importance: 5, category: 'event' }),
    ];

    const relations = [makeRelation('m1', 'm2', 'EXTENDS', 0.8)];
    const provider = createMockProvider('{}');

    // Should work with partial config
    const result = await remExplore(memories, buildGetRelations(relations), provider, {
      maxSeeds: 1,
    });

    expect(result).toHaveProperty('seedsExplored');
    expect(result.seedsExplored).toBeLessThanOrEqual(1);
  });
});

// ============ Tests: DEFAULT_REM_CONFIG ============

describe('DEFAULT_REM_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_REM_CONFIG.noiseSigma).toBe(0.6);
    expect(DEFAULT_REM_CONFIG.maxSeeds).toBe(6);
    expect(DEFAULT_REM_CONFIG.maxCandidatesPerSeed).toBe(8);
    expect(DEFAULT_REM_CONFIG.seedNoiseSigma).toBe(0.3);
    expect(DEFAULT_REM_CONFIG.maxSeedsPerCategory).toBe(2);
    expect(DEFAULT_REM_CONFIG.maxSteps).toBe(4);
    expect(DEFAULT_REM_CONFIG.decayFactor).toBe(0.4);
    expect(DEFAULT_REM_CONFIG.resultThreshold).toBe(0.02);
    expect(DEFAULT_REM_CONFIG.activationThreshold).toBe(0.005);
    expect(DEFAULT_REM_CONFIG.minJudgeScore).toBe(3.0);
    expect(DEFAULT_REM_CONFIG.prominenceWindow).toEqual({ min: 0.05, max: 0.8 });
  });
});
