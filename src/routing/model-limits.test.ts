import { afterEach, describe, expect, it } from 'vitest';
import {
  completionBudgetForPurpose,
  effectiveContextWindowTokens,
  getModelTokenLimits,
} from './model-limits.js';

describe('model token limits', () => {
  afterEach(() => {
    delete process.env.MODEL_TOKEN_LIMITS;
  });

  it('returns known Qwen3.6 Plus limits', () => {
    const limits = getModelTokenLimits('qwen/qwen3.6-plus');
    expect(limits.contextWindowTokens).toBe(1_000_000);
    expect(limits.maxOutputTokens).toBe(65_536);
    expect(limits.source).toBe('known');
  });

  it('allows private deployments to override limits by provider name', () => {
    process.env.MODEL_TOKEN_LIMITS = JSON.stringify({
      my_memory: { contextWindowTokens: 262_144, maxOutputTokens: 32_768 },
    });

    const limits = getModelTokenLimits({ name: 'my_memory', model: 'private-model' });
    expect(limits.contextWindowTokens).toBe(262_144);
    expect(limits.maxOutputTokens).toBe(32_768);
    expect(limits.source).toBe('override');
  });

  it('uses the smaller of configured and model context windows', () => {
    expect(
      effectiveContextWindowTokens({ name: 'openrouter', model: 'qwen/qwen3.6-plus' }, 128_000)
    ).toBe(128_000);
  });

  it('caps background completion budgets to the model output limit', () => {
    process.env.MODEL_TOKEN_LIMITS = JSON.stringify({
      tiny: { contextWindowTokens: 4_096, maxOutputTokens: 900 },
    });

    expect(completionBudgetForPurpose({ name: 'tiny', model: 'tiny' }, 'session_summary', 2_000)).toBe(900);
  });
});
