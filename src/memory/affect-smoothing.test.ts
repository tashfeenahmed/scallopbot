/**
 * Tests for affect EMA smoothing layer.
 *
 * Dual-EMA (fast + slow) for valence and arousal, plus goal signal
 * derivation from EMA divergence. Reuses updateEMA() from behavioral-signals.ts.
 *
 * All functions are pure, stateless, synchronous.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialAffectState,
  updateAffectEMA,
  deriveGoalSignal,
  getSmoothedAffect,
  type AffectEMAState,
  type GoalSignal,
  type SmoothedAffect,
} from './affect-smoothing.js';

// ============ Constants for tests ============

const FAST_HALF_LIFE_MS = 7_200_000; // 2 hours
const SLOW_HALF_LIFE_MS = 259_200_000; // 3 days
const ONE_MINUTE = 60_000;
const ONE_HOUR = 3_600_000;
const ONE_DAY = 86_400_000;

// ============ createInitialAffectState ============

describe('createInitialAffectState', () => {
  it('returns all zeros with lastUpdateMs = 0', () => {
    const state = createInitialAffectState();
    expect(state).toEqual({
      fastValence: 0,
      slowValence: 0,
      fastArousal: 0,
      slowArousal: 0,
      lastUpdateMs: 0,
    });
  });
});

// ============ updateAffectEMA — initial state ============

describe('updateAffectEMA — initial state', () => {
  it('sets all channels to raw values on first update (lastUpdateMs === 0)', () => {
    const initial = createInitialAffectState();
    const raw = { valence: 0.6, arousal: 0.3, confidence: 0.8 };
    const nowMs = 1_000_000;

    const updated = updateAffectEMA(initial, raw, nowMs);

    expect(updated.fastValence).toBe(0.6);
    expect(updated.slowValence).toBe(0.6);
    expect(updated.fastArousal).toBe(0.3);
    expect(updated.slowArousal).toBe(0.3);
    expect(updated.lastUpdateMs).toBe(nowMs);
  });
});

// ============ updateAffectEMA — positive affect ============

describe('updateAffectEMA — positive affect updates', () => {
  it('produces positive EMA values after positive message', () => {
    const initial = createInitialAffectState();
    const raw = { valence: 0.7, arousal: 0.4, confidence: 0.5 };
    const nowMs = 1_000_000;

    const updated = updateAffectEMA(initial, raw, nowMs);

    expect(updated.fastValence).toBeGreaterThan(0);
    expect(updated.slowValence).toBeGreaterThan(0);
    expect(updated.fastArousal).toBeGreaterThan(0);
    expect(updated.slowArousal).toBeGreaterThan(0);
  });

  it('converges toward positive with multiple positive messages', () => {
    let state = createInitialAffectState();
    const raw = { valence: 0.8, arousal: 0.5, confidence: 0.6 };

    // Feed 10 positive messages, 5 minutes apart
    for (let i = 0; i < 10; i++) {
      state = updateAffectEMA(state, raw, 1_000_000 + i * 5 * ONE_MINUTE);
    }

    // Both fast and slow should be close to 0.8
    expect(state.fastValence).toBeGreaterThan(0.7);
    expect(state.slowValence).toBeGreaterThan(0.5);
    expect(state.fastArousal).toBeGreaterThan(0.4);
  });
});

// ============ updateAffectEMA — single negative after many positive ============

describe('updateAffectEMA — mood shift detection', () => {
  it('fast shifts quickly on negative message, slow barely moves', () => {
    let state = createInitialAffectState();
    const positive = { valence: 0.8, arousal: 0.3, confidence: 0.6 };

    // Build up a positive baseline: 20 messages over 2 days
    for (let i = 0; i < 20; i++) {
      state = updateAffectEMA(state, positive, 1_000_000 + i * 2 * ONE_HOUR);
    }

    const slowValenceBefore = state.slowValence;
    const fastValenceBefore = state.fastValence;

    // Now a single very negative message
    const negative = { valence: -0.9, arousal: 0.7, confidence: 0.8 };
    const afterNegativeMs = 1_000_000 + 20 * 2 * ONE_HOUR + 5 * ONE_MINUTE;
    state = updateAffectEMA(state, negative, afterNegativeMs);

    // Fast EMA should have shifted significantly toward negative
    const fastDrop = fastValenceBefore - state.fastValence;
    expect(fastDrop).toBeGreaterThan(0.3);

    // Slow EMA should have barely moved
    const slowDrop = slowValenceBefore - state.slowValence;
    expect(slowDrop).toBeLessThan(0.05);
  });
});

// ============ updateAffectEMA — confidence gating ============

describe('updateAffectEMA — confidence gating', () => {
  it('returns state unchanged when confidence < 0.1', () => {
    const initial = createInitialAffectState();
    const raw = { valence: 0.7, arousal: 0.4, confidence: 0.05 };
    const nowMs = 1_000_000;

    // First, set up a real state
    const baseRaw = { valence: 0.5, arousal: 0.2, confidence: 0.6 };
    const baseState = updateAffectEMA(initial, baseRaw, nowMs);

    // Now send a low confidence message
    const afterLowConfidence = updateAffectEMA(baseState, raw, nowMs + ONE_MINUTE);

    // State should be identical to before
    expect(afterLowConfidence).toEqual(baseState);
  });

  it('returns initial state unchanged when confidence < 0.1 and state is initial', () => {
    const initial = createInitialAffectState();
    const raw = { valence: 0.7, arousal: 0.4, confidence: 0.09 };

    const result = updateAffectEMA(initial, raw, 1_000_000);
    expect(result).toEqual(initial);
  });
});

// ============ deriveGoalSignal ============

describe('deriveGoalSignal', () => {
  it('returns user_distressed when fast < slow by 0.2', () => {
    const state: AffectEMAState = {
      fastValence: 0.1,
      slowValence: 0.5,
      fastArousal: 0.2,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };
    expect(deriveGoalSignal(state)).toBe('user_distressed');
  });

  it('returns user_improving when fast > slow by 0.2', () => {
    const state: AffectEMAState = {
      fastValence: 0.5,
      slowValence: 0.1,
      fastArousal: 0.2,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };
    expect(deriveGoalSignal(state)).toBe('user_improving');
  });

  it('returns user_engaged when fastArousal > 0.4', () => {
    const state: AffectEMAState = {
      fastValence: 0.3,
      slowValence: 0.3,
      fastArousal: 0.5,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };
    expect(deriveGoalSignal(state)).toBe('user_engaged');
  });

  it('returns user_disengaged when fastArousal < -0.3 and fastValence < -0.1', () => {
    const state: AffectEMAState = {
      fastValence: -0.2,
      slowValence: -0.2,
      fastArousal: -0.4,
      slowArousal: -0.1,
      lastUpdateMs: 1_000_000,
    };
    expect(deriveGoalSignal(state)).toBe('user_disengaged');
  });

  it('returns stable when fast and slow are similar', () => {
    const state: AffectEMAState = {
      fastValence: 0.3,
      slowValence: 0.25,
      fastArousal: 0.1,
      slowArousal: 0.1,
      lastUpdateMs: 1_000_000,
    };
    expect(deriveGoalSignal(state)).toBe('stable');
  });

  it('prioritizes distressed over engaged when both thresholds met', () => {
    const state: AffectEMAState = {
      fastValence: -0.1,
      slowValence: 0.5,
      fastArousal: 0.6,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };
    // Divergence = -0.1 - 0.5 = -0.6, which is < -0.15 → distressed takes priority
    expect(deriveGoalSignal(state)).toBe('user_distressed');
  });
});

// ============ getSmoothedAffect ============

describe('getSmoothedAffect', () => {
  it('returns correct shape with valence, arousal, emotion, and goalSignal', () => {
    const state: AffectEMAState = {
      fastValence: 0.5,
      slowValence: 0.3,
      fastArousal: 0.4,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };

    const result = getSmoothedAffect(state);

    expect(result).toHaveProperty('valence');
    expect(result).toHaveProperty('arousal');
    expect(result).toHaveProperty('emotion');
    expect(result).toHaveProperty('goalSignal');
    expect(result.valence).toBe(state.fastValence);
    expect(result.arousal).toBe(state.fastArousal);
    expect(typeof result.emotion).toBe('string');
    expect(typeof result.goalSignal).toBe('string');
  });

  it('derives emotion from fast EMA values using mapToEmotion', () => {
    const positiveHighArousal: AffectEMAState = {
      fastValence: 0.6,
      slowValence: 0.3,
      fastArousal: 0.5,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };

    const result = getSmoothedAffect(positiveHighArousal);
    // v>0, a>0.3 → 'excited'
    expect(result.emotion).toBe('excited');
  });

  it('derives goalSignal from state', () => {
    const distressedState: AffectEMAState = {
      fastValence: -0.1,
      slowValence: 0.5,
      fastArousal: 0.2,
      slowArousal: 0.2,
      lastUpdateMs: 1_000_000,
    };

    const result = getSmoothedAffect(distressedState);
    expect(result.goalSignal).toBe('user_distressed');
  });
});

// ============ Time gap behavior ============

describe('updateAffectEMA — time gap behavior', () => {
  it('converges faster with larger timeDelta', () => {
    // Set up a state with zero values
    const base: AffectEMAState = {
      fastValence: 0,
      slowValence: 0,
      fastArousal: 0,
      slowArousal: 0,
      lastUpdateMs: 1_000_000,
    };

    const raw = { valence: 1.0, arousal: 0.5, confidence: 0.8 };

    // Short time gap: 1 minute
    const shortGap = updateAffectEMA(base, raw, 1_000_000 + ONE_MINUTE);

    // Long time gap: 1 day
    const longGap = updateAffectEMA(base, raw, 1_000_000 + ONE_DAY);

    // Both fast EMAs should move toward 1.0, but long gap should move more
    expect(longGap.fastValence).toBeGreaterThan(shortGap.fastValence);

    // Slow EMAs should also respond more to longer gaps
    expect(longGap.slowValence).toBeGreaterThan(shortGap.slowValence);
  });
});
