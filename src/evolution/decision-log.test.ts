import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { explainEvolution } from './decision-log.js';
import { ScallopDatabase } from '../memory/db.js';
import type { EvolutionSignal, EvolutionDecision } from './types.js';

describe('explainEvolution', () => {
  const now = 1_000_000_000_000;

  it('reports an empty corpus clearly', () => {
    const out = explainEvolution([], [], now);
    expect(out).toContain('Signal corpus: empty');
    expect(out).toContain('Optimizer: has not run yet');
  });

  it('summarizes the corpus by signal type', () => {
    const signals: EvolutionSignal[] = [
      { userId: 'u', at: now - 1000, type: 'reusable_task' },
      { userId: 'u', at: now - 2000, type: 'reusable_task' },
      { userId: 'u', at: now - 3000, type: 'skill_failure', targetSkill: 'web_search' },
    ];
    const out = explainEvolution(signals, [], now);
    expect(out).toContain('Signal corpus: 3 captured');
    expect(out).toContain('reusable multi-step tasks');
    expect(out).toContain('skill failures');
  });

  it('shows recent optimizer decisions newest-first', () => {
    const decisions: EvolutionDecision[] = [
      { at: now - 5000, stage: 'promote', outcome: 'promoted', target: 'scrape_sites' },
      { at: now - 1000, stage: 'verify', outcome: 'rejected', reason: 'below_threshold', target: 'foo' },
    ];
    const out = explainEvolution([], decisions, now);
    const verifyIdx = out.indexOf('rejected');
    const promoteIdx = out.indexOf('promoted');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(promoteIdx).toBeGreaterThan(-1);
    // newest (verify/rejected) listed before older (promote)
    expect(verifyIdx).toBeLessThan(promoteIdx);
  });
});

describe('evolution DB round-trip', () => {
  let db: ScallopDatabase;
  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('persists and reads back signals (newest first)', () => {
    db.recordEvolutionSignal({ userId: 'u', at: 100, type: 'reusable_task', toolCallCount: 6, criticScore: 0.9, detail: { preview: 'hi' } });
    db.recordEvolutionSignal({ userId: 'u', at: 200, type: 'skill_failure', targetSkill: 'web_search' });

    const rows = db.getRecentEvolutionSignals(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].at).toBe(200);
    expect(rows[0].type).toBe('skill_failure');
    expect(rows[0].targetSkill).toBe('web_search');
    expect(rows[1].toolCallCount).toBe(6);
    expect(rows[1].detail).toEqual({ preview: 'hi' });
  });

  it('persists and reads back decisions', () => {
    db.recordEvolutionDecision({ at: 50, stage: 'reflect', outcome: 'proposed', target: 'foo', detail: { kind: 'create_skill' } });
    const rows = db.getRecentEvolutionDecisions(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe('reflect');
    expect(rows[0].outcome).toBe('proposed');
    expect(rows[0].detail).toEqual({ kind: 'create_skill' });
  });

  it('prunes old signals', () => {
    db.recordEvolutionSignal({ userId: 'u', at: 100, type: 'low_quality' });
    db.recordEvolutionSignal({ userId: 'u', at: 5000, type: 'low_quality' });
    const pruned = db.pruneEvolutionSignals(1000);
    expect(pruned).toBe(1);
    expect(db.getRecentEvolutionSignals(10)).toHaveLength(1);
  });
});
