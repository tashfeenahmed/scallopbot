import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('user memory search provenance', () => {
  it('excludes assistant self-coaching unless explicitly requested', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-provenance-search-'));
    const store = new ScallopMemoryStore({
      dbPath: join(dir, 'memory.db'),
      logger: pino({ level: 'silent' }),
    });
    await store.add({
      userId: 'u1', content: 'User prefers short workout summaries',
      category: 'preference', source: 'user', detectRelations: false,
    });
    await store.add({
      userId: 'u1', content: 'Assistant should ask better workout questions',
      category: 'insight', source: 'assistant', learnedFrom: 'self_reflection', detectRelations: false,
    });

    const normal = await store.search('workout summaries and questions', { userId: 'u1' });
    expect(normal.map(result => result.memory.source)).toEqual(['user']);
    const diagnostic = await store.search('assistant workout questions', {
      userId: 'u1', includeAllSources: true,
    });
    expect(diagnostic.some(result => result.memory.source === 'assistant')).toBe(true);
    store.close();
  });
});
