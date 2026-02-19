import { describe, it, expect } from 'vitest';
import { updateEMA, detectTrend, DEFAULT_HALF_LIFE_MS } from './ema.js';

describe('updateEMA', () => {
  it('returns previousEMA when timeDelta is 0', () => {
    expect(updateEMA(100, 50, 0)).toBe(50);
  });

  it('returns previousEMA when timeDelta is negative', () => {
    expect(updateEMA(100, 50, -1000)).toBe(50);
  });

  it('approaches currentValue for very large timeDelta', () => {
    const result = updateEMA(100, 0, DEFAULT_HALF_LIFE_MS * 100);
    expect(result).toBeCloseTo(100, 0);
  });

  it('blends values for moderate timeDelta', () => {
    const result = updateEMA(100, 0, DEFAULT_HALF_LIFE_MS);
    // weight = 1 - exp(-1) ≈ 0.632
    expect(result).toBeCloseTo(63.2, 0);
  });

  it('uses custom halfLife when provided', () => {
    const halfLife = 1000;
    // timeDelta = halfLife → weight = 1 - exp(-1) ≈ 0.632
    const result = updateEMA(100, 0, halfLife, halfLife);
    expect(result).toBeCloseTo(63.2, 0);
  });
});

describe('detectTrend', () => {
  it('returns stable for fewer than 4 values', () => {
    expect(detectTrend([])).toBe('stable');
    expect(detectTrend([1])).toBe('stable');
    expect(detectTrend([1, 2])).toBe('stable');
    expect(detectTrend([1, 2, 3])).toBe('stable');
  });

  it('detects increasing trend', () => {
    expect(detectTrend([1, 1, 5, 5])).toBe('increasing');
    expect(detectTrend([1, 2, 10, 20])).toBe('increasing');
  });

  it('detects decreasing trend', () => {
    expect(detectTrend([10, 10, 1, 1])).toBe('decreasing');
    expect(detectTrend([20, 15, 3, 2])).toBe('decreasing');
  });

  it('returns stable for flat values', () => {
    expect(detectTrend([5, 5, 5, 5])).toBe('stable');
  });

  it('returns stable for small fluctuations within 15%', () => {
    expect(detectTrend([10, 10, 11, 11])).toBe('stable');
  });

  it('handles zero first half average', () => {
    expect(detectTrend([0, 0, 5, 5])).toBe('increasing');
    expect(detectTrend([0, 0, -1, -1])).toBe('decreasing');
    expect(detectTrend([0, 0, 0, 0])).toBe('stable');
  });
});

describe('DEFAULT_HALF_LIFE_MS', () => {
  it('is 7 days in milliseconds', () => {
    expect(DEFAULT_HALF_LIFE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
