/**
 * Tests for trust score computation.
 *
 * Pure function that computes a 0.0-1.0 trust score from session data
 * and scheduled item outcomes, mapping to a proactiveness dial
 * (conservative/moderate/eager).
 */

import { describe, it, expect } from 'vitest';
import {
  computeTrustScore,
  type TrustScoreResult,
  type TrustSignals,
  type SessionInput,
  type ScheduledItemInput,
} from './trust-score.js';

// ============ Test Helpers ============

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Create a session input */
function makeSession(
  messageCount: number,
  durationMs: number,
  startTime: number,
): SessionInput {
  return { messageCount, durationMs, startTime };
}

/** Create a scheduled item input */
function makeScheduledItem(
  status: 'pending' | 'fired' | 'acted' | 'dismissed',
  source: string = 'gap-scanner',
  firedAt?: number,
): ScheduledItemInput {
  return firedAt != null
    ? { status, source, firedAt }
    : { status, source };
}

/** Create N sessions spread across recent days */
function makeRecentSessions(
  count: number,
  daysSpread: number,
  baseTime: number = Date.now(),
): SessionInput[] {
  const sessions: SessionInput[] = [];
  const interval = (daysSpread * DAY_MS) / count;
  for (let i = 0; i < count; i++) {
    sessions.push(
      makeSession(
        5 + Math.floor(i * 2), // increasing message count
        15 * 60 * 1000 + i * 5 * 60 * 1000, // 15-50 min durations
        baseTime - (count - 1 - i) * interval,
      ),
    );
  }
  return sessions;
}

// ============ Cold Start Cases ============

describe('computeTrustScore — cold start', () => {
  it('returns null for empty sessions array', () => {
    const result = computeTrustScore([], []);
    expect(result).toBeNull();
  });

  it('returns null for fewer than 5 sessions', () => {
    const sessions = [
      makeSession(5, 10 * 60 * 1000, Date.now() - 4 * DAY_MS),
      makeSession(3, 5 * 60 * 1000, Date.now() - 3 * DAY_MS),
      makeSession(7, 15 * 60 * 1000, Date.now() - 2 * DAY_MS),
      makeSession(4, 8 * 60 * 1000, Date.now() - DAY_MS),
    ];
    expect(computeTrustScore(sessions, [])).toBeNull();
  });

  it('returns null for exactly 4 sessions', () => {
    const sessions = makeRecentSessions(4, 7);
    expect(computeTrustScore(sessions, [])).toBeNull();
  });

  it('returns a result for exactly 5 sessions', () => {
    const sessions = makeRecentSessions(5, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
  });
});

// ============ No Scheduled Items (session-only computation) ============

describe('computeTrustScore — no scheduled items', () => {
  it('computes from sessions only when scheduledItems is empty', () => {
    const sessions = makeRecentSessions(7, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(result!.trustScore).toBeGreaterThanOrEqual(0);
    expect(result!.trustScore).toBeLessThanOrEqual(1);
    expect(result!.proactivenessDial).toBeDefined();
    expect(result!.signals).toBeDefined();
  });

  it('defaults proactive signals to 0.5 when no scheduled items', () => {
    const sessions = makeRecentSessions(7, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    // With no scheduled items, proactiveAcceptRate and proactiveDismissRate should default to neutral
    expect(result!.signals.proactiveAcceptRate).toBe(0.5);
    expect(result!.signals.proactiveDismissRate).toBe(0.5);
  });
});

// ============ Active User Scenarios ============

describe('computeTrustScore — active user with proactive items', () => {
  it('returns high trust (>0.7) and eager dial when all items acted on', () => {
    const now = Date.now();
    // Active user: 10 sessions in last 7 days with good durations
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(makeSession(10, 30 * 60 * 1000, now - (9 - i) * DAY_MS * 0.7));
    }

    // All proactive items were acted on
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 6 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 5 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 4 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 2 * DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.trustScore).toBeGreaterThan(0.7);
    expect(result!.proactivenessDial).toBe('eager');
  });

  it('returns low trust (<0.3) and conservative dial when all items dismissed', () => {
    const now = Date.now();
    // Some sessions but all proactive items dismissed
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 6; i++) {
      sessions.push(makeSession(3, 5 * 60 * 1000, now - (10 - i) * DAY_MS));
    }

    const items: ScheduledItemInput[] = [
      makeScheduledItem('dismissed', 'gap-scanner', now - 6 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 5 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 4 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 2 * DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.trustScore).toBeLessThan(0.3);
    expect(result!.proactivenessDial).toBe('conservative');
  });

  it('returns moderate trust (~0.5) and moderate dial for mixed outcomes', () => {
    const now = Date.now();
    const sessions = makeRecentSessions(7, 7);

    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 5 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 4 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('fired', 'gap-scanner', now - 2 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 1 * DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.trustScore).toBeGreaterThanOrEqual(0.3);
    expect(result!.trustScore).toBeLessThanOrEqual(0.7);
    expect(result!.proactivenessDial).toBe('moderate');
  });

  it('ignores pending items in proactive rate calculation', () => {
    const now = Date.now();
    const sessions = makeRecentSessions(7, 7);

    // 2 acted, 3 pending — pending should be excluded
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 2 * DAY_MS),
      makeScheduledItem('pending', 'gap-scanner'),
      makeScheduledItem('pending', 'gap-scanner'),
      makeScheduledItem('pending', 'gap-scanner'),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    // With only acted items (no dismissed), accept rate should be high
    expect(result!.signals.proactiveAcceptRate).toBeGreaterThan(0.8);
  });
});

// ============ EMA Smoothing with existingScore ============

describe('computeTrustScore — EMA smoothing', () => {
  it('smooths toward existing score when provided', () => {
    const sessions = makeRecentSessions(7, 7);
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', Date.now() - 2 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', Date.now() - DAY_MS),
    ];

    // Compute without existing score
    const rawResult = computeTrustScore(sessions, items);
    expect(rawResult).not.toBeNull();

    // Now compute with a very different existing score
    const smoothedResult = computeTrustScore(sessions, items, {
      existingScore: 0.1,
    });
    expect(smoothedResult).not.toBeNull();

    // Smoothed result should be pulled toward the existing score (0.1)
    // Since weight is 0.3 new + 0.7 existing, should be closer to 0.1 than raw
    expect(smoothedResult!.trustScore).toBeLessThan(rawResult!.trustScore);
  });

  it('prevents wild swings by weighting existing score heavily', () => {
    const sessions = makeRecentSessions(10, 7);
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', Date.now() - 2 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', Date.now() - DAY_MS),
    ];

    const result = computeTrustScore(sessions, items, {
      existingScore: 0.5,
    });
    expect(result).not.toBeNull();

    // Result should not be too far from 0.5 due to EMA smoothing
    expect(result!.trustScore).toBeGreaterThan(0.3);
    expect(result!.trustScore).toBeLessThan(0.8);
  });
});

// ============ Edge Cases ============

describe('computeTrustScore — edge cases', () => {
  it('handles sessions with 0 duration gracefully (no NaN)', () => {
    const now = Date.now();
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 6; i++) {
      sessions.push(makeSession(5, 0, now - (5 - i) * DAY_MS));
    }

    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(Number.isNaN(result!.trustScore)).toBe(false);
    expect(Number.isFinite(result!.trustScore)).toBe(true);
    expect(result!.trustScore).toBeGreaterThanOrEqual(0);
    expect(result!.trustScore).toBeLessThanOrEqual(1);
  });

  it('trust score is always clamped to [0, 1]', () => {
    const now = Date.now();
    // Edge case: many dismissed items should push negative weight
    const sessions = makeRecentSessions(6, 14);
    const items: ScheduledItemInput[] = [];
    for (let i = 0; i < 20; i++) {
      items.push(makeScheduledItem('dismissed', 'gap-scanner', now - i * DAY_MS));
    }

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.trustScore).toBeGreaterThanOrEqual(0);
    expect(result!.trustScore).toBeLessThanOrEqual(1);
  });

  it('no NaN or Infinity in signals', () => {
    const now = Date.now();
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 5; i++) {
      sessions.push(makeSession(0, 0, now - i * DAY_MS));
    }

    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    const signals = result!.signals;
    expect(Number.isFinite(signals.sessionReturnRate)).toBe(true);
    expect(Number.isFinite(signals.avgSessionDuration)).toBe(true);
    expect(Number.isFinite(signals.proactiveAcceptRate)).toBe(true);
    expect(Number.isFinite(signals.proactiveDismissRate)).toBe(true);
    expect(Number.isFinite(signals.explicitFeedback)).toBe(true);
  });

  it('handles all sessions at same startTime', () => {
    const now = Date.now();
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 5; i++) {
      sessions.push(makeSession(5, 10 * 60 * 1000, now));
    }

    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(Number.isNaN(result!.trustScore)).toBe(false);
    expect(Number.isFinite(result!.trustScore)).toBe(true);
  });
});

// ============ Dial Mapping ============

describe('computeTrustScore — dial mapping', () => {
  it('maps score < 0.3 to conservative', () => {
    const now = Date.now();
    // Infrequent sessions spread over a long time + all dismissed items
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 6; i++) {
      sessions.push(makeSession(2, 2 * 60 * 1000, now - (30 - i * 5) * DAY_MS));
    }
    const items: ScheduledItemInput[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(makeScheduledItem('dismissed', 'gap-scanner', now - i * DAY_MS));
    }

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    if (result!.trustScore < 0.3) {
      expect(result!.proactivenessDial).toBe('conservative');
    }
  });

  it('maps score 0.3-0.7 to moderate', () => {
    const now = Date.now();
    const sessions = makeRecentSessions(7, 7);
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 2 * DAY_MS),
      makeScheduledItem('fired', 'gap-scanner', now - DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    if (result!.trustScore >= 0.3 && result!.trustScore < 0.7) {
      expect(result!.proactivenessDial).toBe('moderate');
    }
  });

  it('maps score >= 0.7 to eager', () => {
    const now = Date.now();
    // Very active user with all items acted on
    const sessions: SessionInput[] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(makeSession(15, 45 * 60 * 1000, now - (9 - i) * DAY_MS * 0.7));
    }
    const items: ScheduledItemInput[] = [];
    for (let i = 0; i < 8; i++) {
      items.push(makeScheduledItem('acted', 'gap-scanner', now - i * DAY_MS));
    }

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    if (result!.trustScore >= 0.7) {
      expect(result!.proactivenessDial).toBe('eager');
    }
  });
});

// ============ Signal Values ============

describe('computeTrustScore — signal values', () => {
  it('returns a TrustSignals object with all expected fields', () => {
    const sessions = makeRecentSessions(7, 7);
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', Date.now() - DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.signals).toHaveProperty('sessionReturnRate');
    expect(result!.signals).toHaveProperty('avgSessionDuration');
    expect(result!.signals).toHaveProperty('proactiveAcceptRate');
    expect(result!.signals).toHaveProperty('proactiveDismissRate');
    expect(result!.signals).toHaveProperty('explicitFeedback');
  });

  it('explicitFeedback defaults to 0.5 (neutral placeholder)', () => {
    const sessions = makeRecentSessions(7, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(result!.signals.explicitFeedback).toBe(0.5);
  });

  it('sessionReturnRate is between 0 and 1', () => {
    const sessions = makeRecentSessions(7, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(result!.signals.sessionReturnRate).toBeGreaterThanOrEqual(0);
    expect(result!.signals.sessionReturnRate).toBeLessThanOrEqual(1);
  });

  it('avgSessionDuration is between 0 and 1', () => {
    const sessions = makeRecentSessions(7, 7);
    const result = computeTrustScore(sessions, []);
    expect(result).not.toBeNull();
    expect(result!.signals.avgSessionDuration).toBeGreaterThanOrEqual(0);
    expect(result!.signals.avgSessionDuration).toBeLessThanOrEqual(1);
  });

  it('proactiveAcceptRate reflects acted ratio correctly', () => {
    const now = Date.now();
    const sessions = makeRecentSessions(7, 7);
    // 3 acted out of 4 actionable (fired, acted, dismissed)
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 4 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 2 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.signals.proactiveAcceptRate).toBeCloseTo(0.75, 1);
  });

  it('proactiveDismissRate reflects dismissed ratio correctly', () => {
    const now = Date.now();
    const sessions = makeRecentSessions(7, 7);
    // 2 dismissed out of 4 actionable
    const items: ScheduledItemInput[] = [
      makeScheduledItem('acted', 'gap-scanner', now - 4 * DAY_MS),
      makeScheduledItem('acted', 'gap-scanner', now - 3 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - 2 * DAY_MS),
      makeScheduledItem('dismissed', 'gap-scanner', now - DAY_MS),
    ];

    const result = computeTrustScore(sessions, items);
    expect(result).not.toBeNull();
    expect(result!.signals.proactiveDismissRate).toBeCloseTo(0.5, 1);
  });
});
