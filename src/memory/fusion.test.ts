/**
 * Tests for Memory Fusion Engine
 *
 * Tests cluster detection (findFusionClusters) and LLM-guided
 * content merging (fuseMemoryCluster) as pure, testable functions.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';
import {
  findFusionClusters,
  fuseMemoryCluster,
  buildFusionPrompt,
  DEFAULT_FUSION_CONFIG,
  type FusionConfig,
  type FusionResult,
} from './fusion.js';

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
function makeRelation(sourceId: string, targetId: string, relationType: 'UPDATES' | 'EXTENDS' | 'DERIVES' = 'EXTENDS'): MemoryRelation {
  return {
    id: `rel-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    relationType,
    confidence: 0.8,
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

describe('findFusionClusters', () => {
  it('returns 1 cluster of 3 when 3 related facts are in dormant range', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin city centre', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Office is near Trinity College Dublin', prominence: 0.2, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
    ];

    const clusters = findFusionClusters(memories, buildGetRelations(relations));

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
    const clusterIds = clusters[0].map(m => m.id).sort();
    expect(clusterIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns empty array when 2 related facts are below minClusterSize=3', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', prominence: 0.25, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
    ];

    const clusters = findFusionClusters(memories, buildGetRelations(relations), { minClusterSize: 3 });

    expect(clusters).toHaveLength(0);
  });

  it('splits mixed categories in connected component into per-category sub-clusters', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Dublin office is great', prominence: 0.2, category: 'fact' }),
      makeMemory({ id: 'm4', content: 'Prefers warm weather', prominence: 0.3, category: 'preference' }),
      makeMemory({ id: 'm5', content: 'Likes Irish food', prominence: 0.25, category: 'preference' }),
      makeMemory({ id: 'm6', content: 'Prefers tea over coffee', prominence: 0.2, category: 'preference' }),
    ];

    // All connected in one graph component
    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
      makeRelation('m3', 'm4'),
      makeRelation('m4', 'm5'),
      makeRelation('m5', 'm6'),
    ];

    const clusters = findFusionClusters(memories, buildGetRelations(relations), { minClusterSize: 3 });

    // Should produce 2 clusters: one for facts (m1,m2,m3), one for preferences (m4,m5,m6)
    expect(clusters).toHaveLength(2);

    const factCluster = clusters.find(c => c[0].category === 'fact')!;
    const prefCluster = clusters.find(c => c[0].category === 'preference')!;

    expect(factCluster).toHaveLength(3);
    expect(prefCluster).toHaveLength(3);
  });

  it('excludes active memories (prominence >= 0.5) even if related', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Dublin office hours', prominence: 0.2, category: 'fact' }),
      makeMemory({ id: 'm4', content: 'Just mentioned Dublin today', prominence: 0.7, category: 'fact' }), // active
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
      makeRelation('m3', 'm4'),
    ];

    const clusters = findFusionClusters(memories, buildGetRelations(relations));

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
    // m4 should be excluded (active)
    const ids = clusters[0].map(m => m.id);
    expect(ids).not.toContain('m4');
  });

  it('excludes derived memories even if in dormant range', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Dublin-related summary', prominence: 0.2, category: 'fact', memoryType: 'derived' }),
      makeMemory({ id: 'm4', content: 'Dublin office', prominence: 0.2, category: 'fact' }),
    ];

    const relations = [
      makeRelation('m1', 'm2'),
      makeRelation('m2', 'm3'),
      makeRelation('m3', 'm4'),
      makeRelation('m1', 'm4'),
    ];

    const clusters = findFusionClusters(memories, buildGetRelations(relations));

    expect(clusters).toHaveLength(1);
    // m3 (derived) should be excluded
    const ids = clusters[0].map(m => m.id);
    expect(ids).not.toContain('m3');
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');
    expect(ids).toContain('m4');
  });

  it('returns no clusters when no relations exist (singletons excluded)', () => {
    const memories = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', prominence: 0.3, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works at Google', prominence: 0.25, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Enjoys hiking', prominence: 0.2, category: 'fact' }),
    ];

    const noRelations: MemoryRelation[] = [];

    const clusters = findFusionClusters(memories, buildGetRelations(noRelations));

    expect(clusters).toHaveLength(0);
  });

  it('returns top 5 clusters by size when 10 clusters found and maxClusters=5', () => {
    const memories: ScallopMemoryEntry[] = [];
    const relations: MemoryRelation[] = [];

    // Create 10 clusters of varying sizes (3-12 memories each)
    for (let cluster = 0; cluster < 10; cluster++) {
      const clusterSize = 3 + cluster; // sizes: 3, 4, 5, ..., 12
      const clusterMemories: ScallopMemoryEntry[] = [];

      for (let i = 0; i < clusterSize; i++) {
        const mem = makeMemory({
          id: `c${cluster}-m${i}`,
          content: `Cluster ${cluster} memory ${i}`,
          prominence: 0.3,
          category: 'fact',
        });
        clusterMemories.push(mem);
        memories.push(mem);
      }

      // Chain relations within cluster
      for (let i = 0; i < clusterSize - 1; i++) {
        relations.push(makeRelation(`c${cluster}-m${i}`, `c${cluster}-m${i + 1}`));
      }
    }

    const clusters = findFusionClusters(memories, buildGetRelations(relations), { maxClusters: 5 });

    expect(clusters).toHaveLength(5);
    // Should be sorted by size descending - largest clusters first
    for (let i = 0; i < clusters.length - 1; i++) {
      expect(clusters[i].length).toBeGreaterThanOrEqual(clusters[i + 1].length);
    }
    // The largest cluster should have 12 members (cluster index 9)
    expect(clusters[0]).toHaveLength(12);
  });
});

describe('fuseMemoryCluster', () => {
  it('returns fused summary mentioning all facts for 3 facts about same topic', async () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', importance: 7, confidence: 0.9, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works at a tech company in Dublin', importance: 5, confidence: 0.8, category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Office is near Trinity College', importance: 6, confidence: 0.85, category: 'fact' }),
    ];

    const llmResponse = JSON.stringify({
      summary: 'Lives and works at a tech company in Dublin, with office near Trinity College',
      importance: 7,
      category: 'fact',
    });

    const provider = createMockProvider(llmResponse);

    const result = await fuseMemoryCluster(cluster, provider);

    expect(result).not.toBeNull();
    expect(result!.summary).toContain('Dublin');
    expect(result!.summary).toContain('Trinity College');
    expect(result!.importance).toBe(7); // max of sources
    expect(result!.category).toBe('fact');
    expect(result!.confidence).toBeCloseTo(0.8, 2); // min of sources
  });

  it('returns null when LLM returns invalid JSON', async () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Office in Dublin', category: 'fact' }),
    ];

    const provider = createMockProvider('This is not valid JSON {broken');

    const result = await fuseMemoryCluster(cluster, provider);

    expect(result).toBeNull();
  });

  it('returns null when LLM call throws', async () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Works in Dublin', category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Office in Dublin', category: 'fact' }),
    ];

    const provider = createFailingProvider('API rate limit exceeded');

    const result = await fuseMemoryCluster(cluster, provider);

    expect(result).toBeNull();
  });

  it('returns null for empty cluster', async () => {
    const provider = createMockProvider('{}');

    const result = await fuseMemoryCluster([], provider);

    expect(result).toBeNull();
    // Should NOT call the LLM for empty cluster
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns null when summary is longer than combined sources (validation)', async () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Dublin', category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Office', category: 'fact' }),
      makeMemory({ id: 'm3', content: 'Work', category: 'fact' }),
    ];

    // Summary is much longer than all sources combined ("Dublin" + "Office" + "Work" = 16 chars)
    const longSummary = 'This is a very long summary that is much longer than the combined source content of all the memories in the cluster, which violates the fusion rule';
    const llmResponse = JSON.stringify({
      summary: longSummary,
      importance: 5,
      category: 'fact',
    });

    const provider = createMockProvider(llmResponse);

    const result = await fuseMemoryCluster(cluster, provider);

    expect(result).toBeNull();
  });
});

describe('buildFusionPrompt', () => {
  it('includes all memory contents with categories and importance', () => {
    const cluster = [
      makeMemory({ id: 'm1', content: 'Lives in Dublin', importance: 7, category: 'fact' }),
      makeMemory({ id: 'm2', content: 'Prefers tea', importance: 5, category: 'preference' }),
      makeMemory({ id: 'm3', content: 'Moved to Ireland in 2020', importance: 6, category: 'event' }),
    ];

    const prompt = buildFusionPrompt(cluster);

    // Verify all memory contents are present
    expect(prompt.messages[0].content).toContain('Lives in Dublin');
    expect(prompt.messages[0].content).toContain('Prefers tea');
    expect(prompt.messages[0].content).toContain('Moved to Ireland in 2020');

    // Verify categories are included
    expect(prompt.messages[0].content).toContain('fact');
    expect(prompt.messages[0].content).toContain('preference');
    expect(prompt.messages[0].content).toContain('event');

    // Verify importance values are included
    expect(prompt.messages[0].content).toContain('7');
    expect(prompt.messages[0].content).toContain('5');
    expect(prompt.messages[0].content).toContain('6');

    // Verify system prompt exists
    expect(prompt.system).toBeDefined();

    // Verify low temperature for consistency
    expect(prompt.temperature).toBeLessThanOrEqual(0.2);
  });
});

describe('DEFAULT_FUSION_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_FUSION_CONFIG.minClusterSize).toBe(3);
    expect(DEFAULT_FUSION_CONFIG.maxClusters).toBe(5);
    expect(DEFAULT_FUSION_CONFIG.minProminence).toBeCloseTo(0.1, 2); // DORMANT
    expect(DEFAULT_FUSION_CONFIG.maxProminence).toBeCloseTo(0.5, 2); // ACTIVE
  });
});
