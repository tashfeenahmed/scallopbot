/**
 * Tests for Tier 3 (Sleep) scheduling infrastructure in BackgroundGardener.
 *
 * Covers quiet hours detection, time-based deep/sleep tick triggering,
 * and deferral behavior for sleep ticks outside quiet hours.
 *
 * The gardener uses persisted timestamps in runtime_keys to decide
 * when to fire deep ticks (~72 min) and sleep ticks (~20h + quiet hours).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundGardener } from './memory.js';
import type { Logger } from 'pino';

const DEEP_INTERVAL_MS = 72 * 60 * 1000;      // 72 minutes
const SLEEP_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours

function createMockGardener(
  quietHours?: { start: number; end: number },
  initialRuntimeKeys?: Record<string, string>,
) {
  // In-memory runtime key store
  const runtimeKeys: Record<string, string> = { ...initialRuntimeKeys };

  const mockDb = {
    expireOldScheduledItems: vi.fn(),
    raw: vi.fn().mockReturnValue([]),
    getMemoriesByUser: vi.fn().mockReturnValue([]),
    pruneOldSessions: vi.fn().mockReturnValue(0),
    pruneArchivedMemories: vi.fn().mockReturnValue(0),
    listSessions: vi.fn().mockReturnValue([]),
    getSessionSummariesByUser: vi.fn().mockReturnValue([]),
    getScheduledItemsByUser: vi.fn().mockReturnValue([]),
    getRuntimeKey: vi.fn((key: string) => runtimeKeys[key] ?? null),
    setRuntimeKey: vi.fn((key: string, value: string) => {
      runtimeKeys[key] = value;
    }),
  };

  const mockScallopStore = {
    processDecay: vi.fn().mockReturnValue({ updated: 0, archived: 0 }),
    getDatabase: vi.fn().mockReturnValue(mockDb),
  };

  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  const gardener = new BackgroundGardener({
    scallopStore: mockScallopStore as any,
    logger: mockLogger,
    interval: 1000,
    getTimezone: () => 'UTC',
    ...(quietHours ? { quietHours } : {}),
  });

  return { gardener, mockLogger, mockScallopStore, mockDb, runtimeKeys };
}

/** Set fake system time to a specific UTC hour */
function setUTCHour(hour: number) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  vi.setSystemTime(d);
}

describe('BackgroundGardener Tier 3 — Sleep Tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============ isQuietHours logic ============

  describe('isQuietHours', () => {
    it('should fire sleepTick during quiet hours (hour 3, range 2-5)', () => {
      // Set time to hour 3 (quiet) and ensure sleep interval has elapsed
      setUTCHour(3);
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // First lightTick: no persisted timestamp → elapsed > 20h → fires
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire sleepTick outside quiet hours (hour 10, range 2-5)', () => {
      setUTCHour(10);
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).not.toHaveBeenCalled();
    });

    it('should fire sleepTick in wrap-around quiet range (hour 23, range 23-5)', () => {
      setUTCHour(23);
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should fire sleepTick in wrap-around quiet range (hour 3, range 23-5)', () => {
      setUTCHour(3);
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire sleepTick outside wrap-around range (hour 12, range 23-5)', () => {
      setUTCHour(12);
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).not.toHaveBeenCalled();
    });
  });

  // ============ Time-based deep/sleep tick triggering ============

  describe('time-based tick triggering', () => {
    it('should NOT fire sleepTick when last sleep was recent', () => {
      setUTCHour(3); // quiet hours
      const now = Date.now();
      const { gardener } = createMockGardener({ start: 2, end: 5 }, {
        'gardener:lastSleepTickAt': String(now - 60 * 60 * 1000), // 1h ago (< 20h)
        'gardener:lastDeepTickAt': String(now), // just now
      });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).not.toHaveBeenCalled();
    });

    it('should fire sleepTick when interval has elapsed and in quiet hours', () => {
      setUTCHour(3); // quiet hours
      const now = Date.now();
      const { gardener } = createMockGardener({ start: 2, end: 5 }, {
        'gardener:lastSleepTickAt': String(now - SLEEP_INTERVAL_MS - 1), // just past 20h
        'gardener:lastDeepTickAt': String(now), // just now (prevent deep tick)
      });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire deepTick when last deep was recent', () => {
      setUTCHour(10);
      const now = Date.now();
      const { gardener } = createMockGardener({ start: 2, end: 5 }, {
        'gardener:lastDeepTickAt': String(now - 30 * 60 * 1000), // 30m ago (< 72m)
        'gardener:lastSleepTickAt': String(now),
      });
      const deepTickSpy = vi.spyOn(gardener, 'deepTick').mockResolvedValue();

      gardener.lightTick();
      expect(deepTickSpy).not.toHaveBeenCalled();
    });

    it('should fire deepTick when interval has elapsed', () => {
      setUTCHour(10);
      const now = Date.now();
      const { gardener } = createMockGardener({ start: 2, end: 5 }, {
        'gardener:lastDeepTickAt': String(now - DEEP_INTERVAL_MS - 1), // just past 72m
        'gardener:lastSleepTickAt': String(now),
      });
      const deepTickSpy = vi.spyOn(gardener, 'deepTick').mockResolvedValue();

      gardener.lightTick();
      expect(deepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should persist timestamp after firing sleepTick', () => {
      setUTCHour(3);
      const { gardener, runtimeKeys } = createMockGardener({ start: 2, end: 5 });
      vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();

      // Timestamp should have been persisted
      expect(runtimeKeys['gardener:lastSleepTickAt']).toBeDefined();
      const persisted = parseInt(runtimeKeys['gardener:lastSleepTickAt'], 10);
      expect(persisted).toBeGreaterThan(0);
      expect(Math.abs(persisted - Date.now())).toBeLessThan(1000);
    });

    it('should NOT fire sleepTick again within interval after previous fire', () => {
      setUTCHour(3);
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // First tick fires (no persisted timestamp)
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);

      // Second tick should NOT fire (timestamp was just persisted)
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============ Sleep tick deferral ============

  describe('sleep tick deferral', () => {
    it('should defer sleepTick outside quiet hours, then fire when entering quiet', () => {
      const now = Date.now();
      // Start outside quiet hours — interval elapsed but not quiet
      setUTCHour(10);
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).not.toHaveBeenCalled();

      // Enter quiet hours — should fire
      setUTCHour(3);
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============ Default quiet hours ============

  describe('default quiet hours', () => {
    it('should use default quiet hours 2-5 AM when not specified', () => {
      setUTCHour(3); // within 2-5
      const { gardener } = createMockGardener(); // no quietHours option
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });
  });
});
