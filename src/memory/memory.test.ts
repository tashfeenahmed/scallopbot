import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundGardener } from './memory.js';
import { calculateBM25Score } from './bm25.js';
import type { Logger } from 'pino';

describe('BackgroundGardener', () => {
  let gardener: BackgroundGardener;
  let mockScallopStore: any;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();

    mockScallopStore = {
      processDecay: vi.fn().mockReturnValue({ updated: 0, archived: 0 }),
      getDatabase: vi.fn().mockReturnValue({
        pruneOldSessions: vi.fn().mockReturnValue(0),
        pruneArchivedMemories: vi.fn().mockReturnValue(0),
      }),
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
