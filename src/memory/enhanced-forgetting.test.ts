/**
 * Integration tests for enhanced forgetting pipeline (Phase 29 Plan 02).
 *
 * Tests archiveLowUtilityMemories and pruneOrphanedRelations with real
 * in-memory ScallopDatabase instances (no mocks for DB layer).
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ScallopDatabase } from './db.js';
import {
  archiveLowUtilityMemories,
  pruneOrphanedRelations,
} from './utility-score.js';
import { auditRetrievalHistory } from './retrieval-audit.js';

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;

// ============ Helpers ============

let db: ScallopDatabase;
let tmpPath: string | null = null;

function createTestDb(): ScallopDatabase {
  db = new ScallopDatabase(':memory:');
  return db;
}

/**
 * Create a file-backed test DB so we can open a secondary connection
 * with FK enforcement disabled (needed for orphan relation tests).
 */
function createFileTestDb(): ScallopDatabase {
  tmpPath = path.join(os.tmpdir(), `smartbot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new ScallopDatabase(tmpPath);
  return db;
}

/**
 * Open a secondary raw connection with foreign_keys=OFF.
 * Used to create orphaned relations that can't be created through
 * the normal API because FK cascade prevents them.
 */
function openRawConnection(dbPath: string): Database.Database {
  const rawDb = new Database(dbPath);
  rawDb.pragma('foreign_keys = OFF');
  return rawDb;
}

function cleanupTmpFile(): void {
  if (!tmpPath) return;
  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
  tmpPath = null;
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
  cleanupTmpFile();
});

// ============ archiveLowUtilityMemories Tests ============

describe('archiveLowUtilityMemories', () => {
  it('archives old never-accessed memories', () => {
    const database = createTestDb();
    const now = Date.now();

    // 30 days old, 0 access → low utility, should be archived
    const oldUnaccessed = seedMemory(database, {
      content: 'old unaccessed memory',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    // 30 days old, 5 accesses → higher utility, should NOT be archived
    const oldAccessed = seedMemory(database, {
      content: 'old but frequently accessed',
      prominence: 0.3,
      accessCount: 5,
      lastAccessed: now - 1 * DAY_MS,
      documentDate: now - 30 * DAY_MS,
    });

    // 2 days old, 0 access → too young (minAgeDays=14), should NOT be archived
    const youngUnaccessed = seedMemory(database, {
      content: 'young unaccessed memory',
      prominence: 0.3,
      accessCount: 0,
      documentDate: now - 2 * DAY_MS,
    });

    const result = archiveLowUtilityMemories(database);

    expect(result.archived).toBe(1);
    expect(result.ids).toContain(oldUnaccessed);
    expect(result.ids).not.toContain(oldAccessed);
    expect(result.ids).not.toContain(youngUnaccessed);

    // Verify the archived memory has is_latest=0 and memory_type='superseded'
    const archivedMemory = database.getMemory(oldUnaccessed);
    expect(archivedMemory).not.toBeNull();
    expect(archivedMemory!.isLatest).toBe(false);
    expect(archivedMemory!.memoryType).toBe('superseded');

    // Verify the others are untouched
    const accessedMemory = database.getMemory(oldAccessed);
    expect(accessedMemory!.isLatest).toBe(true);
    expect(accessedMemory!.memoryType).toBe('regular');

    const youngMemory = database.getMemory(youngUnaccessed);
    expect(youngMemory!.isLatest).toBe(true);
    expect(youngMemory!.memoryType).toBe('regular');
  });

  it('respects maxPerRun', () => {
    const database = createTestDb();
    const now = Date.now();

    // Create 10 old zero-access memories
    for (let i = 0; i < 10; i++) {
      seedMemory(database, {
        content: `forgettable memory ${i}`,
        prominence: 0.3,
        accessCount: 0,
        documentDate: now - 30 * DAY_MS,
      });
    }

    const result = archiveLowUtilityMemories(database, { maxPerRun: 3 });

    expect(result.archived).toBe(3);
    expect(result.ids.length).toBe(3);
  });

  it('never archives static_profile memories', () => {
    const database = createTestDb();
    const now = Date.now();

    // static_profile that's old with 0 access
    const staticId = seedMemory(database, {
      content: 'user name is Bob',
      prominence: 0.3,
      accessCount: 0,
      memoryType: 'static_profile',
      documentDate: now - 60 * DAY_MS,
    });

    const result = archiveLowUtilityMemories(database);

    expect(result.archived).toBe(0);
    expect(result.ids).not.toContain(staticId);

    // Verify static_profile is still active
    const mem = database.getMemory(staticId);
    expect(mem!.isLatest).toBe(true);
    expect(mem!.memoryType).toBe('static_profile');
  });
});

// ============ pruneOrphanedRelations Tests ============

describe('pruneOrphanedRelations', () => {
  it('cleans up dangling edges', () => {
    // Use file-backed DB so we can open a secondary connection with FK OFF
    const database = createFileTestDb();

    const id1 = seedMemory(database, { content: 'memory one' });
    const id2 = seedMemory(database, { content: 'memory two' });

    // Add a valid relation between the two memories
    database.addRelation(id1, id2, 'EXTENDS', 0.9);

    // Verify relation exists
    expect(database.getAllRelations().length).toBe(1);

    // Delete one memory via a secondary connection with FK enforcement OFF.
    // This simulates environments where PRAGMA foreign_keys is not enabled,
    // leaving orphaned relation edges behind.
    const rawDb = openRawConnection(tmpPath!);
    rawDb.prepare('DELETE FROM memories WHERE id = ?').run(id2);
    rawDb.close();

    // Verify the orphaned relation still exists (FK cascade did not fire)
    expect(database.getAllRelations().length).toBe(1);

    // Run orphan pruning
    const deleted = pruneOrphanedRelations(database);

    expect(deleted).toBe(1);

    // Verify relation is gone
    expect(database.getAllRelations().length).toBe(0);
  });

  it('returns 0 when no orphans exist', () => {
    const database = createTestDb();

    // Create 2 memories with a relation — both exist
    const id1 = seedMemory(database, { content: 'memory one' });
    const id2 = seedMemory(database, { content: 'memory two' });
    database.addRelation(id1, id2, 'EXTENDS', 0.9);

    const deleted = pruneOrphanedRelations(database);

    expect(deleted).toBe(0);

    // Relation still exists
    const relations = database.getAllRelations();
    expect(relations.length).toBe(1);
  });
});

// ============ Full Pipeline Smoke Test ============

describe('Enhanced forgetting pipeline (smoke test)', () => {
  it('runs audit → archive → prune → orphan cleanup correctly', () => {
    // Use file-backed DB to support orphan creation via secondary connection
    const database = createFileTestDb();
    const now = Date.now();

    // Create a mix of memories:

    // 1. Old unused memory (should be archived by utility)
    const oldUnused = seedMemory(database, {
      content: 'old unused fact',
      prominence: 0.6,
      accessCount: 0,
      documentDate: now - 30 * DAY_MS,
    });

    // 2. Healthy active memory (should survive everything)
    const healthy = seedMemory(database, {
      content: 'frequently used fact',
      prominence: 0.8,
      accessCount: 10,
      lastAccessed: now - 1 * DAY_MS,
      documentDate: now - 30 * DAY_MS,
    });

    // 3. Already archived memory with very low prominence (should be hard-pruned)
    const deadMemory = seedMemory(database, {
      content: 'dead memory',
      prominence: 0.005,
      accessCount: 0,
      isLatest: false,
      memoryType: 'superseded',
      documentDate: now - 60 * DAY_MS,
    });

    // 4. Create an orphaned relation by deleting a memory with FK OFF
    const tempMemory = seedMemory(database, { content: 'temp' });
    database.addRelation(healthy, tempMemory, 'EXTENDS', 0.8);
    // Delete via secondary connection with FK OFF to leave orphaned relation
    const rawDb = openRawConnection(tmpPath!);
    rawDb.prepare('DELETE FROM memories WHERE id = ?').run(tempMemory);
    rawDb.close();

    // Add a normal relation between healthy and oldUnused
    database.addRelation(healthy, oldUnused, 'EXTENDS', 0.7);

    // --- Run pipeline ---

    // 3a. Retrieval audit
    const auditResult = auditRetrievalHistory(database);
    // oldUnused has prominence 0.6 >= 0.5 and 0 access → neverRetrieved
    expect(auditResult.neverRetrieved).toBeGreaterThanOrEqual(1);

    // 3b. Utility-based archival
    const archiveResult = archiveLowUtilityMemories(database, {
      utilityThreshold: 0.1,
      minAgeDays: 14,
      maxPerRun: 50,
    });
    expect(archiveResult.archived).toBeGreaterThanOrEqual(1);
    expect(archiveResult.ids).toContain(oldUnused);

    // 3c. Hard prune
    const memoriesDeleted = database.pruneArchivedMemories(0.01);
    // deadMemory had prominence 0.005 < 0.01 and is_latest=0
    expect(memoriesDeleted).toBeGreaterThanOrEqual(1);

    // 3d. Orphan pruning
    const orphansDeleted = pruneOrphanedRelations(database);
    // The relation to tempMemory (deleted via FK OFF) should be cleaned up
    expect(orphansDeleted).toBeGreaterThanOrEqual(1);

    // --- Verify final state ---

    // Healthy memory should be untouched
    const healthyMem = database.getMemory(healthy);
    expect(healthyMem).not.toBeNull();
    expect(healthyMem!.isLatest).toBe(true);
    expect(healthyMem!.memoryType).toBe('regular');

    // Dead memory should be gone (hard-pruned)
    const deadMem = database.getMemory(deadMemory);
    expect(deadMem).toBeNull();

    // Old unused should be archived (not deleted)
    const archivedMem = database.getMemory(oldUnused);
    expect(archivedMem).not.toBeNull();
    expect(archivedMem!.isLatest).toBe(false);
    expect(archivedMem!.memoryType).toBe('superseded');
  });
});
