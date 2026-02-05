import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HotCollector,
  BackgroundGardener,
  extractFacts,
  summarizeMemories,
  calculateBM25Score,
  type MemoryEntry,
} from './memory.js';
import type { Logger } from 'pino';

describe('HotCollector', () => {
  let collector: HotCollector;
  let mockScallopStore: any;

  beforeEach(() => {
    mockScallopStore = {
      add: vi.fn().mockResolvedValue({ id: 'test-id', content: '', category: 'event' }),
    };
    collector = new HotCollector({ scallopStore: mockScallopStore, maxBuffer: 10 });
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
    it('should persist buffered memories to ScallopStore', () => {
      collector.collect({
        content: 'Important fact',
        sessionId: 'session-1',
        source: 'conversation',
      });

      collector.flush('session-1');

      expect(mockScallopStore.add).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'session-1',
          content: 'Important fact',
          category: 'event',
        })
      );
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
      expect(mockScallopStore.add).not.toHaveBeenCalled();
    });
  });
});

describe('BackgroundGardener', () => {
  let gardener: BackgroundGardener;
  let mockScallopStore: any;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();

    mockScallopStore = {
      processDecay: vi.fn().mockReturnValue({ updated: 0, archived: 0 }),
    };
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    gardener = new BackgroundGardener({
      scallopStore: mockScallopStore,
      logger: mockLogger,
      interval: 1000,
    });
  });

  afterEach(() => {
    gardener.stop();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('should run decay on schedule', async () => {
      gardener.start();

      await vi.advanceTimersByTimeAsync(1500);

      expect(mockScallopStore.processDecay).toHaveBeenCalled();
    });

    it('should not run when stopped', async () => {
      gardener.start();
      gardener.stop();

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockScallopStore.processDecay).not.toHaveBeenCalled();
    });
  });

  describe('processMemories', () => {
    it('should call ScallopStore processDecay', () => {
      gardener.processMemories();

      expect(mockScallopStore.processDecay).toHaveBeenCalledTimes(1);
    });

    it('should log when decay updates or archives', () => {
      mockScallopStore.processDecay.mockReturnValue({ updated: 5, archived: 2 });

      gardener.processMemories();

      expect(mockScallopStore.processDecay).toHaveBeenCalled();
    });
  });
});

describe('extractFacts', () => {
  it('should extract name mentions', () => {
    const facts = extractFacts('My name is Sarah');
    expect(facts.some((f) => f.content.includes('Sarah'))).toBe(true);
  });

  it('should extract location mentions', () => {
    const facts = extractFacts('I live in San Francisco');
    expect(facts.some((f) => f.content.toLowerCase().includes('san francisco'))).toBe(true);
  });

  it('should extract job mentions', () => {
    const facts = extractFacts('I work as a data scientist');
    expect(facts.some((f) => f.content.toLowerCase().includes('data scientist'))).toBe(true);
  });

  it('should extract preferences', () => {
    const facts = extractFacts('I prefer morning meetings over afternoon ones');
    expect(facts.length).toBeGreaterThan(0);
  });

  it('should handle empty input', () => {
    const facts = extractFacts('');
    expect(facts).toEqual([]);
  });

  it('should handle multiple facts in one sentence', () => {
    const facts = extractFacts('My name is Bob and I live in Seattle. I work as a developer.');
    expect(facts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('extractFacts with subject attribution', () => {
  it('should attribute facts about the user to "user"', () => {
    const facts = extractFacts('I work at Acme Corp');
    const workFact = facts.find((f) => f.content.toLowerCase().includes('microsoft'));
    expect(workFact).toBeDefined();
    expect(workFact?.subject).toBe('user');
  });

  it('should attribute user name to "user"', () => {
    const facts = extractFacts('My name is Alex');
    const nameFact = facts.find((f) => f.content.includes('Alex'));
    expect(nameFact).toBeDefined();
    expect(nameFact?.subject).toBe('user');
  });

  it('should attribute user location to "user"', () => {
    const facts = extractFacts('I live in Metropolis');
    const locationFact = facts.find((f) => f.content.toLowerCase().includes('dublin'));
    expect(locationFact).toBeDefined();
    expect(locationFact?.subject).toBe('user');
  });

  it('should attribute flatmate facts to the flatmate name', () => {
    const facts = extractFacts('My flatmate Bob works at Globex');
    const workFact = facts.find((f) => f.content.toLowerCase().includes('henry schein'));
    expect(workFact).toBeDefined();
    expect(workFact?.subject.toLowerCase()).toBe('hamza');
  });

  it('should attribute friend facts to the friend name', () => {
    const facts = extractFacts('My friend John lives in London');
    const locationFact = facts.find((f) => f.content.toLowerCase().includes('london'));
    expect(locationFact).toBeDefined();
    expect(locationFact?.subject.toLowerCase()).toBe('john');
  });

  it('should handle "X is my flatmate" pattern', () => {
    const facts = extractFacts('Bob is my flatmate and he works at Google');
    const relationFact = facts.find((f) => f.content.toLowerCase().includes('flatmate'));
    expect(relationFact).toBeDefined();
    expect(relationFact?.subject.toLowerCase()).toBe('hamza');
  });

  it('should handle complex sentence with both user and third party facts', () => {
    const facts = extractFacts('I work at Acme Corp and my colleague Sarah works at Amazon');

    const userWorkFact = facts.find((f) =>
      f.content.toLowerCase().includes('microsoft') && f.subject === 'user'
    );
    const sarahWorkFact = facts.find((f) =>
      f.content.toLowerCase().includes('amazon') && f.subject.toLowerCase() === 'sarah'
    );

    expect(userWorkFact).toBeDefined();
    expect(sarahWorkFact).toBeDefined();
  });

  it('should handle "my brother/sister" patterns', () => {
    const facts = extractFacts('My brother Ahmed is a doctor');
    const fact = facts.find((f) => f.content.toLowerCase().includes('doctor'));
    expect(fact).toBeDefined();
    expect(fact?.subject.toLowerCase()).toBe('ahmed');
  });

  it('should return ExtractedFact objects with content and subject', () => {
    const facts = extractFacts('I prefer dark mode');
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]).toHaveProperty('content');
    expect(facts[0]).toHaveProperty('subject');
  });
});

describe('summarizeMemories', () => {
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
    expect(summary).toContain('TypeScript');
  });

  it('should handle empty input', () => {
    const summary = summarizeMemories([]);
    expect(summary).toBe('');
  });
});

describe('calculateBM25Score', () => {
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
