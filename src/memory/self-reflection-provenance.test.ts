import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScallopDatabase } from './db.js';

const dbPath = join(tmpdir(), `self-reflection-provenance-${process.pid}.db`);

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
});

describe('self-reflection memory provenance migration', () => {
  it('reclassifies historical assistant coaching away from user-sourced memory', () => {
    const first = new ScallopDatabase(dbPath);
    first.addMemory({
      userId: 'default', content: 'Ask the user binary confirmation questions',
      category: 'insight', memoryType: 'regular', importance: 7, confidence: 0.8,
      isLatest: true, source: 'user', documentDate: Date.now(), eventDate: null,
      prominence: 0.8, lastAccessed: null, accessCount: 0, sourceChunk: null,
      embedding: null, metadata: null, learnedFrom: 'self_reflection',
    });
    first.close();

    const reopened = new ScallopDatabase(dbPath);
    const [reflection] = reopened.getMemoriesByUser('default', { includeAllSources: true });
    expect(reflection).toMatchObject({ source: 'assistant', memoryType: 'derived' });
    expect(reopened.getMemoriesByUser('default')).toEqual([]);
    reopened.close();
  });
});
