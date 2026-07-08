import type { LLMProvider } from '../providers/types.js';

export interface ModelTokenLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ResolvedModelTokenLimits extends ModelTokenLimits {
  model: string;
  source: 'override' | 'known' | 'family' | 'default';
}

const DEFAULT_LIMITS: ModelTokenLimits = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
};

const KNOWN_LIMITS: Record<string, ModelTokenLimits> = {
  // OpenRouter live metadata, July 2026.
  'qwen/qwen3.6-plus': { contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  'qwen/qwen3.6-plus-04-02': { contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  'qwen/qwen3.6-flash': { contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  'qwen/qwen3.6-max-preview': { contextWindowTokens: 262_144, maxOutputTokens: 65_536 },
  'qwen/qwen3.6-max-preview-20260420': { contextWindowTokens: 262_144, maxOutputTokens: 65_536 },
  'qwen/qwen3.6-35b-a3b': { contextWindowTokens: 262_144, maxOutputTokens: 262_144 },
  'qwen/qwen3.6-35b-a3b-20260415': { contextWindowTokens: 262_144, maxOutputTokens: 262_144 },
  'qwen/qwen3.6-27b': { contextWindowTokens: 262_140, maxOutputTokens: 262_140 },
  'qwen/qwen3.6-27b-20260422': { contextWindowTokens: 262_140, maxOutputTokens: 262_140 },

  // Common configured defaults. Keep these conservative because provider-side
  // limits can vary by account, endpoint, or deployment.
  'gpt-4o': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4.1': { contextWindowTokens: 1_000_000, maxOutputTokens: 32_768 },
  'gpt-4.1-mini': { contextWindowTokens: 1_000_000, maxOutputTokens: 32_768 },
  'gpt-4.1-nano': { contextWindowTokens: 1_000_000, maxOutputTokens: 32_768 },
  'o3': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'o4-mini': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'claude-sonnet-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  'claude-sonnet-4-5-20250929': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  'claude-opus-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
  'kimi-k2.5': { contextWindowTokens: 256_000, maxOutputTokens: 65_536 },
  'kimi-k2.5-thinking': { contextWindowTokens: 256_000, maxOutputTokens: 65_536 },
  'llama-3.3-70b-versatile': { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
};

const PURPOSE_DEFAULT_OUTPUT: Record<string, number> = {
  session_summary: 1_200,
  session_summary_retry: 2_400,
  rerank: 1_024,
  relation_classify: 1_024,
  compaction_summary: 1_024,
};

const PURPOSE_MAX_OUTPUT: Record<string, number> = {
  session_summary: 4_096,
  session_summary_retry: 8_192,
  rerank: 4_096,
  relation_classify: 4_096,
  compaction_summary: 4_096,
};

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

function resolveIdentity(
  modelOrProvider?: string | Pick<LLMProvider, 'name' | 'model'>
): { provider?: string; model: string } {
  if (!modelOrProvider) return { model: 'unknown' };
  if (typeof modelOrProvider === 'string') return { model: modelOrProvider };
  return {
    provider: modelOrProvider.name,
    model: modelOrProvider.model || modelOrProvider.name || 'unknown',
  };
}

function parseLimitOverride(value: unknown): ModelTokenLimits | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const contextWindowTokens = Number(record.contextWindowTokens ?? record.context ?? record.contextTokens);
  const maxOutputTokens = Number(record.maxOutputTokens ?? record.output ?? record.outputTokens);
  if (!Number.isFinite(contextWindowTokens) || !Number.isFinite(maxOutputTokens)) return null;
  if (contextWindowTokens <= 0 || maxOutputTokens <= 0) return null;
  return {
    contextWindowTokens: Math.floor(contextWindowTokens),
    maxOutputTokens: Math.floor(maxOutputTokens),
  };
}

function readLimitOverrides(): Map<string, ModelTokenLimits> {
  const raw = process.env.MODEL_TOKEN_LIMITS;
  const overrides = new Map<string, ModelTokenLimits>();
  if (!raw) return overrides;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      const limits = parseLimitOverride(value);
      if (limits) overrides.set(normalizeModelId(key), limits);
    }
  } catch {
    // Invalid overrides should not break startup or LLM calls.
  }
  return overrides;
}

function familyLimits(model: string): ModelTokenLimits | null {
  if (model.includes('qwen3.6')) {
    return { contextWindowTokens: 262_144, maxOutputTokens: 32_768 };
  }
  if (model.includes('qwen3') || model.includes('qwen-3')) {
    return { contextWindowTokens: 128_000, maxOutputTokens: 16_384 };
  }
  if (model.includes('llama') || model.includes('mistral')) {
    return { contextWindowTokens: 128_000, maxOutputTokens: 8_192 };
  }
  return null;
}

export function getModelTokenLimits(
  modelOrProvider?: string | Pick<LLMProvider, 'name' | 'model'>
): ResolvedModelTokenLimits {
  const identity = resolveIdentity(modelOrProvider);
  const model = normalizeModelId(identity.model);
  const provider = identity.provider ? normalizeModelId(identity.provider) : undefined;
  const overrideKeys = [
    provider && `${provider}/${model}`,
    model,
    provider,
  ].filter((key): key is string => Boolean(key));

  const overrides = readLimitOverrides();
  for (const key of overrideKeys) {
    const override = overrides.get(key);
    if (override) return { model, source: 'override', ...override };
  }

  const known = KNOWN_LIMITS[model];
  if (known) return { model, source: 'known', ...known };

  const family = familyLimits(model);
  if (family) return { model, source: 'family', ...family };

  return { model, source: 'default', ...DEFAULT_LIMITS };
}

export function effectiveContextWindowTokens(
  provider: Pick<LLMProvider, 'name' | 'model'> | undefined,
  configuredContextWindowTokens: number
): number {
  const limits = getModelTokenLimits(provider);
  return Math.max(1, Math.min(configuredContextWindowTokens, limits.contextWindowTokens));
}

export function completionBudgetForPurpose(
  modelOrProvider: string | Pick<LLMProvider, 'name' | 'model'> | undefined,
  purpose: string,
  desiredTokens?: number,
  options?: { minTokens?: number; maxTokens?: number }
): number {
  const limits = getModelTokenLimits(modelOrProvider);
  const desired = desiredTokens ?? PURPOSE_DEFAULT_OUTPUT[purpose] ?? DEFAULT_LIMITS.maxOutputTokens;
  const minTokens = options?.minTokens ?? Math.min(256, desired);
  const purposeMax = options?.maxTokens ?? PURPOSE_MAX_OUTPUT[purpose] ?? desired;
  const hardMax = Math.max(1, Math.min(limits.maxOutputTokens, purposeMax));
  return Math.max(1, Math.min(Math.max(desired, minTokens), hardMax));
}

export function charsForTokenBudget(tokens: number, charsPerToken = 4): number {
  return Math.max(1, Math.floor(tokens * charsPerToken));
}
