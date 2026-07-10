/** Small, deterministic scorecard for before/after intelligence experiments. */

export type MetricDirection = 'higher' | 'lower';

export interface ImprovementMetric {
  id: string;
  label: string;
  baseline: number;
  candidate: number;
  direction: MetricDirection;
  /** Minimum absolute directional improvement required. */
  minDelta?: number;
  unit?: string;
  evidence?: string;
}
export interface ScoredMetric extends ImprovementMetric {
  directionalDelta: number;
  relativeImprovement: number | null;
  passed: boolean;
}

export interface IntelligenceScorecard {
  generatedAt: string;
  metrics: ScoredMetric[];
  passed: number;
  failed: number;
  passRate: number;
}

export function scoreMetric(metric: ImprovementMetric): ScoredMetric {
  if (!Number.isFinite(metric.baseline) || !Number.isFinite(metric.candidate)) {
    throw new Error(`Metric '${metric.id}' has a non-finite value`);
  }
  const directionalDelta = metric.direction === 'higher'
    ? metric.candidate - metric.baseline
    : metric.baseline - metric.candidate;
  const relativeImprovement = metric.baseline === 0
    ? null
    : directionalDelta / Math.abs(metric.baseline);
  return {
    ...metric,
    directionalDelta,
    relativeImprovement,
    passed: directionalDelta >= (metric.minDelta ?? 0),
  };
}

export function buildIntelligenceScorecard(
  metrics: ImprovementMetric[],
  generatedAt = new Date().toISOString(),
): IntelligenceScorecard {
  const ids = new Set<string>();
  for (const metric of metrics) {
    if (ids.has(metric.id)) throw new Error(`Duplicate metric id '${metric.id}'`);
    ids.add(metric.id);
  }
  const scored = metrics.map(scoreMetric);
  const passed = scored.filter(metric => metric.passed).length;
  const failed = scored.length - passed;
  return {
    generatedAt,
    metrics: scored,
    passed,
    failed,
    passRate: scored.length === 0 ? 0 : passed / scored.length,
  };
}

function displayNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function scorecardMarkdown(scorecard: IntelligenceScorecard): string {
  const lines = [
    '# Intelligence Improvement Scorecard',
    '',
    `Generated: ${scorecard.generatedAt}`,
    '',
    '| Metric | Baseline | Candidate | Directional delta | Result |',
    '|---|---:|---:|---:|---|',
  ];
  for (const metric of scorecard.metrics) {
    const unit = metric.unit ? ` ${metric.unit}` : '';
    lines.push(`| ${metric.label} | ${displayNumber(metric.baseline)}${unit} | ${displayNumber(metric.candidate)}${unit} | ${displayNumber(metric.directionalDelta)}${unit} | ${metric.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', `Overall: ${scorecard.passed}/${scorecard.metrics.length} passed (${(scorecard.passRate * 100).toFixed(1)}%).`);
  return lines.join('\n');
}
