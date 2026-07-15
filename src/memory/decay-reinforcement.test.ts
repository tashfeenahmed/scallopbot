import { describe, expect, it, vi } from 'vitest';
import type { ScallopMemoryEntry } from './db.js';
import { DecayEngine } from './decay.js';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 15, 12);

function oldEvent(overrides: Partial<ScallopMemoryEntry> = {}): ScallopMemoryEntry {
  return {
    id: 'memory', userId: 'default', content: 'An old client meeting', category: 'event',
    memoryType: 'regular', importance: 5, confidence: 0.8, isLatest: true, source: 'user',
    documentDate: NOW - 180 * DAY, eventDate: NOW - 180 * DAY, prominence: 1,
    lastAccessed: null, accessCount: 0, sourceChunk: null, embedding: null, metadata: null,
    learnedFrom: 'conversation', timesConfirmed: 1, contradictionIds: null,
    createdAt: NOW - 180 * DAY, updatedAt: NOW - 180 * DAY,
    ...overrides,
  };
}

describe('natural decay reinforcement', () => {
  it('ignores machine retrieval frequency but responds to user confirmation', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const engine = new DecayEngine();
      const plain = engine.calculateProminence(oldEvent());
      const retrieved = engine.calculateProminence(oldEvent({
        accessCount: 10_000,
        lastAccessed: NOW,
      }));
      const confirmed = engine.calculateProminence(oldEvent({
        timesConfirmed: 5,
        updatedAt: NOW,
      }));

      expect(retrieved).toBe(plain);
      expect(plain).toBeLessThan(0.2);
      expect(confirmed).toBeGreaterThan(plain);
    } finally {
      now.mockRestore();
    }
  });
});
