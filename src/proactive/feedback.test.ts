/**
 * Tests for proactive engagement detection (feedback loop).
 *
 * detectProactiveEngagement is a pure function that identifies which
 * recently-fired agent items should be marked as 'acted' because the
 * user engaged within the engagement window.
 *
 * All tests use injectable `now` for deterministic timing.
 */

import { describe, it, expect } from 'vitest';
import { detectProactiveEngagement } from './feedback.js';
import type { ScheduledItem } from '../memory/db.js';

// ============ Constants for test readability ============

const MIN_MS = 60 * 1000;

/**
 * Fixed "now" for deterministic tests.
 * 2024-01-15T12:00:00.000Z (Monday noon UTC)
 */
const NOW = 1_705_320_000_000;

// ============ Test Helpers ============

/** Create a ScheduledItem with sensible defaults for agent-fired items */
function makeItem(overrides?: Partial<ScheduledItem>): ScheduledItem {
  return {
    id: 'item-1',
    userId: 'user-1',
    sessionId: null,
    source: 'agent',
    type: 'goal_checkin',
    message: 'How is your project going?',
    context: null,
    triggerAt: NOW - 30 * MIN_MS,
    recurring: null,
    status: 'fired',
    firedAt: NOW - 10 * MIN_MS,
    sourceMemoryId: null,
    createdAt: NOW - 60 * MIN_MS,
    updatedAt: NOW - 10 * MIN_MS,
    ...overrides,
  };
}

// ============ detectProactiveEngagement ============

describe('detectProactiveEngagement', () => {
  it('returns empty array when no fired items', () => {
    const result = detectProactiveEngagement('user-1', [], undefined, NOW);
    expect(result).toEqual([]);
  });

  it('returns empty array when all items outside engagement window', () => {
    const items = [
      makeItem({ id: 'old-1', firedAt: NOW - 20 * MIN_MS }),
      makeItem({ id: 'old-2', firedAt: NOW - 30 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW);
    expect(result).toEqual([]);
  });

  it('returns IDs of items within engagement window', () => {
    const items = [
      makeItem({ id: 'recent-1', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'recent-2', firedAt: NOW - 10 * MIN_MS }),
      makeItem({ id: 'old-1', firedAt: NOW - 20 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW);
    expect(result).toEqual(['recent-1', 'recent-2']);
  });

  it('ignores items with source !== agent', () => {
    const items = [
      makeItem({ id: 'user-item', source: 'user', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'agent-item', source: 'agent', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW);
    expect(result).toEqual(['agent-item']);
  });

  it('ignores items with status !== fired', () => {
    const items = [
      makeItem({ id: 'pending-item', status: 'pending', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'dismissed-item', status: 'dismissed', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'fired-item', status: 'fired', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW);
    expect(result).toEqual(['fired-item']);
  });

  it('ignores items without firedAt', () => {
    const items = [
      makeItem({ id: 'no-fired-at', firedAt: null }),
      makeItem({ id: 'has-fired-at', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW);
    expect(result).toEqual(['has-fired-at']);
  });

  it('respects custom engagementWindowMs', () => {
    const customWindow = 5 * MIN_MS; // 5 minutes instead of default 15
    const items = [
      makeItem({ id: 'within-custom', firedAt: NOW - 3 * MIN_MS }),
      makeItem({ id: 'outside-custom', firedAt: NOW - 7 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, customWindow, NOW);
    expect(result).toEqual(['within-custom']);
  });

  it('uses injectable now parameter', () => {
    const customNow = NOW + 60 * MIN_MS; // 1 hour later
    const items = [
      makeItem({ id: 'item-1', firedAt: NOW - 5 * MIN_MS }), // 65 min before customNow
      makeItem({ id: 'item-2', firedAt: customNow - 5 * MIN_MS }), // 5 min before customNow
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, customNow);
    expect(result).toEqual(['item-2']);
  });
});
