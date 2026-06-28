import { describe, it, expect } from 'vitest';
import { primaryChatProvider, modelIdentityPrompt } from './identity.js';
import { ProviderRegistry } from '../providers/registry.js';
import { Router } from '../routing/router.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

function mockProvider(name: string, model: string, available = true): LLMProvider {
  return {
    name,
    model,
    isAvailable: () => available,
    complete: async () =>
      ({ content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, model } as CompletionResponse),
  };
}

function routerWith(providers: LLMProvider[]): Router {
  const order = providers.map((p) => p.name);
  const router = new Router({ providerOrder: order, tierMapping: { fast: order, standard: order, capable: order } });
  for (const p of providers) router.registerProvider(p);
  return router;
}

describe('primaryChatProvider', () => {
  it('returns the first available provider in PROVIDER_ORDER', () => {
    const ornith = mockProvider('ornith', 'ornith');
    const router = routerWith([ornith, mockProvider('openrouter', 'qwen/qwen3.6-plus')]);
    expect(primaryChatProvider(router, ornith).name).toBe('ornith');
  });

  it('skips an unavailable primary and returns the next available', () => {
    const cloud = mockProvider('openrouter', 'qwen/qwen3.6-plus');
    const router = routerWith([mockProvider('ornith', 'ornith', false), cloud]);
    expect(primaryChatProvider(router, cloud).name).toBe('openrouter');
  });

  it('falls back to the given provider when the router is null', () => {
    const fallback = mockProvider('ornith', 'ornith');
    expect(primaryChatProvider(null, fallback).name).toBe('ornith');
  });

  it('falls back when no router provider is available', () => {
    const fallback = mockProvider('ornith', 'ornith');
    const router = routerWith([mockProvider('openrouter', 'qwen/qwen3.6-plus', false)]);
    expect(primaryChatProvider(router, fallback)).toBe(fallback);
  });

  it('works against a real registry-backed router', () => {
    const registry = new ProviderRegistry();
    const ornith = mockProvider('ornith', 'ornith');
    registry.registerProvider(ornith);
    const router = routerWith([ornith]);
    expect(primaryChatProvider(router, ornith).model).toBe('ornith');
  });
});

describe('modelIdentityPrompt', () => {
  it('renders provider+model when they differ', () => {
    const out = modelIdentityPrompt({ name: 'openrouter', model: 'qwen/qwen3.6-plus' });
    expect(out).toContain('## MODEL IDENTITY');
    expect(out).toContain('`qwen/qwen3.6-plus`');
    expect(out).toContain('`openrouter`');
    expect(out).toMatch(/do not guess or invent/i);
  });

  it('collapses to a single label when provider name equals model (e.g. ornith)', () => {
    const out = modelIdentityPrompt({ name: 'ornith', model: 'ornith' });
    expect(out).toContain('`ornith`');
    expect(out).not.toContain('served via'); // not the redundant "ornith (via ornith)"
  });

  it('uses just the provider name when model is absent', () => {
    const out = modelIdentityPrompt({ name: 'ollama' });
    expect(out).toContain('`ollama`');
  });

  it('returns empty string when no provider is given', () => {
    expect(modelIdentityPrompt(undefined)).toBe('');
  });
});
