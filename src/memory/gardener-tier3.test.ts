/**
 * Tests for Tier 3 (Sleep) scheduling infrastructure in BackgroundGardener.
 *
 * Covers quiet hours detection, sleep tick counter threshold,
 * and deferral behavior when threshold is reached outside quiet hours.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundGardener } from './memory.js';
import type { Logger } from 'pino';

function createMockGardener(quietHours?: { start: number; end: number }) {
  const mockDb = {
    expireOldScheduledItems: vi.fn(),
    raw: vi.fn().mockReturnValue([]),
    getMemoriesByUser: vi.fn().mockReturnValue([]),
    pruneOldSessions: vi.fn().mockReturnValue(0),
    pruneArchivedMemories: vi.fn().mockReturnValue(0),
    listSessions: vi.fn().mockReturnValue([]),
    getSessionSummariesByUser: vi.fn().mockReturnValue([]),
    getScheduledItemsByUser: vi.fn().mockReturnValue([]),
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
    ...(quietHours ? { quietHours } : {}),
  });

  return { gardener, mockLogger, mockScallopStore };
}

describe('BackgroundGardener Tier 3 — Sleep Tick', () => {
  let hourMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (hourMock) hourMock.mockRestore();
    vi.useRealTimers();
  });

  // ============ isQuietHours logic ============

  describe('isQuietHours', () => {
    it('should detect quiet hours in normal range (hour 3, range 2-5)', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // Advance counter to threshold
      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should reject hours outside normal range (hour 10, range 2-5)', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // Advance counter to threshold
      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).not.toHaveBeenCalled();
    });

    it('should detect quiet hours in wrap-around range (hour 23, range 23-5)', () => {
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(23);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should detect quiet hours in wrap-around range (hour 3, range 23-5)', () => {
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should reject hours outside wrap-around range (hour 12, range 23-5)', () => {
      const { gardener } = createMockGardener({ start: 23, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(12);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).not.toHaveBeenCalled();
    });
  });

  // ============ Sleep tick counter ============

  describe('sleep tick counter', () => {
    it('should NOT fire sleepTick after 287 ticks (below threshold)', () => {
      const { gardener } = createMockGardener({ start: 0, end: 24 }); // always quiet
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 287; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).not.toHaveBeenCalled();
    });

    it('should fire sleepTick after 288 ticks during quiet hours', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should reset counter after sleepTick fires', () => {
      const { gardener } = createMockGardener({ start: 0, end: 24 }); // always quiet
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // First cycle: 288 ticks
      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);

      // 287 more ticks — should NOT fire again
      for (let i = 0; i < 287; i++) {
        gardener.lightTick();
      }
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);

      // One more tick (total: 288 again) — should fire again
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(2);
    });

    it('should NOT fire sleepTick after 288 ticks outside quiet hours', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(10); // outside quiet hours
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).not.toHaveBeenCalled();
    });
  });

  // ============ Sleep tick deferral ============

  describe('sleep tick deferral', () => {
    it('should defer sleepTick when threshold reached outside quiet hours, then fire on next quiet tick', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // Reach threshold outside quiet hours
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }
      expect(sleepTickSpy).not.toHaveBeenCalled();

      // Counter should still be >= 288, not reset
      // Next tick enters quiet hours — should fire
      hourMock.mockReturnValue(3);
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });

    it('should keep counter at threshold across multiple non-quiet ticks, then fire when quiet', () => {
      const { gardener } = createMockGardener({ start: 2, end: 5 });
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      // Reach threshold outside quiet hours
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(14);
      for (let i = 0; i < 290; i++) {
        gardener.lightTick();
      }
      expect(sleepTickSpy).not.toHaveBeenCalled();

      // Enter quiet hours — should fire immediately
      hourMock.mockReturnValue(3);
      gardener.lightTick();
      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============ Default quiet hours ============

  describe('default quiet hours', () => {
    it('should use default quiet hours 2-5 AM when not specified', () => {
      const { gardener } = createMockGardener(); // no quietHours option
      hourMock = vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3); // within 2-5
      const sleepTickSpy = vi.spyOn(gardener, 'sleepTick').mockResolvedValue();

      for (let i = 0; i < 288; i++) {
        gardener.lightTick();
      }

      expect(sleepTickSpy).toHaveBeenCalledTimes(1);
    });
  });
});
