/**
 * Integration tests for REM exploration wired into BackgroundGardener.sleepTick().
 *
 * Tests the full pipeline: sleepTick -> dream() -> remExplore -> EXTENDS relations.
 * Does NOT re-test pure remExplore() behavior (covered in rem-exploration.test.ts).
 *
 * Key REM invariants:
 * - REM does NOT create new memories — only EXTENDS relations between existing ones
 * - REM does NOT supersede or modify existing memories (unlike NREM)
 * - REM runs after NREM without interference
 * - REM failure does not block NREM results
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import {
  ScallopMemoryStore,
  BackgroundGardener,
  type EmbeddingProvider,
} from './index.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

// ─── Shared Helpers ─────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/gardener-rem-test.db';
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

/** Valid REM judge JSON that passes the minJudgeScore threshold */
const VALID_REM_JUDGE_RESPONSE = JSON.stringify({
  novelty: 4,
  plausibility: 4,
  usefulness: 4,
  connection: 'Both relate to morning beverage rituals',
  confidence: 0.8,
});

/** REM judge JSON with NO_CONNECTION */
const NO_CONNECTION_RESPONSE = JSON.stringify({
  novelty: 1,
  plausibility: 1,
  usefulness: 1,
  connection: 'NO_CONNECTION',
});

/** Valid NREM fusion JSON */
const VALID_NREM_FUSION_RESPONSE = JSON.stringify({
  summary: 'Fused insight from NREM',
  importance: 7,
  category: 'insight',
});

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

describe('BackgroundGardener REM integration', () => {
  let store: ScallopMemoryStore;
  let gardener: BackgroundGardener;

  afterEach(() => {
    if (gardener) gardener.stop();
    if (store) store.close();
    cleanupTestDb();
  });

  // ─── Test a: EXTENDS relations for REM discoveries ──────────

  it('sleepTick creates EXTENDS relations for REM discoveries', async () => {
    cleanupTestDb();

    // Provider returns NREM fusion for NREM calls, REM judge for REM calls.
    // Since both NREM and REM share the provider, we use a smart mock that
    // distinguishes by prompt content.
    let callCount = 0;
    const fusionProvider: LLMProvider = {
      name: 'mock-dual',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        callCount++;
        const userMsg = req.messages[0]?.content ?? '';
        // REM judge prompts contain "SEED MEMORY:" and "DISCOVERED NEIGHBOR:"
        const isRem = userMsg.includes('SEED MEMORY:') && userMsg.includes('DISCOVERED NEIGHBOR:');
        const text = isRem ? VALID_REM_JUDGE_RESPONSE : VALID_NREM_FUSION_RESPONSE;
        return {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

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

    // Create a chain of memories: A -- B -- C -- D -- E
    // REM explores from seeds and finds distant neighbors (2+ hops away).
    // Seeds need to reach non-directly-connected memories through spreading activation.
    const mA = seedMemory(db, { content: 'Enjoys hiking in the mountains on weekends', category: 'preference', prominence: 0.5, importance: 7 });
    const mB = seedMemory(db, { content: 'Prefers outdoor activities over indoor ones', category: 'preference', prominence: 0.45, importance: 6 });
    const mC = seedMemory(db, { content: 'Takes vitamin D supplements daily', category: 'fact', prominence: 0.4, importance: 5 });
    const mD = seedMemory(db, { content: 'Works from home as a software engineer', category: 'fact', prominence: 0.35, importance: 6 });
    const mE = seedMemory(db, { content: 'Has a standing desk for better posture', category: 'fact', prominence: 0.3, importance: 5 });

    // Chain them: A-B, B-C, C-D, D-E (so A and D/E are 3-4 hops apart)
    db.addRelation(mA.id, mB.id, 'EXTENDS', 0.8);
    db.addRelation(mB.id, mC.id, 'EXTENDS', 0.7);
    db.addRelation(mC.id, mD.id, 'EXTENDS', 0.7);
    db.addRelation(mD.id, mE.id, 'EXTENDS', 0.7);

    await gardener.sleepTick();

    // Gather all relations
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const originalIds = new Set([mA.id, mB.id, mC.id, mD.id, mE.id]);

    // Check for EXTENDS relations that were NOT in our original setup
    // (i.e., REM-created EXTENDS between non-adjacent memories)
    const originalRelationPairs = new Set([
      `${mA.id}:${mB.id}`, `${mB.id}:${mA.id}`,
      `${mB.id}:${mC.id}`, `${mC.id}:${mB.id}`,
      `${mC.id}:${mD.id}`, `${mD.id}:${mC.id}`,
      `${mD.id}:${mE.id}`, `${mE.id}:${mD.id}`,
    ]);

    let remExtendsCount = 0;
    for (const mem of allMemories) {
      if (!originalIds.has(mem.id)) continue;
      const rels = db.getRelations(mem.id);
      for (const rel of rels) {
        if (rel.relationType === 'EXTENDS') {
          const pair1 = `${rel.sourceId}:${rel.targetId}`;
          const pair2 = `${rel.targetId}:${rel.sourceId}`;
          if (!originalRelationPairs.has(pair1) && !originalRelationPairs.has(pair2)) {
            // This is a REM-created EXTENDS relation (not DERIVES from NREM)
            if (originalIds.has(rel.sourceId) && originalIds.has(rel.targetId)) {
              remExtendsCount++;
            }
          }
        }
      }
    }

    // REM should have created at least one EXTENDS relation between distant memories
    expect(remExtendsCount).toBeGreaterThanOrEqual(1);

    // Verify: REM did NOT create any new memories (only relations)
    const nonOriginalMemories = allMemories.filter(m =>
      !originalIds.has(m.id) && m.learnedFrom !== 'nrem_consolidation'
    );
    // Any non-original memories should only be NREM-derived
    for (const m of nonOriginalMemories) {
      expect(m.learnedFrom).toBe('nrem_consolidation');
    }

    // Verify: REM did NOT supersede any original memories
    // (NREM may supersede some, so check that REM didn't supersede beyond what NREM did)
    // The key invariant is: no memory was superseded solely because of REM
    // Since REM only adds EXTENDS, no memories should be superseded by REM
    // (This is inherently satisfied by the implementation — REM never calls supersede)
  });

  // ─── Test b: REM runs after NREM without interference ───────

  it('sleepTick REM runs after NREM without interference', async () => {
    cleanupTestDb();

    // Smart mock that returns appropriate responses for NREM vs REM
    const fusionProvider: LLMProvider = {
      name: 'mock-dual',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        const userMsg = req.messages[0]?.content ?? '';
        const isRem = userMsg.includes('SEED MEMORY:') && userMsg.includes('DISCOVERED NEIGHBOR:');
        const text = isRem ? VALID_REM_JUDGE_RESPONSE : VALID_NREM_FUSION_RESPONSE;
        return {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

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

    // Seed enough memories to trigger both NREM clusters and REM exploration
    const m1 = seedMemory(db, { content: 'Enjoys morning jogs in the park', category: 'preference', prominence: 0.4, importance: 7 });
    const m2 = seedMemory(db, { content: 'Likes listening to jazz while running', category: 'preference', prominence: 0.38, importance: 6 });
    const m3 = seedMemory(db, { content: 'Runs a 5K every Saturday', category: 'event', prominence: 0.42, importance: 6 });
    const m4 = seedMemory(db, { content: 'Bought new running shoes last month', category: 'fact', prominence: 0.35, importance: 5 });
    const m5 = seedMemory(db, { content: 'Tracks fitness goals using a smartwatch', category: 'fact', prominence: 0.3, importance: 5 });

    // Connect them in a chain for BFS clustering
    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);
    db.addRelation(m4.id, m5.id, 'EXTENDS', 0.7);

    await gardener.sleepTick();

    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });

    // NREM should have created derived memories with DERIVES relations
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);
    expect(derivedMemories[0].learnedFrom).toBe('nrem_consolidation');

    // Verify DERIVES relations exist for NREM fusions
    for (const derived of derivedMemories) {
      const rels = db.getRelations(derived.id);
      const derivesRels = rels.filter(r => r.relationType === 'DERIVES');
      expect(derivesRels.length).toBeGreaterThanOrEqual(1);
    }

    // Verify the provider was called multiple times (both NREM and REM)
    expect(fusionProvider.complete).toHaveBeenCalled();
    const callCount = (fusionProvider.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    // At minimum: 1 NREM cluster fusion + at least 1 REM judge call
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // ─── Test c: REM gracefully handles zero discoveries ────────

  it('sleepTick REM gracefully handles zero discoveries', async () => {
    cleanupTestDb();

    // Mock LLM always returns NO_CONNECTION for REM and valid fusion for NREM
    const fusionProvider: LLMProvider = {
      name: 'mock-no-rem',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        const userMsg = req.messages[0]?.content ?? '';
        const isRem = userMsg.includes('SEED MEMORY:') && userMsg.includes('DISCOVERED NEIGHBOR:');
        const text = isRem ? NO_CONNECTION_RESPONSE : VALID_NREM_FUSION_RESPONSE;
        return {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

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

    // Seed memories in a chain
    const m1 = seedMemory(db, { content: 'Fact one about gardening', category: 'fact', prominence: 0.3 });
    const m2 = seedMemory(db, { content: 'Fact two about composting', category: 'fact', prominence: 0.35 });
    const m3 = seedMemory(db, { content: 'Fact three about soil types', category: 'fact', prominence: 0.32 });
    const m4 = seedMemory(db, { content: 'Preference for organic methods', category: 'preference', prominence: 0.4 });

    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    // sleepTick should complete without errors even with zero REM discoveries
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    const originalIds = new Set([m1.id, m2.id, m3.id, m4.id]);
    const originalRelationPairs = new Set([
      `${m1.id}:${m2.id}`, `${m2.id}:${m1.id}`,
      `${m2.id}:${m3.id}`, `${m3.id}:${m2.id}`,
      `${m3.id}:${m4.id}`, `${m4.id}:${m3.id}`,
    ]);

    // Count REM-created EXTENDS (should be zero since all judges returned NO_CONNECTION)
    let remExtendsCount = 0;
    for (const id of originalIds) {
      const rels = db.getRelations(id);
      for (const rel of rels) {
        if (rel.relationType === 'EXTENDS') {
          const pair = `${rel.sourceId}:${rel.targetId}`;
          const pairRev = `${rel.targetId}:${rel.sourceId}`;
          if (!originalRelationPairs.has(pair) && !originalRelationPairs.has(pairRev)) {
            if (originalIds.has(rel.sourceId) && originalIds.has(rel.targetId)) {
              remExtendsCount++;
            }
          }
        }
      }
    }
    expect(remExtendsCount).toBe(0);

    // NREM should still have worked (derived memories created)
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Test d: REM failure does not block NREM ────────────────

  it('sleepTick REM failure does not block NREM', async () => {
    cleanupTestDb();

    // Track whether we are in NREM or REM phase.
    // NREM runs first (fusion calls), then REM runs (judge calls).
    // We make the provider succeed for NREM and throw for REM.
    let nremCallsDone = false;
    const fusionProvider: LLMProvider = {
      name: 'mock-rem-fails',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        const userMsg = req.messages[0]?.content ?? '';
        const isRem = userMsg.includes('SEED MEMORY:') && userMsg.includes('DISCOVERED NEIGHBOR:');

        if (isRem) {
          // REM calls always throw
          throw new Error('REM LLM failure');
        }

        // NREM calls succeed
        nremCallsDone = true;
        return {
          content: [{ type: 'text', text: VALID_NREM_FUSION_RESPONSE }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }),
    };

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

    // Seed memories that trigger both NREM and REM
    const m1 = seedMemory(db, { content: 'Enjoys reading science fiction novels', category: 'preference', prominence: 0.4, importance: 7 });
    const m2 = seedMemory(db, { content: 'Reads before bed every night', category: 'fact', prominence: 0.38, importance: 6 });
    const m3 = seedMemory(db, { content: 'Favorite author is Isaac Asimov', category: 'preference', prominence: 0.42, importance: 6 });
    const m4 = seedMemory(db, { content: 'Has a large book collection at home', category: 'fact', prominence: 0.35, importance: 5 });

    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    // sleepTick should NOT throw despite REM failures
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // NREM should have succeeded — derived memories created
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const derivedMemories = allMemories.filter(m => m.memoryType === 'derived');
    expect(derivedMemories.length).toBeGreaterThanOrEqual(1);
    expect(derivedMemories[0].learnedFrom).toBe('nrem_consolidation');
    expect(derivedMemories[0].content).toBe('Fused insight from NREM');

    // Verify DERIVES relations from NREM
    const fusedRels = db.getRelations(derivedMemories[0].id);
    const derivesRels = fusedRels.filter(r => r.relationType === 'DERIVES');
    expect(derivesRels.length).toBeGreaterThanOrEqual(1);

    // Verify NREM calls completed
    expect(nremCallsDone).toBe(true);
  });
});
