import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { CostTracker } from './cost.js';
import { buildTierMapping, Router } from './router.js';

function provider(name: string, implementation?: () => Promise<CompletionResponse>): LLMProvider {
  return {
    name,
    isAvailable: () => true,
    complete: vi.fn(implementation ?? (async () => ({
      content: [{ type: 'text', text: name }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: name,
    }))),
  };
}

const REQUEST = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe('routing quality metrics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('increases tier-choice differentiation from one first choice to three', async () => {
    const order = ['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama'];
    const legacy = { fast: order, standard: order, capable: order };
    const improved = buildTierMapping(order);

    const legacyDistinctFirstChoices = new Set(Object.values(legacy).map((chain) => chain[0])).size;
    const improvedDistinctFirstChoices = new Set(Object.values(improved).map((chain) => chain[0])).size;

    expect({ legacyDistinctFirstChoices, improvedDistinctFirstChoices }).toEqual({
      legacyDistinctFirstChoices: 1,
      improvedDistinctFirstChoices: 3,
    });
    expect(improved.fast[0]).toBe('groq');
    expect(improved.standard[0]).toBe('moonshot');
    expect(improved.capable[0]).toBe('anthropic');

    const router = new Router({ providerOrder: order });
    for (const name of order) router.registerProvider(provider(name));
    await expect(router.selectProvider('fast')).resolves.toMatchObject({ name: 'groq' });
    await expect(router.selectProvider('standard')).resolves.toMatchObject({ name: 'moonshot' });
    await expect(router.selectProvider('capable')).resolves.toMatchObject({ name: 'anthropic' });
  });

  it('preserves an explicitly configured custom/local provider as every tier primary', () => {
    const mapping = buildTierMapping(['localp40', 'moonshot', 'anthropic', 'groq']);
    expect(mapping.fast[0]).toBe('localp40');
    expect(mapping.standard[0]).toBe('localp40');
    expect(mapping.capable[0]).toBe('localp40');
  });

  it('clears accumulated completion failures immediately after a success', async () => {
    let shouldFail = true;
    const primary = provider('primary', async () => {
      if (shouldFail) throw new Error('temporary outage');
      return {
        content: [{ type: 'text', text: 'recovered' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'primary',
      };
    });
    const fallback = provider('fallback');
    const router = new Router({
      providerOrder: ['primary', 'fallback'],
      tierMapping: {
        fast: ['primary', 'fallback'],
        standard: ['primary', 'fallback'],
        capable: ['primary', 'fallback'],
      },
      unhealthyThreshold: 3,
    });
    router.registerProvider(primary);
    router.registerProvider(fallback);

    await router.executeWithFallback(REQUEST, 'fast');
    await router.executeWithFallback(REQUEST, 'fast');
    expect(router.getProviderHealth('primary')?.consecutiveFailures).toBe(2);

    shouldFail = false;
    const result = await router.executeWithFallback(REQUEST, 'fast');
    expect(result.provider).toBe('primary');
    expect(router.getProviderHealth('primary')).toMatchObject({
      isHealthy: true,
      consecutiveFailures: 0,
    });
  });

  it('skips an unhealthy provider during cooldown, then probes and recovers it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00Z'));

    let shouldFail = true;
    const primary = provider('primary', async () => {
      if (shouldFail) throw new Error('temporary outage');
      return {
        content: [{ type: 'text', text: 'recovered' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'primary',
      };
    });
    const fallback = provider('fallback');
    const router = new Router({
      providerOrder: ['primary', 'fallback'],
      tierMapping: {
        fast: ['primary', 'fallback'],
        standard: ['primary', 'fallback'],
        capable: ['primary', 'fallback'],
      },
      unhealthyThreshold: 1,
      healthRecoveryMs: 1_000,
    });
    router.registerProvider(primary);
    router.registerProvider(fallback);

    await router.executeWithFallback(REQUEST, 'fast');
    expect(router.getProviderHealth('primary')).toMatchObject({
      isHealthy: false,
      consecutiveFailures: 1,
    });
    expect(router.getProviderHealth('primary')?.unhealthySince).toBeInstanceOf(Date);

    await router.executeWithFallback(REQUEST, 'fast');
    expect(primary.complete).toHaveBeenCalledTimes(1);

    shouldFail = false;
    vi.advanceTimersByTime(1_001);
    const recovered = await router.executeWithFallback(REQUEST, 'fast');

    expect(recovered.provider).toBe('primary');
    expect(primary.complete).toHaveBeenCalledTimes(2);
    expect(router.getProviderHealth('primary')).toMatchObject({
      isHealthy: true,
      consecutiveFailures: 0,
    });
  });

  it('attributes fallback response cost to the provider that actually served it', () => {
    const tracker = new CostTracker({});
    const response: CompletionResponse = {
      content: [{ type: 'text', text: 'fallback answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1_000, outputTokens: 500 },
      model: 'gpt-4o',
    };

    tracker.recordResponse(response, 'openai', 'session-1');

    expect(tracker.getUsageHistory()).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o',
        sessionId: 'session-1',
        cost: 0.0075,
      }),
    ]);
  });

  it('can exclude the already-failed active provider from fallback retry', async () => {
    const failed = provider('failed', async () => { throw new Error('still offline'); });
    const fallback = provider('fallback');
    const router = new Router({
      providerOrder: ['failed', 'fallback'],
      tierMapping: {
        fast: ['failed', 'fallback'],
        standard: ['failed', 'fallback'],
        capable: ['failed', 'fallback'],
      },
    });
    router.registerProvider(failed);
    router.registerProvider(fallback);

    const result = await router.executeWithFallback(REQUEST, 'fast', {
      excludeProviders: ['failed'],
    });

    expect(result).toMatchObject({ provider: 'fallback', attemptedProviders: ['fallback'] });
    expect(failed.complete).not.toHaveBeenCalled();
  });
});
