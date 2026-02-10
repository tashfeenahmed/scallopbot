/**
 * Trust score computation.
 *
 * Pure function that computes a 0.0-1.0 trust score from session data
 * and scheduled item outcomes, mapping to a proactiveness dial
 * (conservative/moderate/eager).
 *
 * Signal weights:
 * - sessionReturnRate: 0.25 (sessions per week, sigmoid-normalized)
 * - avgSessionDuration: 0.15 (EMA-smoothed, normalized)
 * - proactiveAcceptRate: 0.30 (direct trust signal)
 * - proactiveDismissRate: -0.20 (active rejection penalty)
 * - explicitFeedback: 0.10 (placeholder at 0.5 neutral)
 */

import { updateEMA } from './behavioral-signals.js';

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_HALF_LIFE_MS = 7 * DAY_MS;

/** Minimum sessions required before computing trust */
const COLD_START_SESSION_THRESHOLD = 5;

/** EMA smoothing weights for trust score stability */
const NEW_SCORE_WEIGHT = 0.3;
const EXISTING_SCORE_WEIGHT = 0.7;

/** Signal weights for weighted sum */
const WEIGHTS = {
  sessionReturnRate: 0.25,
  avgSessionDuration: 0.15,
  proactiveAcceptRate: 0.30,
  proactiveDismissRate: -0.20,
  explicitFeedback: 0.10,
} as const;

/** Duration normalization: 30 minutes = ~1.0 via sigmoid */
const DURATION_NORMALIZATION_MS = 30 * 60 * 1000;

// ============ Interfaces ============

export interface SessionInput {
  messageCount: number;
  durationMs: number;
  startTime: number;
}

export interface ScheduledItemInput {
  status: 'pending' | 'fired' | 'acted' | 'dismissed';
  source: string;
  firedAt?: number;
}

export interface TrustSignals {
  sessionReturnRate: number;
  avgSessionDuration: number;
  proactiveAcceptRate: number;
  proactiveDismissRate: number;
  explicitFeedback: number;
}

export interface TrustScoreResult {
  trustScore: number;
  proactivenessDial: 'conservative' | 'moderate' | 'eager';
  signals: TrustSignals;
}

export interface TrustScoreOptions {
  existingScore?: number;
}

// ============ Helpers ============

/**
 * Sigmoid normalization: maps x to (0, 1) range.
 * Uses steepness factor of 2 so that x=midpoint maps to ~0.88
 * and x=0 maps to ~0.12 (near zero).
 * 7 sessions/week (midpoint=7) gives ~0.88, 0 gives ~0.12.
 */
function sigmoid(x: number, midpoint: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(midpoint) || midpoint === 0) {
    return 0;
  }
  return 1 / (1 + Math.exp(-2 * (x / midpoint)));
}

/**
 * Map a trust score to a proactiveness dial.
 */
function mapDial(score: number): 'conservative' | 'moderate' | 'eager' {
  if (score < 0.3) return 'conservative';
  if (score >= 0.7) return 'eager';
  return 'moderate';
}

/**
 * Clamp a value to [0, 1] range.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ============ Signal Computations ============

/**
 * Compute session return rate: sessions per week, normalized to 0-1.
 * sigmoid(x/7) where 7 sessions/week = ~1.0
 */
function computeSessionReturnRate(sessions: SessionInput[]): number {
  const now = Date.now();
  const recentSessions = sessions.filter(
    (s) => now - s.startTime <= WEEK_MS,
  );
  const sessionsPerWeek = recentSessions.length;
  // sigmoid with midpoint=7: 7 sessions/week gives ~0.88
  return sigmoid(sessionsPerWeek, 7);
}

/**
 * Compute average session duration, EMA-smoothed and normalized.
 * Uses sigmoid normalization with 30 min as the midpoint.
 */
function computeAvgSessionDuration(sessions: SessionInput[]): number {
  const sorted = [...sessions].sort((a, b) => a.startTime - b.startTime);

  let emaDuration = sorted[0].durationMs;
  for (let i = 1; i < sorted.length; i++) {
    const timeDelta = sorted[i].startTime - sorted[i - 1].startTime;
    emaDuration = updateEMA(
      sorted[i].durationMs,
      emaDuration,
      timeDelta,
      DEFAULT_HALF_LIFE_MS,
    );
  }

  // Normalize: 30 min duration = ~0.5 via sigmoid
  return sigmoid(emaDuration, DURATION_NORMALIZATION_MS);
}

/**
 * Compute proactive accept rate: acted / actionable items.
 * Actionable = acted + dismissed + fired (not pending).
 * Returns 0.5 (neutral) if no actionable items.
 */
function computeProactiveAcceptRate(items: ScheduledItemInput[]): number {
  const actionable = items.filter(
    (i) => i.status === 'acted' || i.status === 'dismissed' || i.status === 'fired',
  );
  if (actionable.length === 0) return 0.5;

  const acted = actionable.filter((i) => i.status === 'acted').length;
  return acted / actionable.length;
}

/**
 * Compute proactive dismiss rate: dismissed / actionable items.
 * Returns 0.5 (neutral) if no actionable items.
 */
function computeProactiveDismissRate(items: ScheduledItemInput[]): number {
  const actionable = items.filter(
    (i) => i.status === 'acted' || i.status === 'dismissed' || i.status === 'fired',
  );
  if (actionable.length === 0) return 0.5;

  const dismissed = actionable.filter((i) => i.status === 'dismissed').length;
  return dismissed / actionable.length;
}

// ============ Main Function ============

/**
 * Compute trust score from session data and scheduled item outcomes.
 *
 * Returns null if insufficient data (cold start: fewer than 5 sessions).
 * Returns TrustScoreResult with score in [0, 1] range and proactiveness dial.
 *
 * Signal weights:
 * - sessionReturnRate: 0.25
 * - avgSessionDuration: 0.15
 * - proactiveAcceptRate: 0.30
 * - proactiveDismissRate: -0.20 (penalty)
 * - explicitFeedback: 0.10
 */
export function computeTrustScore(
  sessions: SessionInput[],
  scheduledItems: ScheduledItemInput[],
  options?: TrustScoreOptions,
): TrustScoreResult | null {
  // Cold start check
  if (sessions.length < COLD_START_SESSION_THRESHOLD) {
    return null;
  }

  // Compute individual signals
  const signals: TrustSignals = {
    sessionReturnRate: computeSessionReturnRate(sessions),
    avgSessionDuration: computeAvgSessionDuration(sessions),
    proactiveAcceptRate: computeProactiveAcceptRate(scheduledItems),
    proactiveDismissRate: computeProactiveDismissRate(scheduledItems),
    explicitFeedback: 0.5, // Placeholder — no explicit feedback mechanism yet
  };

  // Weighted sum
  const rawScore =
    WEIGHTS.sessionReturnRate * signals.sessionReturnRate +
    WEIGHTS.avgSessionDuration * signals.avgSessionDuration +
    WEIGHTS.proactiveAcceptRate * signals.proactiveAcceptRate +
    WEIGHTS.proactiveDismissRate * signals.proactiveDismissRate +
    WEIGHTS.explicitFeedback * signals.explicitFeedback;

  // Clamp to [0, 1]
  let trustScore = clamp01(rawScore);

  // EMA smoothing with existing score if provided
  if (options?.existingScore != null && Number.isFinite(options.existingScore)) {
    trustScore = NEW_SCORE_WEIGHT * trustScore + EXISTING_SCORE_WEIGHT * options.existingScore;
    trustScore = clamp01(trustScore);
  }

  return {
    trustScore,
    proactivenessDial: mapDial(trustScore),
    signals,
  };
}
