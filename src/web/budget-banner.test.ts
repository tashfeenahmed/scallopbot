import { describe, expect, it } from 'vitest';
import { budgetBanner } from '../../web/src/hooks/budget-banner';
import type { CostData } from '../../web/src/hooks/useCosts';

const costs = (over: Partial<CostData> = {}): CostData => ({
  enabled: true,
  daily: { spent: 0, budget: null, remaining: null, exceeded: false, warning: false },
  monthly: { spent: 0, budget: null, remaining: null, exceeded: false, warning: false },
  topModels: [],
  totalRequests: 0,
  dailyHistory: [],
  ...over,
});

describe('budgetBanner', () => {
  it('stays silent without cost data or without budgets', () => {
    expect(budgetBanner(null)).toBeNull();
    expect(budgetBanner(costs())).toBeNull();
  });

  it('warns when nearing the daily cap', () => {
    const b = budgetBanner(costs({
      daily: { spent: 4.1, budget: 5, remaining: 0.9, exceeded: false, warning: true },
    }));
    expect(b?.tone).toBe('warning');
    expect(b?.text).toContain('daily spend limit');
    expect(b?.text).toContain('$4.10 of $5.00');
  });

  it('escalates to exceeded when the daily cap is hit', () => {
    const b = budgetBanner(costs({
      daily: { spent: 5.2, budget: 5, remaining: -0.2, exceeded: true, warning: true },
    }));
    expect(b?.tone).toBe('exceeded');
    expect(b?.text).toContain('will not answer');
  });

  it('prefers daily over monthly when both are exceeded', () => {
    const b = budgetBanner(costs({
      daily: { spent: 5.2, budget: 5, remaining: -0.2, exceeded: true, warning: true },
      monthly: { spent: 100, budget: 100, remaining: 0, exceeded: true, warning: true },
    }));
    expect(b?.text).toContain('Daily');
  });

  it('falls back to the monthly cap when only monthly is exceeded', () => {
    const b = budgetBanner(costs({
      monthly: { spent: 101, budget: 100, remaining: -1, exceeded: true, warning: true },
    }));
    expect(b?.tone).toBe('exceeded');
    expect(b?.text).toContain('Monthly');
    // The monthly cap resets on its own at the next UTC month, too.
    expect(b?.text).toContain('start of next month (UTC)');
    expect(b?.text).toContain('raise the limit in Costs');
  });

  it('ignores exceeded flags that have no budget set (defensive)', () => {
    const b = budgetBanner(costs({
      daily: { spent: 5, budget: null, remaining: null, exceeded: true, warning: false },
    }));
    expect(b).toBeNull();
  });
});
