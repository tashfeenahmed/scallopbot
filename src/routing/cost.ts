/**
 * Cost Tracker
 * Tracks LLM usage costs with budget limits and warnings
 * Optionally persists to SQLite for durability across restarts.
 */

import type { ScallopDatabase } from '../memory/db.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';

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
  customPricing?: Record<string, ModelPricing>;
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

// Default pricing per million tokens.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-4-20250514': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-20250514': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-opus-20240229': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-3-haiku-20240307': { inputPerMillion: 0.25, outputPerMillion: 1.25 },

  // OpenAI — GPT-5.x
  'gpt-5.2': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.2-2025-12-11': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.2-chat': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.2-codex': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.2-pro': { inputPerMillion: 21, outputPerMillion: 168 },
  'gpt-5.1': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1-chat': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1-codex-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5-chat': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  'gpt-5-pro': { inputPerMillion: 15, outputPerMillion: 120 },
  // OpenAI — GPT-4.1
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  'gpt-4.1-nano': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // OpenAI — GPT-4o (legacy)
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-2024-08-06': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-2024-11-20': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o-mini-2024-07-18': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },
  // OpenAI — o-series reasoning
  'o3': { inputPerMillion: 2, outputPerMillion: 8 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'o3-pro': { inputPerMillion: 20, outputPerMillion: 80 },
  'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'o1': { inputPerMillion: 15, outputPerMillion: 60 },
  // OpenAI — Audio
  'gpt-audio': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-audio-mini': { inputPerMillion: 0.6, outputPerMillion: 2.4 },
  'gpt-4o-audio-preview': { inputPerMillion: 2.5, outputPerMillion: 10 },

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
  'qwen/qwen3.6-plus': { inputPerMillion: 0.325, outputPerMillion: 1.95 },
  'qwen/qwen3.6-plus-04-02': { inputPerMillion: 0.325, outputPerMillion: 1.95 },
  'qwen/qwen3.6-flash': { inputPerMillion: 0.1875, outputPerMillion: 1.125 },
  'qwen/qwen3.6-max-preview': { inputPerMillion: 1.04, outputPerMillion: 6.24 },
  'qwen/qwen3.6-max-preview-20260420': { inputPerMillion: 1.04, outputPerMillion: 6.24 },
  'qwen/qwen3.6-35b-a3b': { inputPerMillion: 0.14, outputPerMillion: 1 },
  'qwen/qwen3.6-35b-a3b-20260415': { inputPerMillion: 0.14, outputPerMillion: 1 },
  'qwen/qwen3.6-27b': { inputPerMillion: 0.285, outputPerMillion: 2.4 },
  'qwen/qwen3.6-27b-20260422': { inputPerMillion: 0.285, outputPerMillion: 2.4 },

  // Free/Local
  'llama3.2': { inputPerMillion: 0, outputPerMillion: 0 },
  'mistral': { inputPerMillion: 0, outputPerMillion: 0 },
  // Local/LAN LLMs (no API billing)
  'qwen3.6': { inputPerMillion: 0, outputPerMillion: 0 },
  'qwen3.6-27b': { inputPerMillion: 0, outputPerMillion: 0 },
  'qwen3.6-uncen': { inputPerMillion: 0, outputPerMillion: 0 },
  'qwen3.6-plus': { inputPerMillion: 0, outputPerMillion: 0 },
  'qwen3-coder': { inputPerMillion: 0, outputPerMillion: 0 },
  'glm4.7-flash': { inputPerMillion: 0, outputPerMillion: 0 },
};

const KNOWN_BILLABLE_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'groq',
  'moonshot',
  'xai',
  'openrouter',
]);

function normalizePricingKey(value: string): string {
  return value.trim().toLowerCase();
}

function pricingKeys(model: string, provider?: string): string[] {
  const normalizedModel = normalizePricingKey(model);
  const normalizedProvider = provider ? normalizePricingKey(provider) : undefined;
  return [
    normalizedProvider && `${normalizedProvider}/${normalizedModel}`,
    normalizedModel,
  ].filter((key): key is string => Boolean(key));
}

function isLocalOrCustomProvider(provider?: string): boolean {
  if (!provider) return false;
  const normalized = normalizePricingKey(provider);
  return normalized === 'ollama' || normalized.startsWith('local') || !KNOWN_BILLABLE_PROVIDERS.has(normalized);
}

export class CostTracker {
  private dailyBudget?: number;
  private monthlyBudget?: number;
  private warningThreshold: number;
  private customPricing: Map<string, ModelPricing> = new Map();
  private warnedUnknownModels: Set<string> = new Set();
  private usageHistory: UsageRecord[] = [];
  private db?: ScallopDatabase;

  constructor(options: CostTrackerOptions) {
    this.dailyBudget = options.dailyBudget;
    this.monthlyBudget = options.monthlyBudget;
    this.warningThreshold = options.warningThreshold ?? 0.75;
    this.db = options.db;
    for (const [key, pricing] of Object.entries(options.customPricing ?? {})) {
      this.customPricing.set(normalizePricingKey(key), pricing);
    }

    // Load only current billing period (last 31 days) from SQLite on startup
    if (this.db) {
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const rows = this.db.getCostUsageSince(thirtyOneDaysAgo);
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

  getModelPricing(model: string, provider?: string): ModelPricing {
    // Check custom pricing first
    for (const key of pricingKeys(model, provider)) {
      if (this.customPricing.has(key)) {
        return this.customPricing.get(key)!;
      }
    }

    // Check default pricing
    for (const key of pricingKeys(model, provider)) {
      if (key in DEFAULT_PRICING) {
        return DEFAULT_PRICING[key];
      }
    }

    const normalizedModel = normalizePricingKey(model);
    if (normalizedModel.endsWith(':free')) {
      return { inputPerMillion: 0, outputPerMillion: 0 };
    }

    if (isLocalOrCustomProvider(provider)) {
      return { inputPerMillion: 0, outputPerMillion: 0 };
    }

    // Unknown model - log warning (once per model) and return zero pricing
    if (!this.warnedUnknownModels.has(model)) {
      this.warnedUnknownModels.add(model);
      console.warn(`[CostTracker] Unknown model "${model}" - cost will be $0`);
    }
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

  setModelPricing(model: string, pricing: ModelPricing, provider?: string): void {
    const [key] = pricingKeys(model, provider);
    this.customPricing.set(key, pricing);
  }

  calculateCost(
    model: string,
    usage: { inputTokens: number; outputTokens: number },
    provider?: string
  ): number {
    const pricing = this.getModelPricing(model, provider);
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
    }, params.provider);

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

  /**
   * Record a concrete completion using the provider that actually served it.
   * Keeping this operation here prevents fallback call sites from accidentally
   * attributing usage to the initially selected (failed) provider.
   */
  recordResponse(response: CompletionResponse, provider: string, sessionId: string): void {
    this.recordUsage({
      model: response.model || provider,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      provider,
      sessionId,
    });
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
    const complete: LLMProvider['complete'] = async (request) => {
      const response = await provider.complete(request);
      this.recordResponse(
        response.model ? response : { ...response, model: provider.model || provider.name },
        provider.name,
        sessionId ?? 'unknown',
      );
      return response;
    };

    return {
      name: provider.name,
      model: provider.model,
      isAvailable: () => provider.isAvailable(),
      stream: provider.stream?.bind(provider),
      complete,
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
