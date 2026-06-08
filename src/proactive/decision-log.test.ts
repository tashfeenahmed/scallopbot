import { describe, it, expect } from 'vitest';
import { explainProactiveDecisions, type ProactiveDecision } from './decision-log.js';

const NOW = 1_000_000_000;

function evalDecision(over: Partial<ProactiveDecision> = {}): ProactiveDecision {
  return { userId: 'default', at: NOW, stage: 'evaluate', outcome: 'skipped', ...over };
}

describe('explainProactiveDecisions', () => {
  it('handles the empty case with actionable guidance', () => {
    const out = explainProactiveDecisions([], NOW);
    expect(out).toMatch(/No proactive decisions have been recorded/);
    expect(out).toMatch(/UnifiedScheduler started/);
  });

  it('explains a cooldown gate and shows remaining time', () => {
    const d = evalDecision({
      reason: 'cooldown',
      detail: { dial: 'moderate', cooldownRemainingMs: 90 * 60 * 1000 },
    });
    const out = explainProactiveDecisions([d], NOW);
    expect(out).toMatch(/GATED at evaluation: cooldown/);
    expect(out).toMatch(/cooldown window/i);
    expect(out).toMatch(/Cooldown clears in ~1h 30m/);
  });

  it('explains no_signals (the most common silent cause) with the dial', () => {
    const d = evalDecision({ reason: 'no_signals', detail: { dial: 'moderate', signalsFound: 0, itemsCreated: 0 } });
    const out = explainProactiveDecisions([d], NOW);
    expect(out).toMatch(/nothing to be proactive about/);
    expect(out).toMatch(/dial 'moderate'/);
  });

  it('explains budget exhaustion with the cap', () => {
    const d = evalDecision({
      reason: 'budget_exhausted',
      detail: { dial: 'conservative', budgetCap: 1, todayItemCount: 1 },
    });
    const out = explainProactiveDecisions([d], NOW);
    expect(out).toMatch(/daily proactive budget/);
    expect(out).toMatch(/cap 1\/day/);
  });

  it('flags the LLM-skipped-all case', () => {
    const d = evalDecision({ reason: 'llm_skipped_all', detail: { dial: 'moderate', signalsFound: 2, itemsCreated: 0, llmCalled: true } });
    const out = explainProactiveDecisions([d], NOW);
    expect(out).toMatch(/LLM evaluator judged that none warranted/);
  });

  it('reports a healthy "working" verdict when items are created', () => {
    const d = evalDecision({ outcome: 'created', reason: undefined, detail: { dial: 'moderate', signalsFound: 1, itemsCreated: 1, llmCalled: true } });
    const out = explainProactiveDecisions([d], NOW);
    expect(out).toMatch(/Proactivity is working/);
  });

  it('attributes suppression at delivery (min-gap) over a successful evaluation', () => {
    const decisions: ProactiveDecision[] = [
      evalDecision({ at: NOW - 60_000, outcome: 'created', detail: { itemsCreated: 1 } }),
      { userId: 'default', at: NOW, stage: 'deliver', outcome: 'suppressed', reason: 'min_gap', detail: { itemId: 'x' } },
    ];
    const out = explainProactiveDecisions(decisions, NOW);
    expect(out).toMatch(/SUPPRESSED at delivery: min_gap/);
  });

  it('renders a recent-history tail newest-first', () => {
    const decisions: ProactiveDecision[] = [
      evalDecision({ at: NOW - 7200_000, reason: 'no_signals' }),
      evalDecision({ at: NOW - 60_000, reason: 'cooldown', detail: { cooldownRemainingMs: 1000 } }),
    ];
    const out = explainProactiveDecisions(decisions, NOW);
    const idxCooldown = out.indexOf('[cooldown]');
    const idxNoSignals = out.indexOf('[no_signals]');
    expect(idxCooldown).toBeGreaterThan(-1);
    expect(idxNoSignals).toBeGreaterThan(-1);
    expect(idxCooldown).toBeLessThan(idxNoSignals); // newest first
  });
});
