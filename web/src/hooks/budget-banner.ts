import type { CostData } from './useCosts';

export interface BudgetBanner {
  tone: 'warning' | 'exceeded';
  text: string;
}

/**
 * Decide whether the chat needs a budget warning. The cost dashboard shows
 * budget state, but a user mid-conversation never sees it until the bot
 * silently refuses to answer. Mirrors the server gate in
 * CostTracker.canMakeRequest (exceeded = blocked, warning = nearing the cap).
 * Returns null when nothing needs saying.
 */
export function budgetBanner(costs: CostData | null): BudgetBanner | null {
  if (!costs) return null;

  if (costs.daily.exceeded && costs.daily.budget != null) {
    return {
      tone: 'exceeded',
      text: `Daily spend limit reached ($${costs.daily.spent.toFixed(2)} of $${costs.daily.budget.toFixed(2)}). The bot will not answer until it resets at midnight UTC, or until you raise the limit in Costs.`,
    };
  }
  if (costs.monthly.exceeded && costs.monthly.budget != null) {
    return {
      tone: 'exceeded',
      text: `Monthly spend limit reached ($${costs.monthly.spent.toFixed(2)} of $${costs.monthly.budget.toFixed(2)}). The bot will not answer until you raise the limit in Costs.`,
    };
  }
  if (costs.daily.warning && costs.daily.budget != null) {
    return {
      tone: 'warning',
      text: `Approaching the daily spend limit ($${costs.daily.spent.toFixed(2)} of $${costs.daily.budget.toFixed(2)}).`,
    };
  }
  if (costs.monthly.warning && costs.monthly.budget != null) {
    return {
      tone: 'warning',
      text: `Approaching the monthly spend limit ($${costs.monthly.spent.toFixed(2)} of $${costs.monthly.budget.toFixed(2)}).`,
    };
  }
  return null;
}
