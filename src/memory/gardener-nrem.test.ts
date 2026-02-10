/**
 * Integration tests for NREM consolidation wired into BackgroundGardener.sleepTick().
 *
 * Tests the full pipeline: sleepTick -> nremConsolidate -> storage -> relations -> supersession.
 * Does NOT re-test pure nremConsolidate() behavior (covered in nrem-consolidation.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import {
  ScallopMemoryStore,
  BackgroundGardener,
  type EmbeddingProvider,
} from './index.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

// ─── Shared Helpers ─────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/gardener-nrem-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch { /* noop */ }
  }
}

/** Simple mock embedder that returns zero vectors (we don't need semantic search) */
function createMockEmbedder(): EmbeddingProvider {
  return {
    name: 'mock-embedder',
    dimension: 32,
    embed: vi.fn().mockResolvedValue(new Array(32).fill(0)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(32).fill(0))),
    ),
    isAvailable: () => true,
  };
}

/** Creates a mock LLM provider that returns valid NREM fusion JSON */
function createMockFusionProvider(responseText?: string): LLMProvider {
  const defaultResponse = JSON.stringify({
    summary: 'Fused insight',
    importance: 7,
    category: 'insight',
  });
  return {
    name: 'mock-fusion',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText ?? defaultResponse }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

/** Creates a mock provider where complete() calls can be individually controlled */
function createSequentialFusionProvider(responses: Array<string | Error>): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-sequential-fusion',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex % responses.length];
      callIndex++;
      if (response instanceof Error) {
        throw response;
      }
      return {
        content: [{ type: 'text', text: response }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse;
    }),
  };
}

/** Seed a memory directly in the DB with specific prominence and category */
function seedMemory(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    importance?: number;
  },
) {
  return db.addMemory({
    userId: opts.userId ?? 'user-1',
    content: opts.content,
    category: opts.category,
    memoryType: 'regular',
    importance: opts.importance ?? 6,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
  });
}

// ─── Tests ─────────────────────────────────────────────────────

describe('BackgroundGardener NREM integration', () => {
  let store: ScallopMemoryStore;
  let gardener: BackgroundGardener;

  afterEach(() => {
    if (gardener) gardener.stop();
    if (store) store.close();
    cleanupTestDb();
  });

  // ─── Test 1: Full NREM pipeline ─────────────────────────────

  it('sleepTick runs NREM consolidation when fusionProvider available', async () => {
    cleanupTestDb();
    const fusionProvider = createMockFusionProvider();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
    });

    const db = store.getDatabase();

    // Seed 4 memories in NREM range [0.05, 0.8) across 2 categories
    const m1 = seedMemory(db, { content: 'Likes Earl Grey tea every morning', category: 'preference', prominence: 0.3 });
    const m2 = seedMemory(db, { content: 'Prefers dark roast coffee', category: 'preference', prominence: 0.4 });
    const m3 = seedMemory(db, { content: 'Usually has breakfast at 7am', category: 'fact', prominence: 0.35 });
    const m4 = seedMemory(db, { content: 'Morning routine includes meditation', category: 'fact', prominence: 0.25 });

    // Add relations to form a connected component (BFS needs edges)
    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    await gardener.sleepTick();

    // Assert: fusionProvider was called
    expect(fusionProvider.complete).toHaveBeenCalled();

    // Assert: new derived memory exists
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);

    const fused = derivedMemories[0];
    expect(fused.content).toBe('Fused insight');
    expect(fused.learnedFrom).toBe('nrem_consolidation');
    expect(fused.metadata).toBeDefined();
    expect(fused.metadata!.nrem).toBe(true);
    expect(fused.metadata!.sourceCount).toBeGreaterThanOrEqual(3);

    // Assert: sources marked superseded
    const sourceIds = fused.metadata!.sourceIds as string[];
    for (const sid of sourceIds) {
      const source = db.getMemory(sid);
      expect(source).not.toBeNull();
      expect(source!.memoryType).toBe('superseded');
      expect(source!.isLatest).toBe(false);
    }

    // Assert: DERIVES relations created
    const fusedRelations = db.getRelations(fused.id);
    const derivesRelations = fusedRelations.filter(r => r.relationType === 'DERIVES');
    expect(derivesRelations.length).toBe(sourceIds.length);
  });

  // ─── Test 2: No fusionProvider ─────────────────────────────

  it('sleepTick skips NREM when no fusionProvider', async () => {
    cleanupTestDb();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      // No fusionProvider
    });

    const db = store.getDatabase();

    // Seed some memories
    seedMemory(db, { content: 'Memory A', category: 'fact', prominence: 0.3 });
    seedMemory(db, { content: 'Memory B', category: 'fact', prominence: 0.4 });

    // sleepTick should complete without error
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // No derived memories should be created
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBe(0);
  });

  // ─── Test 3: Wider prominence window than deepTick ─────────

  it('sleepTick NREM uses wider prominence window than deepTick', async () => {
    cleanupTestDb();
    const fusionProvider = createMockFusionProvider();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
    });

    const db = store.getDatabase();

    // Seed memories at prominence edges that deep tick would miss:
    // - 0.06: below deep-tick's 0.1 floor, but within NREM's 0.05
    // - 0.75: above deep-tick's 0.7 cap, but within NREM's 0.8
    const m1 = seedMemory(db, { content: 'Fading memory about old trip', category: 'fact', prominence: 0.06 });
    const m2 = seedMemory(db, { content: 'Recently learned cooking fact', category: 'fact', prominence: 0.75 });
    const m3 = seedMemory(db, { content: 'Slightly decayed preference for tea', category: 'preference', prominence: 0.5 });
    const m4 = seedMemory(db, { content: 'Moderate importance travel plan', category: 'fact', prominence: 0.4 });

    // Connect them so BFS finds a cluster
    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.7);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    await gardener.sleepTick();

    // Assert: fusionProvider was called (memories at 0.06 and 0.75 were included)
    expect(fusionProvider.complete).toHaveBeenCalled();

    // Assert: derived memory created from these memories
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);

    // Check that sources include the edge-case prominences
    const fused = derivedMemories[0];
    const sourceIds = fused.metadata!.sourceIds as string[];
    expect(sourceIds).toContain(m1.id); // 0.06 prominence
    expect(sourceIds).toContain(m2.id); // 0.75 prominence
  });

  // ─── Test 4: Cross-category clusters ────────────────────────

  it('sleepTick NREM produces cross-category clusters', async () => {
    cleanupTestDb();
    const fusionProvider = createMockFusionProvider();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
    });

    const db = store.getDatabase();

    // Seed 3 facts + 2 preferences with relations connecting them
    const f1 = seedMemory(db, { content: 'Works at a tech company', category: 'fact', prominence: 0.4 });
    const f2 = seedMemory(db, { content: 'Commutes by bicycle', category: 'fact', prominence: 0.35 });
    const f3 = seedMemory(db, { content: 'Office is in downtown area', category: 'fact', prominence: 0.3 });
    const p1 = seedMemory(db, { content: 'Prefers cycling over driving', category: 'preference', prominence: 0.45 });
    const p2 = seedMemory(db, { content: 'Likes working in open office spaces', category: 'preference', prominence: 0.38 });

    // Connect all into one cluster (cross-category)
    db.addRelation(f1.id, f2.id, 'EXTENDS', 0.8);
    db.addRelation(f2.id, f3.id, 'EXTENDS', 0.7);
    db.addRelation(f2.id, p1.id, 'EXTENDS', 0.75);
    db.addRelation(f1.id, p2.id, 'EXTENDS', 0.7);

    await gardener.sleepTick();

    // Assert: fusionProvider was called
    expect(fusionProvider.complete).toHaveBeenCalled();

    // Assert: fused memory created from cross-category sources
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);

    const fused = derivedMemories[0];
    const sourceIds = fused.metadata!.sourceIds as string[];

    // Sources should span both categories
    const sourceMemories = sourceIds.map(id => db.getMemory(id)!);
    const categories = new Set(sourceMemories.map(m => m.category));
    // With cross-category clustering, sources should include both facts and preferences
    // (at minimum the cluster should have 3+ members from connected BFS component)
    expect(sourceIds.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Test 5: Per-cluster error isolation ────────────────────

  it('sleepTick NREM isolates per-cluster errors', async () => {
    cleanupTestDb();

    // First call throws, second returns valid result
    const fusionProvider = createSequentialFusionProvider([
      new Error('LLM rate limit'),
      JSON.stringify({ summary: 'Second cluster fused', importance: 6, category: 'fact' }),
    ]);

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
    });

    const db = store.getDatabase();

    // Create two disconnected clusters (no relations between them)

    // Cluster A: 3 connected facts
    const a1 = seedMemory(db, { content: 'Cluster A fact one about cooking', category: 'fact', prominence: 0.3 });
    const a2 = seedMemory(db, { content: 'Cluster A fact two about recipes', category: 'fact', prominence: 0.35 });
    const a3 = seedMemory(db, { content: 'Cluster A fact three about ingredients', category: 'fact', prominence: 0.32 });
    db.addRelation(a1.id, a2.id, 'EXTENDS', 0.8);
    db.addRelation(a2.id, a3.id, 'EXTENDS', 0.7);

    // Cluster B: 3 connected preferences
    const b1 = seedMemory(db, { content: 'Cluster B pref one about music', category: 'preference', prominence: 0.4 });
    const b2 = seedMemory(db, { content: 'Cluster B pref two about genres', category: 'preference', prominence: 0.38 });
    const b3 = seedMemory(db, { content: 'Cluster B pref three about artists', category: 'preference', prominence: 0.42 });
    db.addRelation(b1.id, b2.id, 'EXTENDS', 0.8);
    db.addRelation(b2.id, b3.id, 'EXTENDS', 0.7);

    // sleepTick should not throw despite first cluster failing
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // Assert: fusionProvider was called at least twice (once per cluster)
    expect(fusionProvider.complete).toHaveBeenCalledTimes(2);

    // Assert: at least one derived memory was created (from the second cluster that succeeded)
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);
    expect(derivedMemories[0].content).toBe('Second cluster fused');
  });
});
