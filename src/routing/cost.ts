/**
 * Cost Tracker
 * Tracks LLM usage costs with budget limits and warnings
 * Optionally persists to SQLite for durability across restarts.
 */

import type { ScallopDatabase } from '../memory/db.js';
import type { LLMProvider } from '../providers/types.js';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  sessionId: string;
  cost: number;
  timestamp: Date;
}

export interface BudgetStatus {
  dailySpend: number;
  monthlySpend: number;
  dailyBudget: number | undefined;
  monthlyBudget: number | undefined;
  dailyRemaining: number | undefined;
  monthlyRemaining: number | undefined;
  isDailyExceeded: boolean;
  isMonthlyExceeded: boolean;
  isDailyWarning: boolean;
  isMonthlyWarning: boolean;
}

export interface CostTrackerOptions {
  dailyBudget?: number;
  monthlyBudget?: number;
  warningThreshold?: number;
  db?: ScallopDatabase;
}

export interface UsageHistoryFilter {
  startDate?: Date;
  endDate?: Date;
  provider?: string;
  sessionId?: string;
}

export interface RequestCheck {
  allowed: boolean;
  reason?: string;
}

// Default pricing per million tokens (as of 2024)
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-4-20250514': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-20250514': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-opus-20240229': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-3-haiku-20240307': { inputPerMillion: 0.25, outputPerMillion: 1.25 },

  // OpenAI
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },

  // xAI (Grok)
  'grok-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'grok-3': { inputPerMillion: 3, outputPerMillion: 15 },
  'grok-2': { inputPerMillion: 2, outputPerMillion: 10 },

  // Groq (Llama models)
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'llama-3.1-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'mixtral-8x7b-32768': { inputPerMillion: 0.24, outputPerMillion: 0.24 },

  // Moonshot (Kimi)
  'kimi-k2.5': { inputPerMillion: 0.6, outputPerMillion: 3 },
  'kimi-k2.5-thinking': { inputPerMillion: 0.6, outputPerMillion: 3 },
  'kimi-k2-0905': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  'kimi-k2-thinking': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  'moonshot-v1-128k': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  'moonshot-v1-32k': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  'moonshot-v1-8k': { inputPerMillion: 0.6, outputPerMillion: 2.5 },

  // OpenRouter
  'anthropic/claude-3.5-sonnet': { inputPerMillion: 6, outputPerMillion: 30 },
  'anthropic/claude-sonnet-4.5': { inputPerMillion: 3, outputPerMillion: 15 },

  // Free/Local
  'llama3.2': { inputPerMillion: 0, outputPerMillion: 0 },
  'mistral': { inputPerMillion: 0, outputPerMillion: 0 },
};

export class CostTracker {
  private dailyBudget?: number;
  private monthlyBudget?: number;
  private warningThreshold: number;
  private customPricing: Map<string, ModelPricing> = new Map();
  private usageHistory: UsageRecord[] = [];
  private db?: ScallopDatabase;

  constructor(options: CostTrackerOptions) {
    this.dailyBudget = options.dailyBudget;
    this.monthlyBudget = options.monthlyBudget;
    this.warningThreshold = options.warningThreshold ?? 0.75;
    this.db = options.db;

    // Load existing records from SQLite on startup
    if (this.db) {
      const rows = this.db.getCostUsageSince(0);
      for (const row of rows) {
        this.usageHistory.push({
          model: row.model,
          provider: row.provider,
          sessionId: row.sessionId,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cost: row.cost,
          timestamp: new Date(row.timestamp),
        });
      }
    }
  }

  getDailyBudget(): number | undefined {
    return this.dailyBudget;
  }

  getMonthlyBudget(): number | undefined {
    return this.monthlyBudget;
  }

  getModelPricing(model: string): ModelPricing {
    // Check custom pricing first
    if (this.customPricing.has(model)) {
      return this.customPricing.get(model)!;
    }

    // Check default pricing
    if (model in DEFAULT_PRICING) {
      return DEFAULT_PRICING[model];
    }

    // Unknown model - log warning and return zero pricing
    console.warn(`[CostTracker] Unknown model "${model}" - cost will be $0`);
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

  setModelPricing(model: string, pricing: ModelPricing): void {
    this.customPricing.set(model, pricing);
  }

  calculateCost(
    model: string,
    usage: { inputTokens: number; outputTokens: number }
  ): number {
    const pricing = this.getModelPricing(model);
    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    return inputCost + outputCost;
  }

  recordUsage(params: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    provider: string;
    sessionId: string;
  }): void {
    const cost = this.calculateCost(params.model, {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    });

    const record: UsageRecord = {
      ...params,
      cost,
      timestamp: new Date(),
    };

    this.usageHistory.push(record);

    // Persist to SQLite if available
    if (this.db) {
      this.db.recordCostUsage({
        model: params.model,
        provider: params.provider,
        sessionId: params.sessionId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cost,
        timestamp: record.timestamp.getTime(),
      });
    }
  }

  getDailySpend(): number {
    const today = this.getDateKey(new Date());
    return this.usageHistory
      .filter((r) => this.getDateKey(r.timestamp) === today)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  getMonthlySpend(): number {
    const thisMonth = this.getMonthKey(new Date());
    return this.usageHistory
      .filter((r) => this.getMonthKey(r.timestamp) === thisMonth)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  getSessionSpend(sessionId: string): number {
    return this.usageHistory
      .filter((r) => r.sessionId === sessionId)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  isDailyBudgetExceeded(): boolean {
    if (this.dailyBudget === undefined) return false;
    return this.getDailySpend() >= this.dailyBudget;
  }

  isMonthlyBudgetExceeded(): boolean {
    if (this.monthlyBudget === undefined) return false;
    return this.getMonthlySpend() >= this.monthlyBudget;
  }

  isDailyWarningTriggered(): boolean {
    if (this.dailyBudget === undefined) return false;
    return this.getDailySpend() >= this.dailyBudget * this.warningThreshold;
  }

  isMonthlyWarningTriggered(): boolean {
    if (this.monthlyBudget === undefined) return false;
    return this.getMonthlySpend() >= this.monthlyBudget * this.warningThreshold;
  }

  getBudgetStatus(): BudgetStatus {
    const dailySpend = this.getDailySpend();
    const monthlySpend = this.getMonthlySpend();

    return {
      dailySpend,
      monthlySpend,
      dailyBudget: this.dailyBudget,
      monthlyBudget: this.monthlyBudget,
      dailyRemaining:
        this.dailyBudget !== undefined ? this.dailyBudget - dailySpend : undefined,
      monthlyRemaining:
        this.monthlyBudget !== undefined ? this.monthlyBudget - monthlySpend : undefined,
      isDailyExceeded: this.isDailyBudgetExceeded(),
      isMonthlyExceeded: this.isMonthlyBudgetExceeded(),
      isDailyWarning: this.isDailyWarningTriggered(),
      isMonthlyWarning: this.isMonthlyWarningTriggered(),
    };
  }

  getUsageHistory(filter?: UsageHistoryFilter): UsageRecord[] {
    let records = [...this.usageHistory];

    if (filter) {
      if (filter.startDate) {
        records = records.filter((r) => r.timestamp >= filter.startDate!);
      }
      if (filter.endDate) {
        records = records.filter((r) => r.timestamp <= filter.endDate!);
      }
      if (filter.provider) {
        records = records.filter((r) => r.provider === filter.provider);
      }
      if (filter.sessionId) {
        records = records.filter((r) => r.sessionId === filter.sessionId);
      }
    }

    return records;
  }

  /**
   * Wrap an LLM provider so every complete() call automatically records usage.
   * Returns a proxy provider that behaves identically but tracks cost.
   */
  wrapProvider(provider: LLMProvider, sessionId?: string): LLMProvider {
    const tracker = this;
    return {
      name: provider.name,
      isAvailable: () => provider.isAvailable(),
      stream: provider.stream?.bind(provider),
      async complete(request) {
        const response = await provider.complete(request);
        tracker.recordUsage({
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          provider: provider.name,
          sessionId: sessionId ?? 'unknown',
        });
        return response;
      },
    };
  }

  canMakeRequest(): RequestCheck {
    if (this.isDailyBudgetExceeded()) {
      return {
        allowed: false,
        reason: `Daily budget exceeded: $${this.getDailySpend().toFixed(4)} / $${this.dailyBudget}`,
      };
    }

    if (this.isMonthlyBudgetExceeded()) {
      return {
        allowed: false,
        reason: `Monthly budget exceeded: $${this.getMonthlySpend().toFixed(4)} / $${this.monthlyBudget}`,
      };
    }

    return { allowed: true };
  }

  private getDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private getMonthKey(date: Date): string {
    return date.toISOString().slice(0, 7);
  }
}
