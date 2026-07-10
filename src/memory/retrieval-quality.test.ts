import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import { calculateBM25Score, buildDocFreqMap } from './bm25.js';

const DB_PATH = '/tmp/scallop-retrieval-quality.db';
const logger = pino({ level: 'silent' });

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      // File does not exist.
    }
  }
}

/** Reproduce the legacy lexical gate: semantic scoring could only see BM25 top-50. */
function legacyCandidateIds(query: string, memories: Array<{ id: string; content: string }>): string[] {
  const texts = memories.map((memory) => memory.content);
  const avgDocLength = texts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) / texts.length;
  const options = {
    avgDocLength,
    docCount: texts.length,
    docFreq: buildDocFreqMap(texts),
  };
  return memories
    .map((memory) => ({
      id: memory.id,
      score: calculateBM25Score(query, memory.content, options),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(({ id }) => id);
}

describe('hybrid retrieval quality metrics', () => {
  let store: ScallopMemoryStore;

  beforeEach(() => {
    cleanup();
    store = new ScallopMemoryStore({ dbPath: DB_PATH, logger });
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('improves semantic-only target candidate recall from 0 to 1', async () => {
    // More than 50 strong lexical decoys force the paraphrase outside the old
    // BM25 gate. Their vectors are intentionally orthogonal to the query.
    // Keep the corpus above SEMANTIC_CANDIDATE_LIMIT so this exercises the
    // indexed branch, not the exact small-corpus fallback.
    for (let i = 0; i < 410; i++) {
      const memory = await store.add({
        userId: 'default',
        content: `keyword inventory decoy number ${i}`,
        detectRelations: false,
      });
      store.update(memory.id, { embedding: [0, 1] });
    }

    const target = await store.add({
      userId: 'default',
      content: 'The canine companion sleeps beside the fireplace',
      detectRelations: false,
    });
    store.update(target.id, { embedding: [1, 0] });

    const corpus = store.getByUser('default', { minProminence: 0 });
    const legacyRecallAt50 = legacyCandidateIds('keyword', corpus).includes(target.id) ? 1 : 0;
    const improved = await store.search('keyword', {
      userId: 'default',
      limit: 5,
      minProminence: 0,
      queryEmbedding: [1, 0],
    });
    const unionRecallAt5 = improved.some(({ memory }) => memory.id === target.id) ? 1 : 0;

    expect({ legacyRecallAt50, unionRecallAt5 }).toEqual({
      legacyRecallAt50: 0,
      unionRecallAt5: 1,
    });
    expect(improved[0].memory.id).toBe(target.id);
    expect(improved[0].matchType).toBe('semantic');
  });

  it('uses MMR over an over-fetched pool to increase result diversity', async () => {
    const duplicateTexts = [
      'project atlas deadline monday status update',
      'project atlas deadline monday status update pending',
      'project atlas deadline monday status update reminder',
      'project atlas deadline monday status update followup',
    ];
    for (const content of duplicateTexts) {
      await store.add({ userId: 'default', content, detectRelations: false });
    }
    await store.add({
      userId: 'default',
      content: 'project atlas budget approval from finance covers travel hardware contractors and contingency planning',
      detectRelations: false,
    });

    const legacy = await store.search('project atlas', { userId: 'default', limit: 3 });
    const legacyTopics = new Set(legacy.map(({ memory }) =>
      memory.content.includes('budget') ? 'budget' : 'deadline'));

    store.close();
    store = new ScallopMemoryStore({
      dbPath: DB_PATH,
      logger,
      mmrEnabled: true,
      mmrLambda: 0.3,
    });
    const improved = await store.search('project atlas', { userId: 'default', limit: 3 });
    const improvedTopics = new Set(improved.map(({ memory }) =>
      memory.content.includes('budget') ? 'budget' : 'deadline'));

    expect(legacyTopics.size).toBe(1);
    expect(improvedTopics.size).toBe(2);
    expect(improvedTopics.size).toBeGreaterThan(legacyTopics.size);
  });
});
