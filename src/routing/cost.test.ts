import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CostTracker,
  CostTrackerOptions,
  ModelPricing,
  UsageRecord,
  BudgetStatus,
} from './cost.js';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../providers/types.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create tracker with default options', () => {
      tracker = new CostTracker({});
      expect(tracker).toBeInstanceOf(CostTracker);
    });

    it('should create tracker with custom budget limits', () => {
      tracker = new CostTracker({
        dailyBudget: 10,
        monthlyBudget: 100,
        warningThreshold: 0.8,
      });
      expect(tracker.getDailyBudget()).toBe(10);
      expect(tracker.getMonthlyBudget()).toBe(100);
    });
  });

  describe('model pricing', () => {
    beforeEach(() => {
      tracker = new CostTracker({});
    });

    it('should return default pricing for known models', () => {
      const anthropicPricing = tracker.getModelPricing('claude-sonnet-4-20250514');
      expect(anthropicPricing).toBeDefined();
      expect(anthropicPricing.inputPerMillion).toBeGreaterThan(0);
      expect(anthropicPricing.outputPerMillion).toBeGreaterThan(0);
    });

    it('should allow custom model pricing', () => {
      tracker.setModelPricing('custom-model', {
        inputPerMillion: 1.0,
        outputPerMillion: 2.0,
      });

      const pricing = tracker.getModelPricing('custom-model');
      expect(pricing.inputPerMillion).toBe(1.0);
      expect(pricing.outputPerMillion).toBe(2.0);
    });

    it('should return zero pricing for unknown models', () => {
      const pricing = tracker.getModelPricing('unknown-model');
      expect(pricing.inputPerMillion).toBe(0);
      expect(pricing.outputPerMillion).toBe(0);
    });

    it('should log a warning for unknown models', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tracker.getModelPricing('totally-unknown-model');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('totally-unknown-model')
      );
      warnSpy.mockRestore();
    });

    it('should have pricing for xAI Grok models', () => {
      const grok4 = tracker.getModelPricing('grok-4');
      expect(grok4.inputPerMillion).toBe(3);
      expect(grok4.outputPerMillion).toBe(15);

      const grok3 = tracker.getModelPricing('grok-3');
      expect(grok3.inputPerMillion).toBe(3);
      expect(grok3.outputPerMillion).toBe(15);

      const grok2 = tracker.getModelPricing('grok-2');
      expect(grok2.inputPerMillion).toBe(2);
      expect(grok2.outputPerMillion).toBe(10);
    });

    it('should have pricing for newer Anthropic models', () => {
      const sonnet45 = tracker.getModelPricing('claude-sonnet-4-5-20250929');
      expect(sonnet45.inputPerMillion).toBe(3);
      expect(sonnet45.outputPerMillion).toBe(15);

      const opus4 = tracker.getModelPricing('claude-opus-4-20250514');
      expect(opus4.inputPerMillion).toBe(15);
      expect(opus4.outputPerMillion).toBe(75);
    });

    it('should have pricing for OpenRouter models', () => {
      const orSonnet = tracker.getModelPricing('anthropic/claude-3.5-sonnet');
      expect(orSonnet.inputPerMillion).toBe(6);
      expect(orSonnet.outputPerMillion).toBe(30);

      const orSonnet45 = tracker.getModelPricing('anthropic/claude-sonnet-4.5');
      expect(orSonnet45.inputPerMillion).toBe(3);
      expect(orSonnet45.outputPerMillion).toBe(15);
    });
  });

  describe('cost calculation', () => {
    beforeEach(() => {
      tracker = new CostTracker({});
    });

    it('should calculate cost from token usage', () => {
      const cost = tracker.calculateCost(
        'claude-sonnet-4-20250514',
        { inputTokens: 1000, outputTokens: 500 }
      );

      // Sonnet pricing: $3/M input, $15/M output
      // 1000 input = $0.003, 500 output = $0.0075
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('should return 0 for models with no pricing', () => {
      const cost = tracker.calculateCost(
        'unknown-model',
        { inputTokens: 1000000, outputTokens: 1000000 }
      );
      expect(cost).toBe(0);
    });

    it('should handle different model tiers', () => {
      const sonnetCost = tracker.calculateCost(
        'claude-sonnet-4-20250514',
        { inputTokens: 1000, outputTokens: 1000 }
      );

      const groqCost = tracker.calculateCost(
        'llama-3.3-70b-versatile',
        { inputTokens: 1000, outputTokens: 1000 }
      );

      // Groq should be cheaper than Anthropic
      expect(groqCost).toBeLessThan(sonnetCost);
    });
  });

  describe('usage recording', () => {
    beforeEach(() => {
      tracker = new CostTracker({});
    });

    it('should record usage with cost', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const usage = tracker.getUsageHistory();
      expect(usage).toHaveLength(1);
      expect(usage[0].model).toBe('claude-sonnet-4-20250514');
      expect(usage[0].cost).toBeGreaterThan(0);
    });

    it('should accumulate daily spending', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const dailySpend = tracker.getDailySpend();
      expect(dailySpend).toBeCloseTo(0.021, 4);
    });

    it('should accumulate monthly spending', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000000,
        outputTokens: 500000,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const monthlySpend = tracker.getMonthlySpend();
      expect(monthlySpend).toBeCloseTo(10.5, 1);
    });

    it('should track spending per session', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 2000,
        outputTokens: 1000,
        provider: 'anthropic',
        sessionId: 'session-2',
      });

      expect(tracker.getSessionSpend('session-1')).toBeCloseTo(0.0105, 4);
      expect(tracker.getSessionSpend('session-2')).toBeCloseTo(0.021, 4);
    });
  });

  describe('budget limits', () => {
    it('should check if daily budget is exceeded', () => {
      tracker = new CostTracker({
        dailyBudget: 0.01, // Very low budget for testing
      });

      // Record usage that exceeds budget
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isDailyBudgetExceeded()).toBe(true);
    });

    it('should check if monthly budget is exceeded', () => {
      tracker = new CostTracker({
        monthlyBudget: 0.01,
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isMonthlyBudgetExceeded()).toBe(true);
    });

    it('should return false when no budget set', () => {
      tracker = new CostTracker({});

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 10000000,
        outputTokens: 5000000,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isDailyBudgetExceeded()).toBe(false);
      expect(tracker.isMonthlyBudgetExceeded()).toBe(false);
    });
  });

  describe('warning threshold', () => {
    it('should trigger warning at 75% of daily budget', () => {
      tracker = new CostTracker({
        dailyBudget: 1.0,
        warningThreshold: 0.75,
      });

      // Record usage at 80% of budget
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 200000,
        outputTokens: 50000,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isDailyWarningTriggered()).toBe(true);
    });

    it('should not trigger warning below threshold', () => {
      tracker = new CostTracker({
        dailyBudget: 1.0,
        warningThreshold: 0.75,
      });

      // Record usage at ~10% of budget
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 20000,
        outputTokens: 5000,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isDailyWarningTriggered()).toBe(false);
    });

    it('should trigger warning at 75% of monthly budget', () => {
      tracker = new CostTracker({
        monthlyBudget: 10.0,
        warningThreshold: 0.75,
      });

      // Record usage at ~80% of budget
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 2000000,
        outputTokens: 500000,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.isMonthlyWarningTriggered()).toBe(true);
    });
  });

  describe('budget status', () => {
    it('should return comprehensive budget status', () => {
      tracker = new CostTracker({
        dailyBudget: 10.0,
        monthlyBudget: 100.0,
        warningThreshold: 0.75,
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const status = tracker.getBudgetStatus();

      expect(status.dailySpend).toBeGreaterThan(0);
      expect(status.monthlySpend).toBeGreaterThan(0);
      expect(status.dailyBudget).toBe(10.0);
      expect(status.monthlyBudget).toBe(100.0);
      expect(status.dailyRemaining).toBeLessThan(10.0);
      expect(status.monthlyRemaining).toBeLessThan(100.0);
      expect(status.isDailyExceeded).toBe(false);
      expect(status.isMonthlyExceeded).toBe(false);
      expect(status.isDailyWarning).toBe(false);
      expect(status.isMonthlyWarning).toBe(false);
    });
  });

  describe('day/month rollover', () => {
    it('should reset daily spend at midnight', () => {
      tracker = new CostTracker({});

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.getDailySpend()).toBeGreaterThan(0);

      // Move to next day
      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));

      expect(tracker.getDailySpend()).toBe(0);
    });

    it('should reset monthly spend at month start', () => {
      tracker = new CostTracker({});

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      expect(tracker.getMonthlySpend()).toBeGreaterThan(0);

      // Move to next month
      vi.setSystemTime(new Date('2024-02-01T00:00:00Z'));

      expect(tracker.getMonthlySpend()).toBe(0);
    });
  });

  describe('usage history', () => {
    beforeEach(() => {
      tracker = new CostTracker({});
    });

    it('should return usage history with timestamps', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const history = tracker.getUsageHistory();
      expect(history[0].timestamp).toBeInstanceOf(Date);
    });

    it('should filter history by date range', () => {
      // Record on day 1
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      // Move to day 2
      vi.setSystemTime(new Date('2024-01-16T12:00:00Z'));

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 2000,
        outputTokens: 1000,
        provider: 'anthropic',
        sessionId: 'session-2',
      });

      const day1Only = tracker.getUsageHistory({
        startDate: new Date('2024-01-15T00:00:00Z'),
        endDate: new Date('2024-01-15T23:59:59Z'),
      });

      expect(day1Only).toHaveLength(1);
      expect(day1Only[0].sessionId).toBe('session-1');
    });

    it('should filter history by provider', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      tracker.recordUsage({
        model: 'gpt-4o',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'openai',
        sessionId: 'session-2',
      });

      const anthropicOnly = tracker.getUsageHistory({ provider: 'anthropic' });
      expect(anthropicOnly).toHaveLength(1);
      expect(anthropicOnly[0].provider).toBe('anthropic');
    });
  });

  describe('check before request', () => {
    it('should allow request when under budget', () => {
      tracker = new CostTracker({
        dailyBudget: 10.0,
        monthlyBudget: 100.0,
      });

      const result = tracker.canMakeRequest();
      expect(result.allowed).toBe(true);
    });

    it('should deny request when daily budget exceeded', () => {
      tracker = new CostTracker({
        dailyBudget: 0.001,
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const result = tracker.canMakeRequest();
      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain('daily');
    });

    it('should deny request when monthly budget exceeded', () => {
      tracker = new CostTracker({
        monthlyBudget: 0.001,
      });

      tracker.recordUsage({
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
        provider: 'anthropic',
        sessionId: 'session-1',
      });

      const result = tracker.canMakeRequest();
      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain('monthly');
    });
  });

  describe('wrapProvider', () => {
    function createMockProvider(name: string, model: string): LLMProvider {
      return {
        name,
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 200 },
          model,
        } as CompletionResponse),
      };
    }

    beforeEach(() => {
      tracker = new CostTracker({});
    });

    it('should record usage automatically on each complete() call', async () => {
      const mock = createMockProvider('anthropic', 'claude-sonnet-4-20250514');
      const wrapped = tracker.wrapProvider(mock, 'test-session');

      await wrapped.complete({ messages: [{ role: 'user', content: 'hello' }] });

      const history = tracker.getUsageHistory();
      expect(history).toHaveLength(1);
      expect(history[0].model).toBe('claude-sonnet-4-20250514');
      expect(history[0].provider).toBe('anthropic');
      expect(history[0].sessionId).toBe('test-session');
      expect(history[0].inputTokens).toBe(500);
      expect(history[0].outputTokens).toBe(200);
      expect(history[0].cost).toBeGreaterThan(0);
    });

    it('should return the original response unchanged', async () => {
      const mock = createMockProvider('anthropic', 'claude-sonnet-4-20250514');
      const wrapped = tracker.wrapProvider(mock, 'test-session');

      const response = await wrapped.complete({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.content).toEqual([{ type: 'text', text: 'response' }]);
      expect(response.model).toBe('claude-sonnet-4-20250514');
      expect(response.usage.inputTokens).toBe(500);
    });

    it('should preserve provider name and isAvailable', () => {
      const mock = createMockProvider('xai', 'grok-4');
      const wrapped = tracker.wrapProvider(mock, 'test-session');

      expect(wrapped.name).toBe('xai');
      expect(wrapped.isAvailable()).toBe(true);
    });

    it('should record per-call usage with correct model (fixes fallback misattribution)', async () => {
      const provider1 = createMockProvider('groq', 'llama-3.3-70b-versatile');
      const provider2 = createMockProvider('anthropic', 'claude-sonnet-4-20250514');

      const wrapped1 = tracker.wrapProvider(provider1, 'session-1');
      const wrapped2 = tracker.wrapProvider(provider2, 'session-1');

      // Simulate: first call on groq, then fallback to anthropic
      await wrapped1.complete({ messages: [{ role: 'user', content: 'hi' }] });
      await wrapped2.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const history = tracker.getUsageHistory();
      expect(history).toHaveLength(2);
      expect(history[0].model).toBe('llama-3.3-70b-versatile');
      expect(history[0].provider).toBe('groq');
      expect(history[1].model).toBe('claude-sonnet-4-20250514');
      expect(history[1].provider).toBe('anthropic');

      // Groq should be cheaper than Anthropic
      expect(history[0].cost).toBeLessThan(history[1].cost);
    });

    it('should use "unknown" sessionId when none provided', async () => {
      const mock = createMockProvider('anthropic', 'claude-sonnet-4-20250514');
      const wrapped = tracker.wrapProvider(mock);

      await wrapped.complete({ messages: [{ role: 'user', content: 'hello' }] });

      const history = tracker.getUsageHistory();
      expect(history[0].sessionId).toBe('unknown');
    });
  });
});
