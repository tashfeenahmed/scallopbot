import { describe, expect, it } from 'vitest';
import { hasMeasuredEvolutionImprovement, scoreEvolutionTrial } from './benchmark-score.js';

describe('isolated evolution benchmark score', () => {
  it('accepts a correctness and tool-use improvement', () => {
    const baseline = scoreEvolutionTrial({
      correct: false,
      verifierCalls: 0,
      successfulLoadBeforeCorrectVerification: false,
    });
    const candidate = scoreEvolutionTrial({
      correct: true,
      verifierCalls: 1,
      successfulLoadBeforeCorrectVerification: true,
    });
    expect(hasMeasuredEvolutionImprovement(baseline, candidate, true, true)).toBe(true);
    expect(candidate.total - baseline.total).toBe(2);
  });

  it('fails closed without correctness, promoted-procedure use, tool improvement, or delta', () => {
    const zero = scoreEvolutionTrial({
      correct: false,
      verifierCalls: 0,
      successfulLoadBeforeCorrectVerification: false,
    });
    const correctWithoutProcedure = scoreEvolutionTrial({
      correct: true,
      verifierCalls: 1,
      successfulLoadBeforeCorrectVerification: false,
    });

    expect(hasMeasuredEvolutionImprovement(zero, zero, false, false)).toBe(false);
    expect(hasMeasuredEvolutionImprovement(zero, correctWithoutProcedure, true, false)).toBe(false);
    expect(hasMeasuredEvolutionImprovement(correctWithoutProcedure, correctWithoutProcedure, true, true)).toBe(false);
  });
});
