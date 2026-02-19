/**
 * Exponential Moving Average (EMA) utilities.
 *
 * Generic time-series smoothing helpers used by behavioral signals,
 * affect smoothing, and trust score computation.
 */

/** Default EMA half-life: 7 days in milliseconds */
export const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compute an exponentially weighted moving average for irregular time series.
 *
 * weight = 1 - exp(-timeDelta / halfLife)
 * result = weight * currentValue + (1 - weight) * previousEMA
 *
 * When timeDelta is 0, weight is 0 and the result equals previousEMA.
 * When timeDelta >> halfLife, weight approaches 1 and the result approaches currentValue.
 */
export function updateEMA(
  currentValue: number,
  previousEMA: number,
  timeDeltaMs: number,
  halfLifeMs: number = DEFAULT_HALF_LIFE_MS,
): number {
  if (timeDeltaMs <= 0) {
    return previousEMA;
  }
  const weight = 1 - Math.exp(-timeDeltaMs / halfLifeMs);
  return weight * currentValue + (1 - weight) * previousEMA;
}

/**
 * Detect trend by splitting values in half and comparing averages.
 *
 * Returns 'stable' if fewer than 4 values.
 * Delta > 15% of first half average = 'increasing'.
 * Delta < -15% of first half average = 'decreasing'.
 * Otherwise 'stable'.
 */
export function detectTrend(values: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (values.length < 4) {
    return 'stable';
  }

  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((sum, v) => sum + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, v) => sum + v, 0) / secondHalf.length;

  // Avoid division by zero: if first half average is 0, compare absolute values
  if (firstAvg === 0) {
    if (secondAvg > 0) return 'increasing';
    if (secondAvg < 0) return 'decreasing';
    return 'stable';
  }

  const delta = (secondAvg - firstAvg) / Math.abs(firstAvg);

  if (delta > 0.15) return 'increasing';
  if (delta < -0.15) return 'decreasing';
  return 'stable';
}
