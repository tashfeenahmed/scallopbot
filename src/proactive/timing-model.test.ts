/**
 * Tests for Timing Model.
 *
 * Covers two exported functions:
 * 1. isInQuietHours — pure function for quiet hours detection with wrap-around
 * 2. computeDeliveryTime — pure function for optimal delivery time computation
 *
 * All tests use injectable `now` for deterministic timing.
 */

import { describe, it, expect } from 'vitest';
import {
  isInQuietHours,
  computeDeliveryTime,
  type TimingContext,
  type DeliveryTiming,
} from './timing-model.js';

// ============ Constants for test readability ============

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * Fixed "now" for deterministic tests.
 * 2024-01-15T12:00:00.000Z (Monday noon UTC)
 */
const NOW = 1_705_320_000_000;

// ============ Test Helpers ============

/** Create a TimingContext with sensible defaults */
function makeContext(overrides?: Partial<TimingContext>): TimingContext {
  return {
    userActiveHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    quietHours: { start: 2, end: 5 },
    lastProactiveAt: null,
    currentHour: 12,
    urgency: 'medium',
    now: NOW,
    ...overrides,
  };
}

// ============ isInQuietHours ============

describe('isInQuietHours', () => {
  it('returns true for hour within simple range (2-5 -> hour 3)', () => {
    expect(isInQuietHours(3, { start: 2, end: 5 })).toBe(true);
  });

  it('returns false for hour outside simple range (2-5 -> hour 10)', () => {
    expect(isInQuietHours(10, { start: 2, end: 5 })).toBe(false);
  });

  it('handles wrap-around (23-5 -> hour 1 is quiet, hour 10 is not)', () => {
    expect(isInQuietHours(1, { start: 23, end: 5 })).toBe(true);
    expect(isInQuietHours(10, { start: 23, end: 5 })).toBe(false);
  });

  it('start === end means no quiet hours (returns false)', () => {
    expect(isInQuietHours(3, { start: 5, end: 5 })).toBe(false);
    expect(isInQuietHours(5, { start: 5, end: 5 })).toBe(false);
  });
});

// ============ computeDeliveryTime ============

describe('computeDeliveryTime', () => {
  it('high urgency + not quiet -> urgent_now (now + 5 min)', () => {
    const ctx = makeContext({ urgency: 'high', currentHour: 12 });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('urgent_now');
    expect(result.deliverAt).toBe(NOW + 5 * MIN_MS);
  });

  it('high urgency + quiet hours -> next_morning (not urgent_now)', () => {
    const ctx = makeContext({
      urgency: 'high',
      currentHour: 3,
      quietHours: { start: 2, end: 5 },
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('next_morning');
    expect(result.strategy).not.toBe('urgent_now');
  });

  it('in quiet hours -> next_morning with deliverAt after quiet end', () => {
    const ctx = makeContext({
      currentHour: 3,
      quietHours: { start: 2, end: 5 },
      urgency: 'medium',
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('next_morning');
    // deliverAt should be at hour 5:00 (quiet end), which is 2 hours from hour 3
    expect(result.deliverAt).toBe(NOW + 2 * HOUR_MS);
  });

  it('in active hours -> active_hours (now + 15 min)', () => {
    const ctx = makeContext({
      currentHour: 14,
      urgency: 'medium',
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('active_hours');
    expect(result.deliverAt).toBe(NOW + 15 * MIN_MS);
  });

  it('outside active hours -> next_active at next active hour :00', () => {
    // currentHour 6 is before first active hour 9
    const ctx = makeContext({
      currentHour: 6,
      urgency: 'medium',
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('next_active');
    // Next active hour is 9, so 3 hours from hour 6
    expect(result.deliverAt).toBe(NOW + 3 * HOUR_MS);
  });

  it('empty activeHours -> uses defaults (9-21)', () => {
    const ctx = makeContext({
      userActiveHours: [],
      currentHour: 14,
      urgency: 'medium',
    });
    const result = computeDeliveryTime(ctx);

    // hour 14 is in default active hours [9-21], so should be active_hours
    expect(result.strategy).toBe('active_hours');
    expect(result.deliverAt).toBe(NOW + 15 * MIN_MS);
  });

  it('minimum gap enforced (pushes to lastProactive + 2h)', () => {
    const ctx = makeContext({
      currentHour: 14,
      urgency: 'medium',
      lastProactiveAt: NOW - 30 * MIN_MS, // 30 min ago (less than 2h gap)
    });
    const result = computeDeliveryTime(ctx);

    // Without gap: would be NOW + 15 min (active_hours)
    // With gap enforcement: must be at least lastProactiveAt + 2h
    const expectedMinGap = ctx.lastProactiveAt! + 2 * HOUR_MS;
    expect(result.deliverAt).toBe(expectedMinGap);
  });

  it('high urgency bypasses minimum gap', () => {
    const ctx = makeContext({
      currentHour: 14,
      urgency: 'high',
      lastProactiveAt: NOW - 30 * MIN_MS, // 30 min ago
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('urgent_now');
    expect(result.deliverAt).toBe(NOW + 5 * MIN_MS);
    // Should NOT be pushed to lastProactiveAt + 2h
    expect(result.deliverAt).toBeLessThan(ctx.lastProactiveAt! + 2 * HOUR_MS);
  });

  it('maximum deferral caps at now + 24h', () => {
    // Create a scenario where next_active would be far in the future
    // Active hours only at hour 23, current hour is 0, quiet 1-23
    // This would try to defer way past 24h
    const ctx = makeContext({
      userActiveHours: [23],
      currentHour: 0,
      quietHours: { start: 0, end: 0 }, // no quiet hours
      urgency: 'low',
      // Set lastProactiveAt such that gap enforcement pushes well beyond 24h
      lastProactiveAt: NOW + 22 * HOUR_MS,
    });
    const result = computeDeliveryTime(ctx);

    expect(result.deliverAt).toBeLessThanOrEqual(NOW + 24 * HOUR_MS);
  });

  it('next_active wraps around midnight correctly', () => {
    // Current hour 22, active hours are [8, 9, 10], next active is 8 tomorrow
    const ctx = makeContext({
      userActiveHours: [8, 9, 10],
      currentHour: 22,
      quietHours: { start: 0, end: 0 }, // no quiet hours
      urgency: 'low',
    });
    const result = computeDeliveryTime(ctx);

    expect(result.strategy).toBe('next_active');
    // From hour 22 to next hour 8 = 10 hours
    expect(result.deliverAt).toBe(NOW + 10 * HOUR_MS);
  });
});
