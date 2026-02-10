/**
 * Tests for health ping diagnostic function.
 *
 * Covers normal DB, empty DB, and numeric validity.
 * Uses real in-memory ScallopDatabase instances.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ScallopDatabase } from './db.js';
import { performHealthPing, type HealthPingResult } from './health-ping.js';

// ============ Helpers ============

let db: ScallopDatabase;

function createTestDb(): ScallopDatabase {
  db = new ScallopDatabase(':memory:');
  return db;
}

function seedMemory(database: ScallopDatabase, content: string = 'test memory'): void {
  database.addMemory({
    userId: 'default',
    content,
    category: 'fact',
    memoryType: 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: true,
    documentDate: Date.now(),
    eventDate: null,
    prominence: 1.0,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
  });
}

afterEach(() => {
  if (db) db.close();
});

// ============ Tests ============

describe('performHealthPing', () => {
  it('returns all metrics with positive values for a normal DB', () => {
    const database = createTestDb();
    seedMemory(database, 'User likes TypeScript');
    seedMemory(database, 'User lives in NYC');
    seedMemory(database, 'User works at Acme');

    const result: HealthPingResult = performHealthPing(database);

    expect(result.memoryCount).toBe(3);
    expect(result.walSizeBytes).toBeGreaterThanOrEqual(0);
    expect(result.processMemoryMB).toBeGreaterThan(0);
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('returns memoryCount=0 and walSizeBytes>=0 for empty DB', () => {
    const database = createTestDb();

    const result: HealthPingResult = performHealthPing(database);

    expect(result.memoryCount).toBe(0);
    expect(result.walSizeBytes).toBeGreaterThanOrEqual(0);
    expect(result.processMemoryMB).toBeGreaterThan(0);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('returns all numeric values with no NaN', () => {
    const database = createTestDb();
    seedMemory(database);

    const result: HealthPingResult = performHealthPing(database);

    expect(Number.isNaN(result.walSizeBytes)).toBe(false);
    expect(Number.isNaN(result.memoryCount)).toBe(false);
    expect(Number.isNaN(result.processMemoryMB)).toBe(false);
    expect(Number.isNaN(result.timestamp)).toBe(false);

    expect(typeof result.walSizeBytes).toBe('number');
    expect(typeof result.memoryCount).toBe('number');
    expect(typeof result.processMemoryMB).toBe('number');
    expect(typeof result.timestamp).toBe('number');
  });
});
