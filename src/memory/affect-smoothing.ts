/**
 * Affect EMA smoothing layer.
 *
 * Dual-EMA (fast + slow) for valence and arousal, plus goal signal
 * derivation from EMA divergence. Reuses existing updateEMA() from
 * behavioral-signals.ts.
 *
 * Fast EMA (2h half-life): reacts to mood shifts within a session.
 * Slow EMA (3d half-life): tracks baseline mood over time.
 * Goal signal: derived from fast vs slow divergence to detect mood transitions.
 *
 * All functions are pure, stateless, synchronous. No database access,
 * no side effects.
 */

import { updateEMA } from './behavioral-signals.js';
import { mapToEmotion, type RawAffect, type EmotionLabel } from './affect.js';

// ============ Constants ============

/** Fast EMA half-life: 2 hours — reacts to mood shifts within a session */
const FAST_HALF_LIFE_MS = 7_200_000;

/** Slow EMA half-life: 3 days — tracks baseline mood */
const SLOW_HALF_LIFE_MS = 259_200_000;

/** Minimum confidence to update EMA — below this, no sentiment words found */
const MIN_CONFIDENCE = 0.1;

// ============ Types ============

/** State for dual-EMA affect tracking across all 4 channels */
export interface AffectEMAState {
  fastValence: number;
  slowValence: number;
  fastArousal: number;
  slowArousal: number;
  lastUpdateMs: number;
}

/** Goal signal derived from fast vs slow EMA divergence */
export type GoalSignal =
  | 'user_distressed'
  | 'user_improving'
  | 'user_engaged'
  | 'user_disengaged'
  | 'stable';

/** Smoothed affect output: EMA values + emotion label + goal signal */
export interface SmoothedAffect {
  valence: number;
  arousal: number;
  emotion: EmotionLabel;
  goalSignal: GoalSignal;
}

// ============ Functions ============

/**
 * Create initial affect EMA state with all zeros.
 * lastUpdateMs = 0 signals that no updates have been received yet.
 */
export function createInitialAffectState(): AffectEMAState {
  return {
    fastValence: 0,
    slowValence: 0,
    fastArousal: 0,
    slowArousal: 0,
    lastUpdateMs: 0,
  };
}

/**
 * Update affect EMA state with a new raw affect reading.
 *
 * - If rawAffect.confidence < MIN_CONFIDENCE → return state unchanged (no update)
 * - If state.lastUpdateMs === 0 (initial) → set all channels to raw values directly
 * - Otherwise → use updateEMA for each of 4 channels with respective half-lives
 *
 * @param state  Current EMA state
 * @param raw    Raw affect reading (needs valence, arousal, confidence)
 * @param nowMs  Current timestamp in milliseconds
 * @returns      New EMA state (never mutates input)
 */
export function updateAffectEMA(
  state: AffectEMAState,
  raw: Pick<RawAffect, 'valence' | 'arousal' | 'confidence'>,
  nowMs: number,
): AffectEMAState {
  // Confidence gate: skip low-confidence readings (no sentiment words found)
  if (raw.confidence < MIN_CONFIDENCE) {
    return state;
  }

  // Initial state: set all channels to raw values directly
  if (state.lastUpdateMs === 0) {
    return {
      fastValence: raw.valence,
      slowValence: raw.valence,
      fastArousal: raw.arousal,
      slowArousal: raw.arousal,
      lastUpdateMs: nowMs,
    };
  }

  // Compute time delta and update all 4 EMA channels
  const timeDelta = nowMs - state.lastUpdateMs;

  return {
    fastValence: updateEMA(raw.valence, state.fastValence, timeDelta, FAST_HALF_LIFE_MS),
    slowValence: updateEMA(raw.valence, state.slowValence, timeDelta, SLOW_HALF_LIFE_MS),
    fastArousal: updateEMA(raw.arousal, state.fastArousal, timeDelta, FAST_HALF_LIFE_MS),
    slowArousal: updateEMA(raw.arousal, state.slowArousal, timeDelta, SLOW_HALF_LIFE_MS),
    lastUpdateMs: nowMs,
  };
}

/**
 * Derive a goal signal from the current affect EMA state.
 *
 * Compares fast vs slow valence to detect mood transitions.
 * Priority order (first match wins):
 * 1. user_distressed: fast valence dropped below slow by threshold
 * 2. user_improving: fast valence rose above slow by threshold
 * 3. user_engaged: high fast arousal
 * 4. user_disengaged: low arousal + negative valence
 * 5. stable: default
 */
export function deriveGoalSignal(state: AffectEMAState): GoalSignal {
  const divergence = state.fastValence - state.slowValence;

  if (divergence < -0.15) return 'user_distressed';
  if (divergence > 0.15) return 'user_improving';
  if (state.fastArousal > 0.4) return 'user_engaged';
  if (state.fastArousal < -0.3 && state.fastValence < -0.1) return 'user_disengaged';

  return 'stable';
}

/**
 * Get smoothed affect from the current EMA state.
 *
 * Combines fast EMA values with emotion label (via mapToEmotion from affect.ts)
 * and goal signal (via deriveGoalSignal).
 */
export function getSmoothedAffect(state: AffectEMAState): SmoothedAffect {
  return {
    valence: state.fastValence,
    arousal: state.fastArousal,
    emotion: mapToEmotion(state.fastValence, state.fastArousal),
    goalSignal: deriveGoalSignal(state),
  };
}
