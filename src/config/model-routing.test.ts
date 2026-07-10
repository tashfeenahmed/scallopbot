import { describe, it, expect, vi } from 'vitest';
import {
  parseModelRef,
  describeModelRef,
  PurposeRouter,
  type ModelsConfig,
} from './model-routing.js';
import { ProviderRegistry } from '../providers/registry.js';
import { buildTierMapping, Router } from '../routing/router.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

function mockProvider(name: string, available = true): LLMProvider {
  return {
    name,
    isAvailable: () => available,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: name }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: name,
    } as CompletionResponse),
  };
}

/** Like mockProvider but its complete() always rejects — simulates an outage
 *  (e.g. the local P40 box being down) while still reporting isAvailable. */
function failingProvider(name: string, error = 'ECONNREFUSED'): LLMProvider {
  return {
    name,
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(new Error(error)),
  };
}

/** Build a registry + router from explicit provider instances (lets a test mix
 *  succeeding and failing providers while preserving PROVIDER_ORDER). */
function harnessFrom(providers: LLMProvider[]) {
  const order = providers.map((p) => p.name);
  const registry = new ProviderRegistry();
  const router = new Router({
    providerOrder: order,
    tierMapping: buildTierMapping(order),
  });
  for (const p of providers) {
    registry.registerProvider(p);
    router.registerProvider(p);
  }
  return { registry, router };
}

/** Build a registry + router wired identically to the gateway. */
function harness(order: string[], available: Record<string, boolean> = {}) {
  const registry = new ProviderRegistry();
  const router = new Router({
    providerOrder: order,
    tierMapping: buildTierMapping(order),
  });
  for (const name of order) {
    const p = mockProvider(name, available[name] ?? true);
    registry.registerProvider(p);
    router.registerProvider(p);
  }
  return { registry, router };
}

const DEFAULT_MODELS: ModelsConfig = {
  reranker: { tier: 'fast' },
  factExtraction: { use: 'background' },
  cognition: { tier: 'fast' },
  critic: { use: 'main' },
  evolution: { use: 'main' },
  eval: { provider: 'moonshot', model: 'kimi-k2.5' },
};

describe('parseModelRef', () => {
  it('parses sentinel uses', () => {
    expect(parseModelRef('main')).toEqual({ use: 'main' });
    expect(parseModelRef('background')).toEqual({ use: 'background' });
  });

  it('parses tiers', () => {
    expect(parseModelRef('tier:fast')).toEqual({ tier: 'fast' });
    expect(parseModelRef('tier:capable')).toEqual({ tier: 'capable' });
  });

  it('rejects unknown tiers', () => {
    expect(parseModelRef('tier:turbo')).toBeUndefined();
  });

  it('parses bare provider and provider:model', () => {
    expect(parseModelRef('groq')).toEqual({ provider: 'groq' });
    expect(parseModelRef('moonshot:kimi-k2.5')).toEqual({ provider: 'moonshot', model: 'kimi-k2.5' });
  });

  it('preserves colons inside a model id', () => {
    expect(parseModelRef('openrouter:anthropic/claude-3.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5',
    });
  });

  it('returns undefined for empty input', () => {
    expect(parseModelRef(undefined)).toBeUndefined();
    expect(parseModelRef('   ')).toBeUndefined();
  });
});

describe('describeModelRef', () => {
  it('renders each variant', () => {
    expect(describeModelRef({ use: 'main' })).toBe('main');
    expect(describeModelRef({ tier: 'fast' })).toBe('tier:fast');
    expect(describeModelRef({ provider: 'groq' })).toBe('groq');
    expect(describeModelRef({ provider: 'moonshot', model: 'kimi-k2.5' })).toBe('moonshot:kimi-k2.5');
  });
});

describe('PurposeRouter — behavior preservation', () => {
  const order = ['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama'];

  it("reranker/cognition resolve to the fast tier (== prior router.selectProvider('fast'))", async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    const direct = await router.selectProvider('fast');
    expect((await pr.providerFor('reranker'))?.name).toBe(direct?.name);
    expect((await pr.providerFor('cognition'))?.name).toBe(direct?.name);
  });

  it('factExtraction picks the 2nd non-local provider (== prior inline heuristic)', async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    // order without ollama: moonshot, anthropic, openai, groq, xai → 2nd is anthropic
    expect((await pr.providerFor('factExtraction'))?.name).toBe('anthropic');
  });

  it('factExtraction falls back to 1st non-local when only one cloud provider exists', async () => {
    const { registry, router } = harness(['ollama', 'groq']);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    expect((await pr.providerFor('factExtraction'))?.name).toBe('groq');
  });

  it('main resolves to the default (first available) provider', async () => {
    const { registry, router } = harness(order, { moonshot: false });
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    // first available in registration order is anthropic
    expect((await pr.providerFor('critic'))?.name).toBe('anthropic');
    expect((await pr.providerFor('evolution'))?.name).toBe('anthropic');
  });
});

describe('PurposeRouter — overrides', () => {
  const order = ['moonshot', 'anthropic', 'groq'];

  it('honors an explicit provider pin', async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter({ ...DEFAULT_MODELS, evolution: { provider: 'groq' } }, registry, router);
    expect((await pr.providerFor('evolution'))?.name).toBe('groq');
  });

  it('degrades a pinned-but-unavailable provider to the main chain', async () => {
    const { registry, router } = harness(order, { groq: false });
    const pr = new PurposeRouter({ ...DEFAULT_MODELS, evolution: { provider: 'groq' } }, registry, router);
    // groq unavailable → falls back to default available provider (moonshot)
    expect((await pr.providerFor('evolution'))?.name).toBe('moonshot');
  });

  it('exposes the pinned model id via modelFor', () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    expect(pr.modelFor('eval')).toBe('kimi-k2.5');
    expect(pr.modelFor('reranker')).toBeUndefined();
  });
});

describe('PurposeRouter — runtime /model switch', () => {
  const order = ['moonshot', 'anthropic', 'groq'];

  it('moves every non-pinned purpose to the runtime model', async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(), () => 'groq');
    // cognition defaults to fast tier, factExtraction to background — both follow the switch
    expect((await pr.providerFor('cognition'))?.name).toBe('groq');
    expect((await pr.providerFor('factExtraction'))?.name).toBe('groq');
    expect(pr.refFor('cognition')).toEqual({ provider: 'groq' });
  });

  it('does NOT move a pinned purpose (memory/tools carve-out)', async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(
      { ...DEFAULT_MODELS, factExtraction: { provider: 'anthropic' } },
      registry,
      router,
      new Set(['factExtraction']),
      () => 'groq',
    );
    expect((await pr.providerFor('factExtraction'))?.name).toBe('anthropic'); // pinned: ignores switch
    expect((await pr.providerFor('cognition'))?.name).toBe('groq'); // non-pinned: follows switch
  });

  it('falls back to configured defaults when the switch is unset', async () => {
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(), () => undefined);
    const fast = await router.selectProvider('fast');
    expect((await pr.providerFor('cognition'))?.name).toBe(fast?.name);
  });
});

describe('PurposeRouter — dynamicProviderFor (live switch, no restart)', () => {
  const order = ['moonshot', 'anthropic', 'groq'];

  it('re-resolves the target on every call', async () => {
    let runtime: string | undefined = undefined;
    const { registry, router } = harness(order);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(), () => runtime);
    const dyn = pr.dynamicProviderFor('cognition');

    // No override → fast tier (Groq is the fast primary)
    const first = await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect((first.content[0] as { text: string }).text).toBe('groq');

    // Flip the switch at runtime → the SAME wrapper now routes to Anthropic
    runtime = 'anthropic';
    const second = await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect((second.content[0] as { text: string }).text).toBe('anthropic');

    expect(dyn.isAvailable()).toBe(true);
  });
});

describe('PurposeRouter — background cascade fallback (local → cloud)', () => {
  it('providersFor returns the resolved primary then the rest of PROVIDER_ORDER', async () => {
    const { registry, router } = harnessFrom([mockProvider('localp40'), mockProvider('cloud'), mockProvider('lastresort')]);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    // cognition → fast tier → first available (localp40), then the remaining order
    const chain = await pr.providersFor('cognition');
    expect(chain.map((p) => p.name)).toEqual(['localp40', 'cloud', 'lastresort']);
  });

  it('a non-pinned purpose fails over to the next provider when the primary throws', async () => {
    const cloud = mockProvider('cloud');
    const { registry, router } = harnessFrom([failingProvider('localp40'), cloud]);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    const dyn = pr.dynamicProviderFor('cognition'); // non-pinned (proactivity)
    const res = await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect((res.content[0] as { text: string }).text).toBe('cloud');
  });

  it('shares failure health so repeated jobs stop hammering an unhealthy primary', async () => {
    const local = failingProvider('localp40');
    const cloud = mockProvider('cloud');
    const registry = new ProviderRegistry();
    const router = new Router({
      providerOrder: ['localp40', 'cloud'],
      tierMapping: {
        fast: ['localp40', 'cloud'],
        standard: ['localp40', 'cloud'],
        capable: ['localp40', 'cloud'],
      },
      unhealthyThreshold: 1,
    });
    for (const p of [local, cloud]) {
      registry.registerProvider(p);
      router.registerProvider(p);
    }
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    const dyn = pr.dynamicProviderFor('cognition');

    await dyn.complete({ messages: [{ role: 'user', content: 'first job' }] });
    await dyn.complete({ messages: [{ role: 'user', content: 'second job' }] });

    // Legacy behavior called the broken local endpoint on every background job.
    // Shared Router health reduces two outage calls to one, then uses cloud.
    expect(local.complete).toHaveBeenCalledTimes(1);
    expect(cloud.complete).toHaveBeenCalledTimes(2);
    expect(router.getProviderHealth('localp40')?.isHealthy).toBe(false);
  });

  it('uses the primary and never touches the fallback when the primary succeeds', async () => {
    const cloud = mockProvider('cloud');
    const { registry, router } = harnessFrom([mockProvider('localp40'), cloud]);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    const dyn = pr.dynamicProviderFor('cognition'); // non-pinned (proactivity)
    const res = await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect((res.content[0] as { text: string }).text).toBe('localp40');
    expect(cloud.complete).not.toHaveBeenCalled();
  });

  it('memory (factExtraction) on the local switch fails over to cloud when the P40 is down', async () => {
    const cloud = mockProvider('cloud');
    const { registry, router } = harnessFrom([failingProvider('localp40'), cloud]);
    // Mirror production: MODEL=ornith pins every purpose at the local provider,
    // so factExtraction's primary is the P40, not the background heuristic.
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(), () => 'localp40');
    const dyn = pr.dynamicProviderFor('factExtraction');
    const res = await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect((res.content[0] as { text: string }).text).toBe('cloud');
  });

  it('throws the last error when every provider in the chain fails', async () => {
    const { registry, router } = harnessFrom([failingProvider('localp40', 'p40-down'), failingProvider('cloud', 'cloud-down')]);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router);
    const dyn = pr.dynamicProviderFor('cognition');
    await expect(dyn.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('cloud-down');
  });

  it('does NOT cascade a pinned purpose — eval stays on its model and fails hard', async () => {
    const cloud = mockProvider('cloud');
    const { registry, router } = harnessFrom([failingProvider('moonshot'), cloud]);
    // eval is pinned (model-routing carve-out): no fallback chain
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(['eval']));
    const dyn = pr.dynamicProviderFor('eval');
    await expect(dyn.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(cloud.complete).not.toHaveBeenCalled();
  });

  it('logs each fallback hop when a logger is supplied', async () => {
    const warn = vi.fn();
    const { registry, router } = harnessFrom([failingProvider('localp40'), mockProvider('cloud')]);
    const pr = new PurposeRouter(DEFAULT_MODELS, registry, router, new Set(), () => undefined, { warn });
    const dyn = pr.dynamicProviderFor('cognition');
    await dyn.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 'localp40', fallback: 'cloud' }),
      expect.stringContaining('falling back'),
    );
  });
});
