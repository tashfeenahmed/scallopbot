/**
 * Tests for NREM Consolidation Module
 *
 * Tests the relation-context-enriched fusion pipeline:
 * - buildRelationContext: filters intra-cluster relations, caps per memory
 * - buildNremFusionPrompt: CompletionRequest with CONNECTIONS section
 * - nremConsolidate: orchestrates pipeline with per-cluster error isolation
 */

import { describe, it, expect, vi } from 'vitest';
import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import {
  buildRelationContext,
  buildNremFusionPrompt,
  nremConsolidate,
  DEFAULT_NREM_CONFIG,
  type NremConfig,
  type NremResult,
  type RelationContextEntry,
} from './nrem-consolidation.js';

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
    documentDate: Date.now() - 86400000, // 1 day ago
    eventDate: null,
    prominence: 0.3, // in dormant range by default
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

// ============ Tests ============

describe('buildRelationContext', () => {
  it('returns entries for intra-cluster relations with correct indices and content', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'User is interested in learning Rust' }),
      makeMemory({ id: 'm2', content: 'User expressed frustration with Node.js memory leaks' }),
      makeMemory({ id: 'm3', content: 'User prefers type-safe languages' }),
    ];

    const relations = [
      makeRelation('m1', 'm3', 'EXTENDS', 0.9),
      makeRelation('m2', 'm1', 'EXTENDS', 0.7),
    ];

    const entries = buildRelationContext(cluster, buildGetRelations(relations), 3);

    expect(entries.length).toBeGreaterThan(0);

    // Verify entries have correct structure
    for (const entry of entries) {
      expect(entry).toHaveProperty('memoryIndex');
      expect(entry).toHaveProperty('relationType');
      expect(entry).toHaveProperty('targetIndex');
      expect(entry).toHaveProperty('targetContent');
      expect(entry).toHaveProperty('confidence');
      expect(entry.memoryIndex).toBeGreaterThanOrEqual(1);
      expect(entry.targetIndex).toBeGreaterThanOrEqual(1);
    }

    // Should have relation from m1 to m3 (both in cluster)
    const m1ToM3 = entries.find(e => e.memoryIndex === 1 && e.targetIndex === 3);
    expect(m1ToM3).toBeDefined();
    expect(m1ToM3!.relationType).toBe('EXTENDS');
    expect(m1ToM3!.confidence).toBe(0.9);
  });

  it('excludes relations to memories outside the cluster', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Memory in cluster' }),
      makeMemory({ id: 'm2', content: 'Another memory in cluster' }),
      makeMemory({ id: 'm3', content: 'Third memory in cluster' }),
    ];

    // m1 has a relation to m4 which is NOT in the cluster
    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m1', 'm4', 'EXTENDS'), // m4 is outside cluster
      makeRelation('m2', 'm3', 'EXTENDS'),
    ];

    const entries = buildRelationContext(cluster, buildGetRelations(relations), 3);

    // No entry should reference an index outside cluster range
    for (const entry of entries) {
      expect(entry.memoryIndex).toBeLessThanOrEqual(3);
      expect(entry.targetIndex).toBeLessThanOrEqual(3);
    }

    // Should NOT include the m1→m4 relation
    const toOutside = entries.find(e => e.targetIndex > 3 || e.memoryIndex > 3);
    expect(toOutside).toBeUndefined();
  });

  it('caps relations per memory at maxPerMemory', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Central memory' }),
      makeMemory({ id: 'm2', content: 'Related memory 2' }),
      makeMemory({ id: 'm3', content: 'Related memory 3' }),
      makeMemory({ id: 'm4', content: 'Related memory 4' }),
      makeMemory({ id: 'm5', content: 'Related memory 5' }),
    ];

    // m1 has relations to all other cluster members (4 relations)
    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m1', 'm3', 'EXTENDS'),
      makeRelation('m1', 'm4', 'EXTENDS'),
      makeRelation('m1', 'm5', 'EXTENDS'),
    ];

    // Cap at 2 per memory
    const entries = buildRelationContext(cluster, buildGetRelations(relations), 2);

    // Count entries where memoryIndex === 1 (m1)
    const m1Entries = entries.filter(e => e.memoryIndex === 1);
    expect(m1Entries.length).toBeLessThanOrEqual(2);
  });

  it('truncates targetContent to 80 characters', () => {
    const longContent = 'A'.repeat(120);
    const cluster = [
      makeMemory({ id: 'm1', content: 'Short memory' }),
      makeMemory({ id: 'm2', content: longContent }),
      makeMemory({ id: 'm3', content: 'Another memory' }),
    ];

    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m2', 'm3', 'EXTENDS'),
    ];

    const entries = buildRelationContext(cluster, buildGetRelations(relations), 3);

    // Find entry pointing to m2 (the long content memory)
    const toM2 = entries.find(e => e.targetIndex === 2);
    expect(toM2).toBeDefined();
    expect(toM2!.targetContent.length).toBeLessThanOrEqual(80);
  });

  it('returns empty array when no intra-cluster relations exist', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Isolated memory 1' }),
      makeMemory({ id: 'm2', content: 'Isolated memory 2' }),
      makeMemory({ id: 'm3', content: 'Isolated memory 3' }),
    ];

    // Relations exist but only to external memories
    const relations = [
      makeRelation('m1', 'external1', 'EXTENDS'),
      makeRelation('m2', 'external2', 'EXTENDS'),
    ];

    const entries = buildRelationContext(cluster, buildGetRelations(relations), 3);

    expect(entries).toHaveLength(0);
  });
});

describe('buildNremFusionPrompt', () => {
  it('includes system prompt mentioning deep sleep consolidation', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Interested in Rust', category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js', category: 'event', importance: 6 }),
      makeMemory({ id: 'm3', content: 'Prefers type-safe languages', category: 'preference', importance: 8 }),
    ];

    const relationContext: RelationContextEntry[] = [
      { memoryIndex: 1, relationType: 'EXTENDS', targetIndex: 3, targetContent: 'Prefers type-safe languages', confidence: 0.9 },
    ];

    const prompt = buildNremFusionPrompt(cluster, relationContext);

    expect(prompt.system).toBeDefined();
    expect(prompt.system!.toLowerCase()).toContain('deep sleep consolidation');
    expect(prompt.system!.toLowerCase()).toContain('cross-category');
  });

  it('includes numbered MEMORIES TO MERGE section with content, category, and importance', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Interested in Rust', category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js', category: 'event', importance: 6 }),
      makeMemory({ id: 'm3', content: 'Prefers type-safe languages', category: 'preference', importance: 8 }),
    ];

    const prompt = buildNremFusionPrompt(cluster, []);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('MEMORIES TO MERGE');
    expect(userContent).toContain('Interested in Rust');
    expect(userContent).toContain('Frustrated with Node.js');
    expect(userContent).toContain('Prefers type-safe languages');
    expect(userContent).toContain('fact');
    expect(userContent).toContain('event');
    expect(userContent).toContain('preference');
    expect(userContent).toContain('7');
    expect(userContent).toContain('6');
    expect(userContent).toContain('8');
  });

  it('includes CONNECTIONS section with relation types between members', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Interested in Rust', category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js', category: 'event', importance: 6 }),
      makeMemory({ id: 'm3', content: 'Prefers type-safe languages', category: 'preference', importance: 8 }),
    ];

    const relationContext: RelationContextEntry[] = [
      { memoryIndex: 1, relationType: 'EXTENDS', targetIndex: 3, targetContent: 'Prefers type-safe languages', confidence: 0.9 },
      { memoryIndex: 2, relationType: 'DERIVES', targetIndex: 1, targetContent: 'Interested in Rust', confidence: 0.7 },
    ];

    const prompt = buildNremFusionPrompt(cluster, relationContext);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('CONNECTIONS');
    expect(userContent).toContain('Memory 1');
    expect(userContent).toContain('Memory 2');
    expect(userContent).toContain('EXTENDS');
    expect(userContent).toContain('DERIVES');
  });

  it('shows fallback text when no connections exist', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Memory A', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm2', content: 'Memory B', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm3', content: 'Memory C', category: 'fact', importance: 5 }),
    ];

    const prompt = buildNremFusionPrompt(cluster, []);
    const userContent = prompt.messages[0].content as string;

    expect(userContent).toContain('CONNECTIONS');
    // Should have fallback text when no connections
    expect(userContent).toMatch(/no explicit connections|semantic space/i);
  });

  it('uses temperature 0.1 and maxTokens 500', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Memory A', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm2', content: 'Memory B', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm3', content: 'Memory C', category: 'fact', importance: 5 }),
    ];

    const prompt = buildNremFusionPrompt(cluster, []);

    expect(prompt.temperature).toBe(0.1);
    expect(prompt.maxTokens).toBe(500);
  });

  it('requests JSON response format in system prompt', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Memory A', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm2', content: 'Memory B', category: 'fact', importance: 5 }),
      makeMemory({ id: 'm3', content: 'Memory C', category: 'fact', importance: 5 }),
    ];

    const prompt = buildNremFusionPrompt(cluster, []);

    expect(prompt.system).toContain('JSON');
    expect(prompt.system).toContain('summary');
    expect(prompt.system).toContain('importance');
    expect(prompt.system).toContain('category');
  });
});

describe('nremConsolidate', () => {
  it('returns empty result for empty memories array', async () => {
    const provider = createMockProvider('{}');

    const result = await nremConsolidate([], buildGetRelations([]), provider);

    expect(result.clustersProcessed).toBe(0);
    expect(result.fusionResults).toHaveLength(0);
    expect(result.failures).toBe(0);
  });

  it('processes clusters and returns fusionResults with learnedFrom marker', async () => {
    // Create 3 related memories that form a cluster
    const memories = [
      makeMemory({ id: 'm1', content: 'Interested in Rust programming', prominence: 0.3, category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js memory leaks at work', prominence: 0.25, category: 'event', importance: 6 }),
      makeMemory({ id: 'm3', content: 'User prefers type-safe programming languages', prominence: 0.2, category: 'preference', importance: 8 }),
    ];

    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m2', 'm3', 'EXTENDS'),
    ];

    const llmResponse = JSON.stringify({
      summary: 'Moving toward Rust due to Node.js frustration, reflecting preference for type safety',
      importance: 8,
      category: 'insight',
    });

    const provider = createMockProvider(llmResponse);

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    expect(result.clustersProcessed).toBeGreaterThanOrEqual(1);
    expect(result.fusionResults.length).toBeGreaterThanOrEqual(1);
    expect(result.fusionResults[0].learnedFrom).toBe('nrem_consolidation');
  });

  it('sets category to insight for cross-category clusters', async () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Interested in Rust programming', prominence: 0.3, category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js memory leaks', prominence: 0.25, category: 'event', importance: 6 }),
      makeMemory({ id: 'm3', content: 'User prefers type-safe languages over dynamic ones', prominence: 0.2, category: 'preference', importance: 8 }),
    ];

    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m2', 'm3', 'EXTENDS'),
    ];

    const llmResponse = JSON.stringify({
      summary: 'Moving toward Rust due to Node.js frustration',
      importance: 8,
      category: 'fact', // LLM says fact, but NREM should override to insight for cross-category
    });

    const provider = createMockProvider(llmResponse);

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    if (result.fusionResults.length > 0) {
      expect(result.fusionResults[0].category).toBe('insight');
    }
  });

  it('isolates per-cluster failures — one failure does not stop others', async () => {
    // Create two separate clusters
    const memories = [
      // Cluster A: 3 facts
      makeMemory({ id: 'a1', content: 'Lives in Dublin city center near the river Liffey area', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'a2', content: 'Works in Dublin city centre at a large technology company', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'a3', content: 'Office is near Trinity College Dublin campus in city center', prominence: 0.2, category: 'fact' }),
      // Cluster B: 3 facts
      makeMemory({ id: 'b1', content: 'User enjoys hiking in mountains and national parks regularly', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'b2', content: 'Hiked Mount Fuji during the summer climbing season in Japan', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'b3', content: 'Plans to hike Kilimanjaro in Tanzania next year in the spring', prominence: 0.2, category: 'fact' }),
    ];

    const relations = [
      makeRelation('a1', 'a2'),
      makeRelation('a2', 'a3'),
      makeRelation('b1', 'b2'),
      makeRelation('b2', 'b3'),
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
            summary: 'Hiking enthusiast who has climbed Fuji and plans Kilimanjaro',
            importance: 7,
            category: 'fact',
          }) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    // Both clusters should have been attempted
    expect(result.clustersProcessed).toBe(2);
    // One should have failed, one should have succeeded
    expect(result.failures).toBe(1);
    expect(result.fusionResults.length).toBe(1);
  });

  it('returns all failures when LLM fails for every cluster', async () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Fact about Dublin living near river Liffey', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Fact about working in Dublin city at tech company', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Fact about Dublin office near Trinity College campus', prominence: 0.2, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
    ];

    const provider = createFailingProvider('API unavailable');

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    expect(result.clustersProcessed).toBeGreaterThanOrEqual(1);
    expect(result.fusionResults).toHaveLength(0);
    expect(result.failures).toBeGreaterThanOrEqual(1);
  });

  it('uses NREM config defaults (minProminence 0.05, maxProminence 0.8, crossCategory true)', async () => {
    // Memory at prominence 0.06 (below DORMANT but within NREM range)
    const memories = [
      makeMemory({ id: 'm1', content: 'Very faded memory about user learning Python language basics', prominence: 0.06, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Very faded memory about user practicing Python at coding bootcamp', prominence: 0.07, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Very faded memory about user completing Python course certificate online', prominence: 0.08, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
    ];

    const llmResponse = JSON.stringify({
      summary: 'User learned Python through bootcamp',
      importance: 5,
      category: 'fact',
    });

    const provider = createMockProvider(llmResponse);

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    // Memories at 0.06-0.08 are below standard dormant (0.1) but within NREM range (0.05+)
    expect(result.clustersProcessed).toBeGreaterThanOrEqual(1);
    expect(result.fusionResults.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts partial config overrides', async () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Memory A in a short form', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Memory B in a short form', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Memory C in a short form', prominence: 0.2, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
    ];

    const llmResponse = JSON.stringify({
      summary: 'Combined memory',
      importance: 5,
      category: 'fact',
    });

    const provider = createMockProvider(llmResponse);

    // Override just maxClusters
    const result = await nremConsolidate(memories, buildGetRelations(relations), provider, {
      maxClusters: 1,
    });

    // Should still work with partial override
    expect(result.clustersProcessed).toBeLessThanOrEqual(1);
  });

  it('includes sourceMemoryIds in fusion results', async () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Interested in Rust programming language for systems', prominence: 0.3, category: 'fact', importance: 7 }),
      makeMemory({ id: 'm2', content: 'Frustrated with Node.js leaks in production services', prominence: 0.25, category: 'fact', importance: 6 }),
      makeMemory({ id: 'm3', content: 'User prefers type-safe programming languages like Rust', prominence: 0.2, category: 'fact', importance: 8 }),
    ];

    const relations = [
      makeRelation('m1', 'm2', 'EXTENDS'),
      makeRelation('m2', 'm3', 'EXTENDS'),
    ];

    const llmResponse = JSON.stringify({
      summary: 'Moving toward Rust due to Node.js issues',
      importance: 8,
      category: 'fact',
    });

    const provider = createMockProvider(llmResponse);

    const result = await nremConsolidate(memories, buildGetRelations(relations), provider);

    if (result.fusionResults.length > 0) {
      expect(result.fusionResults[0].sourceMemoryIds).toBeDefined();
      expect(result.fusionResults[0].sourceMemoryIds.length).toBeGreaterThanOrEqual(3);
      expect(result.fusionResults[0].sourceMemoryIds).toContain('m1');
      expect(result.fusionResults[0].sourceMemoryIds).toContain('m2');
      expect(result.fusionResults[0].sourceMemoryIds).toContain('m3');
    }
  });
});

describe('DEFAULT_NREM_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_NREM_CONFIG.minProminence).toBe(0.05);
    expect(DEFAULT_NREM_CONFIG.maxProminence).toBe(0.8);
    expect(DEFAULT_NREM_CONFIG.maxClusters).toBe(10);
    expect(DEFAULT_NREM_CONFIG.minClusterSize).toBe(3);
    expect(DEFAULT_NREM_CONFIG.maxRelationsPerMemory).toBe(3);
  });
});
