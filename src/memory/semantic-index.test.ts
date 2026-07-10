import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { ScallopDatabase } from './db.js';
import {
  computeSemanticLshBuckets,
  SEMANTIC_CANDIDATE_LIMIT,
  SEMANTIC_LSH_TABLES,
} from './semantic-index.js';

const DB_PATH = '/tmp/scallop-semantic-index.db';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      // File does not exist.
    }
  }
}

function vector(seed: number, dimension = 64): number[] {
  let state = seed >>> 0;
  return Array.from({ length: dimension }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff * 2 - 1;
  });
}

function add(db: ScallopDatabase, userId: string, embedding: number[]): string {
  return db.addMemory({
    userId,
    content: `memory ${userId} ${embedding[0]}`,
    category: 'fact',
    memoryType: 'regular',
    importance: 5,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: null,
    prominence: 1,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding,
    metadata: null,
    learnedFrom: 'conversation',
    timesConfirmed: 1,
    contradictionIds: null,
  }).id;
}

describe('bounded semantic LSH index', () => {
  let db: ScallopDatabase;

  beforeEach(() => {
    cleanup();
    db = new ScallopDatabase(DB_PATH);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('creates stable signatures and ranks an exact neighbour inside a hard candidate bound', () => {
    const query = vector(99);
    expect(computeSemanticLshBuckets(query)).toEqual(computeSemanticLshBuckets(query));
    expect(computeSemanticLshBuckets(query)).toHaveLength(SEMANTIC_LSH_TABLES);

    for (let i = 0; i < 600; i++) add(db, 'default', vector(i + 1));
    const targetId = add(db, 'default', query);

    const ids = db.getSemanticCandidateIds(query, {
      userId: 'default',
      minProminence: 0,
      isLatest: true,
      maxCandidates: 40,
    });

    expect(ids).toHaveLength(40);
    expect(ids[0]).toBe(targetId);
    expect(ids).toContain(targetId);
    expect(ids.length).toBeLessThanOrEqual(SEMANTIC_CANDIDATE_LIMIT);
    expect(db.getSemanticCandidateIds(query, {
      userId: 'default', maxCandidates: 100_000,
    }).length).toBeLessThanOrEqual(SEMANTIC_CANDIDATE_LIMIT);
  });

  it('keeps at least 95% of noisy semantic neighbours in the bounded pool', () => {
    const corpusIds: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      corpusIds.push(add(db, 'default', vector(i + 1, 128)));
    }

    let hits = 0;
    const queries = 50;
    for (let i = 0; i < queries; i++) {
      const targetIndex = 10 + i * 19;
      const target = vector(targetIndex + 1, 128);
      const noise = vector(10_000 + i, 128);
      const query = target.map((value, dimension) =>
        value * 0.85 + noise[dimension] * Math.sqrt(1 - 0.85 ** 2));
      const ids = db.getSemanticCandidateIds(query, {
        userId: 'default',
        maxCandidates: 80,
      });
      if (ids.includes(corpusIds[targetIndex])) hits++;
      expect(ids.length).toBeLessThanOrEqual(80);
    }

    expect(hits / queries).toBeGreaterThanOrEqual(0.95);
  });

  it('re-indexes updates and filters dimensions and users in SQLite', () => {
    const original = vector(1, 32);
    const replacement = vector(2, 32);
    const id = add(db, 'alice', original);
    add(db, 'bob', replacement);

    expect(db.getSemanticCandidateIds(original, {
      userId: 'alice', maxCandidates: 20,
    })).toContain(id);

    db.updateMemory(id, { embedding: replacement });
    const aliceMatches = db.getSemanticCandidateIds(replacement, {
      userId: 'alice', maxCandidates: 20,
    });
    expect(aliceMatches).toContain(id);
    expect(db.getSemanticCandidateIds(replacement, {
      userId: 'bob', maxCandidates: 20,
    })).not.toContain(id);
    expect(db.getSemanticCandidateIds(vector(2, 16), {
      userId: 'alice', maxCandidates: 20,
    })).not.toContain(id);
  });

  it('backfills embeddings from databases created before the LSH rows existed', () => {
    const query = vector(44);
    const id = add(db, 'default', query);
    const malformedId = add(db, 'default', vector(45));
    db.close();

    const legacy = new Database(DB_PATH);
    legacy.prepare('DELETE FROM memory_embedding_lsh').run();
    legacy.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run('{broken-json', malformedId);
    legacy.close();

    db = new ScallopDatabase(DB_PATH);
    const ids = db.getSemanticCandidateIds(query, {
      userId: 'default', maxCandidates: 20,
    });
    expect(ids).toContain(id);
    const embeddings = db.getEmbeddingsByIds([id, malformedId]);
    expect(embeddings.has(id)).toBe(true);
    expect(embeddings.has(malformedId)).toBe(false);
  });
});
