import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopMemoryEntry } from './db.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import {
  RECALL_CONTEXT_NOTE,
  buildRecallBlock,
  buildRecallDigest,
  isTrivialMessage,
  rankRecallDigest,
  type RecallStore,
} from './recall.js';

const logger = pino({ level: 'silent' });

function entry(content: string, extra: Partial<ScallopMemoryEntry> = {}): ScallopMemoryEntry {
  const now = Date.now();
  return {
    id: content, userId: 'u1', content, category: 'fact', memoryType: 'regular', importance: 5, confidence: 0.8,
    isLatest: true, source: 'user', documentDate: now, eventDate: null, prominence: 0.5, lastAccessed: null,
    accessCount: 0, sourceChunk: null, embedding: null, metadata: null, createdAt: now, updatedAt: now, ...extra,
  };
}

describe('isTrivialMessage', () => {
  it.each([
    ['ok', true], ['Thanks!', true], ['thank you 🙏', true], ['👍', true], ['...', true], ['', true],
    ['sounds good', true], ['Nice work', true], ['got it, thanks', true],
    ['Sarah?', false], ['what about Sarah', false], ['ticket 4512', false], ['check src/app.ts', false],
    ['what did we decide about the trip', false], ['How is GitHub doing', false],
  ])('%s → %s', (message, trivial) => {
    expect(isTrivialMessage(message)).toBe(trivial);
  });
});

describe('buildRecallBlock', () => {
  let dir: string;
  let store: ScallopMemoryStore;
  let reranker: LLMProvider & { complete: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
    reranker = {
      name: 'rerank-spy',
      isAvailable: () => true,
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"scores":[]}' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm',
      } satisfies CompletionResponse),
    };
    store = new ScallopMemoryStore({ dbPath: path.join(dir, 'm.db'), logger, rerankProvider: reranker, foregroundRerank: true });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a marked <memory-context> block with live, user-grounded hits and never reranks', async () => {
    await store.add({ userId: 'u1', content: 'Sarah is planning the Lisbon trip in May', detectRelations: false });
    await store.add({ userId: 'u1', content: 'Assistant thinks Lisbon is lovely', source: 'assistant', detectRelations: false });
    await store.add({ userId: 'u1', content: 'Prefers aisle seats on flights', detectRelations: false });
    const block = await buildRecallBlock(store, 'u1', 'What did Sarah say about the Lisbon trip?', { timezone: 'UTC' });
    expect(block.startsWith('<memory-context>')).toBe(true);
    expect(block).toContain(RECALL_CONTEXT_NOTE);
    expect(block).toContain('Sarah is planning the Lisbon trip in May');
    expect(block).not.toContain('Assistant thinks');
    expect(block).toMatch(/\[Recorded: \d{4}-\d{2}-\d{2}\]/);
    expect(block.trimEnd().endsWith('</memory-context>')).toBe(true);
    // Even with foregroundRerank on, prefetch passes rerank:false.
    expect(reranker.complete).not.toHaveBeenCalled();
  });

  it('skips trivial messages without searching', async () => {
    const spy = vi.spyOn(store, 'search');
    expect(await buildRecallBlock(store, 'u1', 'thanks!')).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns empty when nothing relevant is live', async () => {
    await store.add({ userId: 'u1', content: 'Owns a red bicycle', detectRelations: false });
    expect(await buildRecallBlock(store, 'u1', 'explain quantum chromodynamics briefly')).toBe('');
  });

  it('enforces the hard time budget', async () => {
    const slow: RecallStore = {
      search: () => new Promise(resolve => setTimeout(() => resolve([]), 200)),
      getDatabase: () => ({ getMemoriesByUser: () => [] }),
    };
    const started = Date.now();
    expect(await buildRecallBlock(slow, 'u1', 'what about the Lisbon trip', { budgetMs: 20 })).toBe('');
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('swallows search errors', async () => {
    const broken: RecallStore = {
      search: () => Promise.reject(new Error('db locked')),
      getDatabase: () => ({ getMemoriesByUser: () => [] }),
    };
    expect(await buildRecallBlock(broken, 'u1', 'what about the Lisbon trip')).toBe('');
  });
});

describe('recall digest (Prime ranking)', () => {
  it('weights the goal ×3 above the newest message ×2 above older ones, plus prominence', () => {
    const memories = [
      entry('Budget for the kitchen renovation is 20k', { id: 'goal' }),
      entry('Kayak trip planned for August', { id: 'newest' }),
      entry('Guitar lessons on Tuesdays', { id: 'oldest' }),
      entry('Unrelated but very prominent fact about tea', { id: 'prominent', prominence: 1 }),
    ];
    const ranked = rankRecallDigest(memories, {
      goal: 'kitchen renovation budget',
      recentMessages: ['guitar lessons', 'something else', 'more chat', 'kayak trip'],
    });
    expect(ranked.map(item => item.memory.id)).toEqual(['goal', 'newest', 'oldest', 'prominent']);
    expect(ranked[0].overlap).toBeCloseTo(3, 5);
    expect(ranked[1].overlap).toBeCloseTo(2, 5);
    expect(ranked[2].overlap).toBeCloseTo(1, 5);
  });

  it('builds a capped digest block from the store, user-grounded only', () => {
    const rows = [
      entry('Kitchen renovation budget is 20k euro', { prominence: 0.9 }),
      entry('Assistant reflection about kitchens', { source: 'assistant' }),
      ...Array.from({ length: 40 }, (_, i) => entry(`Kitchen detail number ${i} about cabinets and tiles`, { id: `d${i}` })),
    ];
    const store: RecallStore = {
      search: async () => [],
      getDatabase: () => ({ getMemoriesByUser: () => rows }),
    };
    const digest = buildRecallDigest(store, 'u1', { goal: 'kitchen renovation budget', recentMessages: ['tiles for the kitchen'], maxChars: 400 });
    expect(digest.startsWith('<memory-context kind="digest">')).toBe(true);
    expect(digest).toContain('Kitchen renovation budget is 20k euro');
    expect(digest).not.toContain('Assistant reflection');
    const bullets = digest.split('\n').filter(line => line.startsWith('- '));
    expect(bullets.join('\n').length).toBeLessThanOrEqual(400);
    expect(buildRecallDigest({ ...store, getDatabase: () => ({ getMemoriesByUser: () => [] }) }, 'u1', { goal: 'x' })).toBe('');
  });
});
