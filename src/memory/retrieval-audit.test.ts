/**
 * Tests for retrieval audit diagnostic function.
 *
 * Covers empty DB, recently accessed, too-young memories, old never-accessed,
 * stale-accessed, and low-prominence exclusion.
 * Uses real in-memory ScallopDatabase instances.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ScallopDatabase } from './db.js';
import {
  auditRetrievalHistory,
  type RetrievalAuditResult,
} from './retrieval-audit.js';

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
}

function seedMemory(database: ScallopDatabase, opts: SeedOptions = {}): string {
  const entry = database.addMemory({
    userId: 'default',
    content: opts.content ?? 'test memory',
    category: 'fact',
    memoryType: 'regular',
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

// ============ Tests ============

describe('auditRetrievalHistory', () => {
  it('returns all zeros and empty array for empty DB', () => {
    const database = createTestDb();

    const result: RetrievalAuditResult = auditRetrievalHistory(database);

    expect(result.neverRetrieved).toBe(0);
    expect(result.staleRetrieved).toBe(0);
    expect(result.totalAudited).toBe(0);
    expect(result.candidatesForDecay).toEqual([]);
  });

  it('returns neverRetrieved=0, staleRetrieved=0 when all memories recently accessed', () => {
    const database = createTestDb();
    const now = Date.now();

    // Old memories (created 10 days ago) but accessed recently
    seedMemory(database, {
      content: 'active memory 1',
      prominence: 0.8,
      accessCount: 5,
      lastAccessed: now - 1 * DAY_MS,  // accessed 1 day ago
      documentDate: now - 10 * DAY_MS,
    });
    seedMemory(database, {
      content: 'active memory 2',
      prominence: 0.6,
      accessCount: 3,
      lastAccessed: now - 2 * DAY_MS,  // accessed 2 days ago
      documentDate: now - 10 * DAY_MS,
    });

    const result = auditRetrievalHistory(database);

    expect(result.neverRetrieved).toBe(0);
    expect(result.staleRetrieved).toBe(0);
    expect(result.totalAudited).toBe(2);
    expect(result.candidatesForDecay).toEqual([]);
  });

  it('does NOT flag a memory created 1 day ago that was never accessed (too young)', () => {
    const database = createTestDb();
    const now = Date.now();

    // Created 1 day ago, never accessed — should NOT be flagged (minAgeDays=7)
    seedMemory(database, {
      content: 'very new memory',
      prominence: 0.9,
      accessCount: 0,
      lastAccessed: null,
      documentDate: now - 1 * DAY_MS,
    });

    const result = auditRetrievalHistory(database);

    // Too young to audit — should not appear in totalAudited or candidatesForDecay
    expect(result.totalAudited).toBe(0);
    expect(result.neverRetrieved).toBe(0);
    expect(result.candidatesForDecay).toEqual([]);
  });

  it('flags a memory created 10 days ago that was never accessed as neverRetrieved', () => {
    const database = createTestDb();
    const now = Date.now();

    // Created 10 days ago, never accessed → should be flagged
    const id = seedMemory(database, {
      content: 'old unaccessed memory',
      prominence: 0.7,
      accessCount: 0,
      lastAccessed: null,
      documentDate: now - 10 * DAY_MS,
    });

    const result = auditRetrievalHistory(database);

    expect(result.neverRetrieved).toBe(1);
    expect(result.totalAudited).toBe(1);
    expect(result.candidatesForDecay).toContain(id);
  });

  it('flags a memory accessed 45 days ago with prominence 0.6 as staleRetrieved', () => {
    const database = createTestDb();
    const now = Date.now();

    // Created 60 days ago, last accessed 45 days ago → stale
    const id = seedMemory(database, {
      content: 'stale memory',
      prominence: 0.6,
      accessCount: 2,
      lastAccessed: now - 45 * DAY_MS,
      documentDate: now - 60 * DAY_MS,
    });

    const result = auditRetrievalHistory(database);

    expect(result.staleRetrieved).toBe(1);
    expect(result.totalAudited).toBe(1);
    expect(result.candidatesForDecay).toContain(id);
  });

  it('does NOT audit a memory with prominence 0.3 (below 0.5 threshold)', () => {
    const database = createTestDb();
    const now = Date.now();

    // Low prominence — should be excluded entirely
    seedMemory(database, {
      content: 'low prominence memory',
      prominence: 0.3,
      accessCount: 0,
      lastAccessed: null,
      documentDate: now - 10 * DAY_MS,
    });

    const result = auditRetrievalHistory(database);

    expect(result.totalAudited).toBe(0);
    expect(result.neverRetrieved).toBe(0);
    expect(result.staleRetrieved).toBe(0);
    expect(result.candidatesForDecay).toEqual([]);
  });
});
