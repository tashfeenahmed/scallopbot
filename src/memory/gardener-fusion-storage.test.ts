import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, ScallopMemoryEntry } from './db.js';
import { storeFusedMemory } from './gardener-fusion-storage.js';

const TEST_DB_PATH = '/tmp/gardener-fusion-storage-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch { /* ignore */ }
}

function seedMemory(
  db: ScallopDatabase,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    eventDate?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): ScallopMemoryEntry {
  return db.addMemory({
    userId: opts.userId ?? 'user-1',
    content: opts.content,
    category: opts.category,
    memoryType: 'regular',
    importance: 6,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: opts.eventDate ?? null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: opts.metadata ?? null,
    learnedFrom: null,
  });
}

describe('storeFusedMemory', () => {
  let store: ScallopMemoryStore;
  let db: ScallopDatabase;

  beforeEach(() => {
    cleanupTestDb();
    store = new ScallopMemoryStore({ dbPath: TEST_DB_PATH, logger });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanupTestDb();
  });

  it('creates a derived memory with correct content and metadata', async () => {
    const m1 = seedMemory(db, { content: 'Likes coffee', category: 'preference', prominence: 0.5 });
    const m2 = seedMemory(db, { content: 'Drinks espresso', category: 'preference', prominence: 0.4 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'User enjoys coffee and espresso',
      category: 'preference',
      importance: 7,
      confidence: 0.9,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: 'Likes coffee | Drinks espresso',
      learnedFrom: 'consolidation',
    }, [m1, m2]);

    expect(result.fusedMemory.content).toBe('User enjoys coffee and espresso');
    const metadata = result.fusedMemory.metadata as Record<string, unknown>;
    expect(metadata.sourceCount).toBe(2);
    expect(metadata.sourceIds).toEqual([m1.id, m2.id]);
  });

  it('sets memoryType to derived', async () => {
    const m1 = seedMemory(db, { content: 'A', category: 'fact', prominence: 0.5 });
    const m2 = seedMemory(db, { content: 'B', category: 'fact', prominence: 0.4 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'Fused AB',
      category: 'fact',
      importance: 6,
      confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: 'A | B',
      learnedFrom: 'consolidation',
    }, [m1, m2]);

    // Re-read memory from DB to check memoryType
    const mem = db.getMemory(result.fusedMemory.id);
    expect(mem?.memoryType).toBe('derived');
  });

  it('creates DERIVES relations to all source memory IDs', async () => {
    const m1 = seedMemory(db, { content: 'X', category: 'fact', prominence: 0.5 });
    const m2 = seedMemory(db, { content: 'Y', category: 'fact', prominence: 0.4 });
    const m3 = seedMemory(db, { content: 'Z', category: 'fact', prominence: 0.3 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'Fused XYZ',
      category: 'fact',
      importance: 6,
      confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id, m3.id],
      sourceChunk: 'X | Y | Z',
      learnedFrom: 'consolidation',
    }, [m1, m2, m3]);

    const relations = db.getRelations(result.fusedMemory.id);
    const derivesRelations = relations.filter(r => r.relationType === 'DERIVES');
    expect(derivesRelations.length).toBe(3);
    const targetIds = derivesRelations.map(r => r.targetId).sort();
    expect(targetIds).toEqual([m1.id, m2.id, m3.id].sort());
  });

  it('caps fused prominence at 0.6', async () => {
    const m1 = seedMemory(db, { content: 'High prom', category: 'fact', prominence: 0.65 });
    const m2 = seedMemory(db, { content: 'Also high', category: 'fact', prominence: 0.55 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'Fused high',
      category: 'fact',
      importance: 6,
      confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: 'test',
      learnedFrom: 'consolidation',
    }, [m1, m2]);

    // maxProminence=0.65, +0.1=0.75, capped at 0.6
    expect(result.fusedProminence).toBe(0.6);
  });

  it('handles different learnedFrom values', async () => {
    const m1 = seedMemory(db, { content: 'A', category: 'fact', prominence: 0.5 });
    const m2 = seedMemory(db, { content: 'B', category: 'fact', prominence: 0.4 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'NREM fused',
      category: 'fact',
      importance: 6,
      confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: `${m1.id} | ${m2.id}`,
      learnedFrom: 'nrem_consolidation',
      extraMetadata: { nrem: true },
    }, [m1, m2]);

    const metadata = result.fusedMemory.metadata as Record<string, unknown>;
    expect(metadata.nrem).toBe(true);
  });

  it('includes nrem metadata when provided', async () => {
    const m1 = seedMemory(db, { content: 'C', category: 'fact', prominence: 0.3 });
    const m2 = seedMemory(db, { content: 'D', category: 'fact', prominence: 0.3 });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'NREM result',
      category: 'insight',
      importance: 7,
      confidence: 0.85,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: `${m1.id} | ${m2.id}`,
      learnedFrom: 'nrem_consolidation',
      extraMetadata: { nrem: true },
    }, [m1, m2]);

    const metadata = result.fusedMemory.metadata as Record<string, unknown>;
    expect(metadata.fusedAt).toBeDefined();
    expect(metadata.nrem).toBe(true);
    expect(metadata.sourceCount).toBe(2);
  });

  it('canonicalizes old relative dates from their source event instead of consolidation time', async () => {
    const aprilEvent = Date.parse('2026-04-08T12:00:00Z');
    const m1 = seedMemory(db, {
      content: 'Doing final house cleaning within 3 hours today',
      category: 'event',
      prominence: 0.3,
      eventDate: aprilEvent,
      metadata: { isRelativeDate: true, rawDateText: 'today' },
    });
    const m2 = seedMemory(db, {
      content: 'The house has two washrooms and a kitchen',
      category: 'fact',
      prominence: 0.3,
    });

    const result = await storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'Final house cleaning today includes the kitchen and two washrooms',
      category: 'insight',
      importance: 7,
      confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id],
      sourceChunk: `${m1.id} | ${m2.id}`,
      learnedFrom: 'nrem_consolidation',
      extraMetadata: { nrem: true },
    }, [m1, m2]);

    expect(result.fusedMemory.content).toContain('on 2026-04-08');
    expect(result.fusedMemory.content).not.toMatch(/\btoday\b/i);
    expect(result.fusedMemory.eventDate).toBe(aprilEvent);
    expect(result.fusedMemory.metadata).toMatchObject({
      relativeDateCanonicalized: true,
      temporalSourceDate: '2026-04-08',
    });
  });

  it('rejects a relative fused date when its source date is ambiguous', async () => {
    const m1 = seedMemory(db, {
      content: 'First activity today', category: 'event', prominence: 0.3,
      eventDate: Date.parse('2026-04-08T12:00:00Z'), metadata: { isRelativeDate: true },
    });
    const m2 = seedMemory(db, {
      content: 'Second activity today', category: 'event', prominence: 0.3,
      eventDate: Date.parse('2026-04-09T12:00:00Z'), metadata: { isRelativeDate: true },
    });

    await expect(storeFusedMemory({
      scallopStore: store,
      db,
      userId: 'user-1',
      summary: 'Both activities happen today',
      category: 'insight', importance: 7, confidence: 0.8,
      sourceMemoryIds: [m1.id, m2.id], sourceChunk: 'sources',
      learnedFrom: 'nrem_consolidation',
    }, [m1, m2])).rejects.toThrow('fused_relative_time_has_no_unique_source_date');
  });

  it('repairs an already-persisted relative NREM memory losslessly on reopen', () => {
    const aprilEvent = Date.parse('2026-04-08T12:00:00Z');
    const source = seedMemory(db, {
      content: 'Doing final house cleaning within 3 hours today',
      category: 'event', prominence: 0.3, eventDate: aprilEvent,
      metadata: { isRelativeDate: true, rawDateText: 'today' },
    });
    const corrupted = db.addMemory({
      userId: 'user-1',
      content: 'Final house cleaning today requires finishing the washrooms and kitchen',
      category: 'insight', memoryType: 'derived', importance: 7, confidence: 0.8,
      isLatest: true, source: 'user', documentDate: Date.parse('2026-07-14T01:00:00Z'),
      eventDate: Date.parse('2026-07-14T01:00:00Z'), prominence: 0.6,
      lastAccessed: null, accessCount: 0, sourceChunk: source.id, embedding: null,
      metadata: { nrem: true, sourceIds: [source.id], isRelativeDate: true, rawDateText: 'today' },
      learnedFrom: 'nrem_consolidation',
    });

    store.close();
    store = new ScallopMemoryStore({ dbPath: TEST_DB_PATH, logger });
    db = store.getDatabase();

    expect(db.getMemory(corrupted.id)).toMatchObject({
      content: 'Final house cleaning on 2026-04-08 requires finishing the washrooms and kitchen',
      eventDate: aprilEvent,
      isLatest: true,
      metadata: expect.objectContaining({
        relativeDateCanonicalized: true,
        temporalSourceDate: '2026-04-08',
      }),
    });
    expect(db.raw<{ outcome: string; memory_snapshot: string }>(
      'SELECT outcome, memory_snapshot FROM nrem_temporal_repair_audit WHERE memory_id = ?',
      [corrupted.id],
    )[0]).toMatchObject({
      outcome: 'canonicalized',
      memory_snapshot: expect.stringContaining('Final house cleaning today'),
    });
  });
});
