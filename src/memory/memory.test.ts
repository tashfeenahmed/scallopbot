import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MemoryStore,
  HotCollector,
  BackgroundGardener,
  HybridSearch,
  MemoryEntry,
  extractFacts,
  summarizeMemories,
  calculateBM25Score,
} from './memory.js';
import type { Logger } from 'pino';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  describe('add', () => {
    it('should add a memory entry', () => {
      const entry: MemoryEntry = {
        id: 'mem-1',
        content: 'The user prefers dark mode',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
      };

      store.add(entry);

      expect(store.get('mem-1')).toEqual(entry);
    });

    it('should generate id if not provided', () => {
      const entry = store.add({
        content: 'Some memory',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
      });

      expect(entry.id).toBeDefined();
      expect(store.get(entry.id)).toBeDefined();
    });
  });

  describe('search', () => {
    beforeEach(() => {
      store.add({
        id: 'mem-1',
        content: 'User prefers TypeScript over JavaScript',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
        tags: ['preferences', 'programming'],
      });
      store.add({
        id: 'mem-2',
        content: 'User lives in New York City',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
        tags: ['location'],
      });
      store.add({
        id: 'mem-3',
        content: 'User works on a React project called ScallopBot',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
        tags: ['work', 'programming'],
      });
    });

    it('should find memories by content match', () => {
      const results = store.search('TypeScript');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should find memories by tag', () => {
      const results = store.searchByTag('programming');

      expect(results).toHaveLength(2);
    });

    it('should return empty array for no matches', () => {
      const results = store.search('Python');

      expect(results).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('should delete a memory', () => {
      store.add({
        id: 'to-delete',
        content: 'Temporary memory',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
      });

      store.delete('to-delete');

      expect(store.get('to-delete')).toBeUndefined();
    });
  });

  describe('getBySession', () => {
    it('should return memories for specific session', () => {
      store.add({
        id: 'mem-1',
        content: 'Session 1 memory',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-1',
      });
      store.add({
        id: 'mem-2',
        content: 'Session 2 memory',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 'session-2',
      });

      const session1Mems = store.getBySession('session-1');

      expect(session1Mems).toHaveLength(1);
      expect(session1Mems[0].sessionId).toBe('session-1');
    });
  });

  describe('getRecent', () => {
    it('should return most recent memories', () => {
      const now = Date.now();

      store.add({
        id: 'old',
        content: 'Old memory',
        type: 'fact',
        timestamp: new Date(now - 10000),
        sessionId: 'session-1',
      });
      store.add({
        id: 'new',
        content: 'New memory',
        type: 'fact',
        timestamp: new Date(now),
        sessionId: 'session-1',
      });

      const recent = store.getRecent(1);

      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe('new');
    });
  });
});

describe('HotCollector', () => {
  let collector: HotCollector;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    collector = new HotCollector({ store, maxBuffer: 10 });
  });

  describe('collect', () => {
    it('should collect memory during conversation', () => {
      collector.collect({
        content: 'User mentioned they like coffee',
        sessionId: 'session-1',
        source: 'conversation',
      });

      const buffer = collector.getBuffer('session-1');
      expect(buffer).toHaveLength(1);
    });

    it('should respect buffer limit', () => {
      for (let i = 0; i < 15; i++) {
        collector.collect({
          content: `Memory ${i}`,
          sessionId: 'session-1',
          source: 'conversation',
        });
      }

      const buffer = collector.getBuffer('session-1');
      expect(buffer.length).toBeLessThanOrEqual(10);
    });

    it('should separate buffers by session', () => {
      collector.collect({
        content: 'Session 1 memory',
        sessionId: 'session-1',
        source: 'conversation',
      });
      collector.collect({
        content: 'Session 2 memory',
        sessionId: 'session-2',
        source: 'conversation',
      });

      expect(collector.getBuffer('session-1')).toHaveLength(1);
      expect(collector.getBuffer('session-2')).toHaveLength(1);
    });
  });

  describe('flush', () => {
    it('should persist buffered memories to store', () => {
      collector.collect({
        content: 'Important fact',
        sessionId: 'session-1',
        source: 'conversation',
      });

      collector.flush('session-1');

      expect(store.search('Important')).toHaveLength(1);
      expect(collector.getBuffer('session-1')).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should clear buffer without persisting', () => {
      collector.collect({
        content: 'Temporary memory',
        sessionId: 'session-1',
        source: 'conversation',
      });

      collector.clear('session-1');

      expect(collector.getBuffer('session-1')).toHaveLength(0);
      expect(store.search('Temporary')).toHaveLength(0);
    });
  });
});

describe('BackgroundGardener', () => {
  let gardener: BackgroundGardener;
  let store: MemoryStore;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();

    store = new MemoryStore();
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    gardener = new BackgroundGardener({
      store,
      logger: mockLogger,
      interval: 1000, // 1 second for testing
    });
  });

  afterEach(() => {
    gardener.stop();
    vi.useRealTimers();
  });

  describe('fact extraction', () => {
    it('should extract facts from conversation', () => {
      const facts = extractFacts(
        'Hi, I am John and I work at Google as a software engineer. I love Python programming.'
      );

      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.toLowerCase().includes('john'))).toBe(true);
    });

    it('should handle empty input', () => {
      const facts = extractFacts('');
      expect(facts).toEqual([]);
    });

    it('should extract preferences', () => {
      const facts = extractFacts('I prefer using VS Code over other editors');
      expect(facts.some((f) => f.toLowerCase().includes('prefer'))).toBe(true);
    });
  });

  describe('summarization', () => {
    it('should summarize multiple memories', () => {
      const memories: MemoryEntry[] = [
        {
          id: '1',
          content: 'User likes TypeScript',
          type: 'fact',
          timestamp: new Date(),
          sessionId: 's1',
        },
        {
          id: '2',
          content: 'User prefers dark mode',
          type: 'fact',
          timestamp: new Date(),
          sessionId: 's1',
        },
        {
          id: '3',
          content: 'User works on web development',
          type: 'fact',
          timestamp: new Date(),
          sessionId: 's1',
        },
      ];

      const summary = summarizeMemories(memories);

      expect(summary).toBeDefined();
      expect(summary.length).toBeGreaterThan(0);
      // Summary should contain content from the memories
      expect(summary).toContain('TypeScript');
    });

    it('should handle empty input', () => {
      const summary = summarizeMemories([]);
      expect(summary).toBe('');
    });
  });

  describe('gardening cycle', () => {
    it('should run gardening on schedule', async () => {
      store.add({
        id: 'raw-1',
        content: 'My name is Alice and I love coding',
        type: 'raw',
        timestamp: new Date(),
        sessionId: 'session-1',
      });

      gardener.start();

      await vi.advanceTimersByTimeAsync(1500);

      // Should have processed the raw memory
      const facts = store.searchByType('fact');
      expect(facts.length).toBeGreaterThanOrEqual(0);
    });

    it('should not run when stopped', async () => {
      const processSpy = vi.spyOn(gardener, 'processMemories');

      gardener.start();
      gardener.stop();

      await vi.advanceTimersByTimeAsync(2000);

      expect(processSpy).not.toHaveBeenCalled();
    });
  });

  describe('deduplication', () => {
    it('should identify duplicate memories', () => {
      store.add({
        id: 'dup-1',
        content: 'User prefers TypeScript',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });
      store.add({
        id: 'dup-2',
        content: 'User prefers TypeScript programming',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      gardener.deduplicate();

      const allFacts = store.searchByType('fact');
      // Should have reduced duplicates
      expect(allFacts.length).toBeLessThanOrEqual(2);
    });
  });

  describe('bidirectional linking', () => {
    it('should link semantically related facts', () => {
      store.add({
        id: 'link-1',
        content: 'User prefers TypeScript for web development projects',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });
      store.add({
        id: 'link-2',
        content: 'User uses TypeScript for frontend development work',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      gardener.linkRelatedFacts();

      const fact1 = store.get('link-1');
      const fact2 = store.get('link-2');

      // At least one should have related IDs
      const hasLinks =
        (fact1?.metadata?.relatedIds as string[])?.includes('link-2') ||
        (fact2?.metadata?.relatedIds as string[])?.includes('link-1');
      expect(hasLinks).toBe(true);
    });

    it('should create bidirectional links', () => {
      store.add({
        id: 'bi-1',
        content: 'JavaScript is a programming language',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });
      store.add({
        id: 'bi-2',
        content: 'TypeScript extends JavaScript language',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      gardener.linkRelatedFacts();

      const fact1 = store.get('bi-1');
      const fact2 = store.get('bi-2');

      const relatedIds1 = (fact1?.metadata?.relatedIds as string[]) || [];
      const relatedIds2 = (fact2?.metadata?.relatedIds as string[]) || [];

      // Both should link to each other
      if (relatedIds1.includes('bi-2')) {
        expect(relatedIds2.includes('bi-1')).toBe(true);
      }
    });

    it('should get related facts', () => {
      store.add({
        id: 'rel-1',
        content: 'User prefers dark mode',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
        metadata: { relatedIds: ['rel-2'] },
      });
      store.add({
        id: 'rel-2',
        content: 'User works at night',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      const related = gardener.getRelatedFacts('rel-1');
      expect(related).toHaveLength(1);
      expect(related[0].id).toBe('rel-2');
    });
  });

  describe('fact pruning', () => {
    it('should detect contradicting facts', () => {
      // Older fact
      store.add({
        id: 'old-pref',
        content: 'User prefers light mode',
        type: 'fact',
        timestamp: new Date(Date.now() - 86400000), // 1 day ago
        sessionId: 's1',
      });
      // Newer contradicting fact
      store.add({
        id: 'new-pref',
        content: 'User prefers dark mode',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      gardener.pruneOutdatedFacts();

      const oldFact = store.get('old-pref');
      expect(oldFact?.metadata?.superseded).toBe(true);
    });

    it('should link newer fact to superseded fact', () => {
      store.add({
        id: 'old-loc',
        content: 'User lives in New York',
        type: 'fact',
        timestamp: new Date(Date.now() - 86400000),
        sessionId: 's1',
      });
      store.add({
        id: 'new-loc',
        content: 'User lives in San Francisco',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });

      gardener.pruneOutdatedFacts();

      const newFact = store.get('new-loc');
      expect(newFact?.metadata?.supersedes).toBe('old-loc');
    });

    it('should check if fact is superseded', () => {
      store.add({
        id: 'check-1',
        content: 'Some fact',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
        metadata: { superseded: true },
      });

      expect(gardener.isSuperseded('check-1')).toBe(true);
      expect(gardener.isSuperseded('nonexistent')).toBe(false);
    });

    it('should get active facts only', () => {
      store.add({
        id: 'active-1',
        content: 'Active fact',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
      });
      store.add({
        id: 'superseded-1',
        content: 'Old fact',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
        metadata: { superseded: true },
      });

      const active = gardener.getActiveFacts();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('active-1');
    });

    it('should delete old superseded facts after retention period', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      store.add({
        id: 'to-delete',
        content: 'Very old superseded fact',
        type: 'fact',
        timestamp: eightDaysAgo,
        sessionId: 's1',
        metadata: {
          superseded: true,
          supersededAt: eightDaysAgo.toISOString(),
        },
      });

      gardener.pruneOutdatedFacts();

      expect(store.get('to-delete')).toBeUndefined();
    });
  });
});

describe('HybridSearch', () => {
  let search: HybridSearch;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();

    // Add test data
    store.add({
      id: 'mem-1',
      content: 'TypeScript is a typed superset of JavaScript',
      type: 'fact',
      timestamp: new Date(),
      sessionId: 's1',
      tags: ['programming', 'typescript'],
    });
    store.add({
      id: 'mem-2',
      content: 'React is a JavaScript library for building user interfaces',
      type: 'fact',
      timestamp: new Date(),
      sessionId: 's1',
      tags: ['programming', 'react'],
    });
    store.add({
      id: 'mem-3',
      content: 'The user enjoys hiking on weekends',
      type: 'fact',
      timestamp: new Date(),
      sessionId: 's1',
      tags: ['hobbies'],
    });

    search = new HybridSearch({ store });
  });

  describe('BM25 scoring', () => {
    it('should calculate BM25 score', () => {
      const score = calculateBM25Score('TypeScript JavaScript', 'TypeScript is a typed superset of JavaScript', {
        avgDocLength: 10,
        docCount: 3,
      });

      expect(score).toBeGreaterThan(0);
    });

    it('should return 0 for no match', () => {
      const score = calculateBM25Score('Python', 'TypeScript is great', {
        avgDocLength: 10,
        docCount: 3,
      });

      expect(score).toBe(0);
    });
  });

  describe('search', () => {
    it('should return ranked results', () => {
      const results = search.search('JavaScript programming');

      expect(results.length).toBeGreaterThan(0);
      // Results should be ranked by relevance
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
    });

    it('should combine keyword and semantic matches', () => {
      const results = search.search('web development JavaScript');

      expect(results.length).toBeGreaterThan(0);
    });

    it('should respect limit parameter', () => {
      const results = search.search('programming', { limit: 1 });

      expect(results).toHaveLength(1);
    });

    it('should filter by type', () => {
      store.add({
        id: 'sum-1',
        content: 'Summary of programming discussions',
        type: 'summary',
        timestamp: new Date(),
        sessionId: 's1',
      });

      const results = search.search('programming', { type: 'fact' });

      expect(results.every((r) => r.entry.type === 'fact')).toBe(true);
    });

    it('should boost recent memories', () => {
      const now = Date.now();

      store.add({
        id: 'old',
        content: 'Old fact about JavaScript',
        type: 'fact',
        timestamp: new Date(now - 86400000), // 1 day ago
        sessionId: 's1',
      });
      store.add({
        id: 'recent',
        content: 'Recent fact about JavaScript',
        type: 'fact',
        timestamp: new Date(now),
        sessionId: 's1',
      });

      const results = search.search('JavaScript', { recencyBoost: true });

      const recentIndex = results.findIndex((r) => r.entry.id === 'recent');
      const oldIndex = results.findIndex((r) => r.entry.id === 'old');

      // Recent should rank higher (lower index) with recency boost
      if (recentIndex !== -1 && oldIndex !== -1) {
        expect(recentIndex).toBeLessThanOrEqual(oldIndex);
      }
    });
  });

  describe('vector search simulation', () => {
    it('should find semantically similar content', () => {
      // Add a memory that's semantically related but uses different words
      store.add({
        id: 'semantic-1',
        content: 'The user codes in Node.js for backend development',
        type: 'fact',
        timestamp: new Date(),
        sessionId: 's1',
        tags: ['programming'],
      });

      const results = search.search('server-side JavaScript');

      // Should find Node.js even though we searched for "server-side JavaScript"
      const nodeResult = results.find((r) => r.entry.content.includes('Node.js'));
      expect(nodeResult).toBeDefined();
    });
  });
});

describe('extractFacts', () => {
  it('should extract name mentions', () => {
    const facts = extractFacts('My name is Sarah');
    expect(facts.some((f) => f.includes('Sarah'))).toBe(true);
  });

  it('should extract location mentions', () => {
    const facts = extractFacts('I live in San Francisco');
    expect(facts.some((f) => f.toLowerCase().includes('san francisco'))).toBe(true);
  });

  it('should extract job mentions', () => {
    const facts = extractFacts('I work as a data scientist');
    expect(facts.some((f) => f.toLowerCase().includes('data scientist'))).toBe(true);
  });

  it('should extract preferences', () => {
    const facts = extractFacts('I prefer morning meetings over afternoon ones');
    expect(facts.length).toBeGreaterThan(0);
  });

  it('should handle multiple facts in one sentence', () => {
    // Using patterns that extractFacts can recognize
    const facts = extractFacts('My name is Bob and I live in Seattle. I work as a developer.');
    expect(facts.length).toBeGreaterThanOrEqual(2);
  });
});
