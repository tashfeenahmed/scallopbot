/**
 * Tests for utility score computation (Phase 29 enhanced forgetting).
 *
 * Formula: utilityScore = prominence × log(1 + accessCount)
 * Combines memory freshness (prominence) with retrieval frequency (accessCount)
 * to produce a single metric for deletion decisions.
 *
 * Uses real in-memory ScallopDatabase instances.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ScallopDatabase } from './db.js';
import {
  computeUtilityScore,
  findLowUtilityMemories,
  type LowUtilityMemory,
} from './utility-score.js';

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;

// ============ Helpers ============

let db: ScallopDatabase;

function createTestDb(): ScallopDatabase {
  db = new ScallopDatabase(':memory:');
  return db;
}

interface SeedOptions {
  content?: string;
  prominence?: number;
  isLatest?: boolean;
  accessCount?: number;
  lastAccessed?: number | null;
  documentDate?: number;
  memoryType?: 'static_profile' | 'dynamic_profile' | 'regular' | 'derived' | 'superseded';
  category?: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
}

function seedMemory(database: ScallopDatabase, opts: SeedOptions = {}): string {
  const entry = database.addMemory({
    userId: 'default',
    content: opts.content ?? 'test memory',
    category: opts.category ?? 'fact',
    memoryType: opts.memoryType ?? 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: opts.isLatest ?? true,
    documentDate: opts.documentDate ?? Date.now(),
    eventDate: null,
    prominence: opts.prominence ?? 1.0,
    lastAccessed: opts.lastAccessed ?? null,
    accessCount: opts.accessCount ?? 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
  });
  return entry.id;
}

afterEach(() => {
  if (db) db.close();
});

// ============ computeUtilityScore Tests ============

describe('computeUtilityScore', () => {
  it('returns 0 when accessCount is 0 (never accessed = zero utility)', () => {
    // prominence=0.5, accessCount=0 → 0.5 × log(1) = 0.0
    expect(computeUtilityScore(0.5, 0)).toBeCloseTo(0.0, 5);
  });

  it('returns 0 when prominence is 0 (zero prominence = zero utility)', () => {
    // prominence=0.0, accessCount=100 → 0.0
    expect(computeUtilityScore(0.0, 100)).toBeCloseTo(0.0, 5);
  });

  it('computes correctly for prominence=0.5, accessCount=1', () => {
    // 0.5 × log(2) ≈ 0.347
    expect(computeUtilityScore(0.5, 1)).toBeCloseTo(0.5 * Math.log(2), 5);
  });

  it('computes correctly for prominence=0.8, accessCount=5', () => {
    // 0.8 × log(6) ≈ 1.433
    expect(computeUtilityScore(0.8, 5)).toBeCloseTo(0.8 * Math.log(6), 5);
  });

  it('computes correctly for prominence=0.3, accessCount=3', () => {
    // 0.3 × log(4) ≈ 0.416
    expect(computeUtilityScore(0.3, 3)).toBeCloseTo(0.3 * Math.log(4), 5);
  });

  it('computes correctly for prominence=1.0, accessCount=0 (never accessed)', () => {
    // 1.0 × log(1) = 0.0
    expect(computeUtilityScore(1.0, 0)).toBeCloseTo(0.0, 5);
  });
});

// ============ findLowUtilityMemories Tests ============

describe('findLowUtilityMemories', () => {
  it('returns empty array for empty DB', () => {
    const database = createTestDb();

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });

  it('returns empty array when all memories are above threshold', () => {
    const database = createTestDb();
    const now = Date.now();

    // High prominence + high access → high utility, should not appear
    seedMemory(database, {
      content: 'frequently accessed memory',
      prominence: 0.8,
      accessCount: 10,
      lastAccessed: now - 1 * DAY_MS,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });

  it('does NOT include memories younger than minAgeDays (default 14)', () => {
    const database = createTestDb();
    const now = Date.now();

    // Created 5 days ago, zero access → low utility BUT too young
    seedMemory(database, {
      content: 'new memory with zero access',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 5 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });

  it('includes old memory with zero access count (utility = 0)', () => {
    const database = createTestDb();
    const now = Date.now();

    const id = seedMemory(database, {
      content: 'old unaccessed memory that should be forgotten',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe(id);
    expect(result[0].utilityScore).toBeCloseTo(0.0, 5);
    expect(result[0].prominence).toBe(0.3);
    expect(result[0].accessCount).toBe(0);
  });

  it('excludes static_profile memories always', () => {
    const database = createTestDb();
    const now = Date.now();

    // static_profile with zero access → should still be excluded
    seedMemory(database, {
      content: 'user name is Bob',
      prominence: 0.3,
      accessCount: 0,
      memoryType: 'static_profile',
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });

  it('excludes is_latest=0 memories (superseded)', () => {
    const database = createTestDb();
    const now = Date.now();

    seedMemory(database, {
      content: 'superseded memory',
      prominence: 0.3,
      accessCount: 0,
      isLatest: false,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });

  it('sorts results by utility ascending (lowest first)', () => {
    const database = createTestDb();
    const now = Date.now();

    // Memory A: prominence=0.2, accessCount=1 → utility = 0.2 × log(2) ≈ 0.139
    seedMemory(database, {
      content: 'memory A slightly accessed',
      prominence: 0.2,
      accessCount: 1,
      documentDate: now - 30 * DAY_MS,
    });

    // Memory B: prominence=0.1, accessCount=0 → utility = 0.0
    seedMemory(database, {
      content: 'memory B never accessed',
      prominence: 0.1,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database, { utilityThreshold: 0.2 });

    expect(result.length).toBe(2);
    // B (0.0) should come before A (0.139)
    expect(result[0].utilityScore).toBeLessThan(result[1].utilityScore);
    expect(result[0].accessCount).toBe(0);
    expect(result[1].accessCount).toBe(1);
  });

  it('respects maxResults option', () => {
    const database = createTestDb();
    const now = Date.now();

    // Seed 5 memories with zero access
    for (let i = 0; i < 5; i++) {
      seedMemory(database, {
        content: `forgettable memory ${i}`,
        prominence: 0.05,
        accessCount: 0,
        documentDate: now - 30 * DAY_MS,
      });
    }

    const result = findLowUtilityMemories(database, { maxResults: 2 });

    expect(result.length).toBe(2);
  });

  it('respects custom utilityThreshold', () => {
    const database = createTestDb();
    const now = Date.now();

    // prominence=0.3, accessCount=1 → utility = 0.3 × log(2) ≈ 0.208
    seedMemory(database, {
      content: 'moderately useful memory',
      prominence: 0.3,
      accessCount: 1,
      documentDate: now - 30 * DAY_MS,
    });

    // With default threshold (0.1) this would NOT appear
    const lowResult = findLowUtilityMemories(database, { utilityThreshold: 0.1 });
    expect(lowResult.length).toBe(0);

    // With threshold 0.3 it SHOULD appear
    const highResult = findLowUtilityMemories(database, { utilityThreshold: 0.3 });
    expect(highResult.length).toBe(1);
  });

  it('respects custom minAgeDays', () => {
    const database = createTestDb();
    const now = Date.now();

    // Created 5 days ago, zero access
    seedMemory(database, {
      content: 'five day old memory',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 5 * DAY_MS,
    });

    // Default minAgeDays=14 → not included
    expect(findLowUtilityMemories(database).length).toBe(0);

    // Custom minAgeDays=3 → included
    expect(findLowUtilityMemories(database, { minAgeDays: 3 }).length).toBe(1);
  });

  it('truncates content to 80 chars in results', () => {
    const database = createTestDb();
    const now = Date.now();

    const longContent = 'A'.repeat(120);
    seedMemory(database, {
      content: longContent,
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  it('returns correct ageDays for each memory', () => {
    const database = createTestDb();
    const now = Date.now();

    seedMemory(database, {
      content: 'month old memory',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result.length).toBe(1);
    expect(result[0].ageDays).toBeGreaterThanOrEqual(29);
    expect(result[0].ageDays).toBeLessThanOrEqual(31);
  });

  it('respects excludeTypes option', () => {
    const database = createTestDb();
    const now = Date.now();

    seedMemory(database, {
      content: 'derived insight',
      prominence: 0.05,
      accessCount: 0,
      memoryType: 'derived',
      documentDate: now - 30 * DAY_MS,
    });

    seedMemory(database, {
      content: 'regular memory',
      prominence: 0.05,
      accessCount: 0,
      memoryType: 'regular',
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database, { excludeTypes: ['derived'] });

    expect(result.length).toBe(1);
    expect(result[0].category).toBeDefined();
  });

  it('excludes zero-prominence memories (already archived)', () => {
    const database = createTestDb();
    const now = Date.now();

    seedMemory(database, {
      content: 'already archived memory',
      prominence: 0.0,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    const result = findLowUtilityMemories(database);

    expect(result).toEqual([]);
  });
});
