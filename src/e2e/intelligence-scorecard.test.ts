import { describe, expect, it } from 'vitest';
import { buildIntelligenceScorecard, scoreMetric, scorecardMarkdown } from '../eval/intelligence-scorecard.js';

describe('intelligence improvement scorecard', () => {
  it('handles higher-is-better and lower-is-better metrics', () => {
    const recall = scoreMetric({
      id: 'recall', label: 'Recall', baseline: 0.5, candidate: 0.8, direction: 'higher', minDelta: 0.2,
    });
    expect(recall.passed).toBe(true);
    expect(recall.directionalDelta).toBeCloseTo(0.3);
    expect(recall.relativeImprovement).toBeCloseTo(0.6);
    expect(scoreMetric({
      id: 'tokens', label: 'Context tokens', baseline: 100, candidate: 40, direction: 'lower', minDelta: 50,
    })).toMatchObject({ directionalDelta: 60, passed: true, relativeImprovement: 0.6 });
  });

  it('builds an auditable markdown report without hiding regressions', () => {
    const scorecard = buildIntelligenceScorecard([
      { id: 'a', label: 'A', baseline: 0, candidate: 1, direction: 'higher', minDelta: 1 },
      { id: 'b', label: 'B', baseline: 1, candidate: 0.9, direction: 'higher', minDelta: 0 },
    ], '2026-01-01T00:00:00.000Z');
    expect(scorecard).toMatchObject({ passed: 1, failed: 1, passRate: 0.5 });
    const markdown = scorecardMarkdown(scorecard);
    expect(markdown).toContain('| A | 0 | 1 | 1 | PASS |');
    expect(markdown).toContain('| B | 1 | 0.900 | -0.100 | FAIL |');
  });

  it('rejects duplicate metric identifiers', () => {
    expect(() => buildIntelligenceScorecard([
      { id: 'same', label: 'A', baseline: 0, candidate: 1, direction: 'higher' },
      { id: 'same', label: 'B', baseline: 0, candidate: 1, direction: 'higher' },
    ])).toThrow(/Duplicate metric/);
  });
});
