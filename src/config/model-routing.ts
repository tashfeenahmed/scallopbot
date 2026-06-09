/**
 * Per-purpose model routing — the single place that decides WHICH model/provider
 * each LLM-using job runs on.
 *
 * Before this existed, every background job picked its own provider inline in the
 * gateway (reranker grabbed the 'fast' tier, fact-extraction hunted for the "2nd
 * non-local" provider, dream/reflection/proactive reused a shared fusion provider,
 * eval hard-pinned Moonshot). That scattered policy is what let a "free-models-only"
 * rule get buried inside a feature module. Now each purpose is one config line
 * (`config.models.<purpose>`), overridable via `MODEL_<PURPOSE>` env vars, and
 * resolved here.
 *
 * A purpose resolves against either the primary provider chain, a routing tier,
 * a dedicated "background" upstream, or an explicit pinned provider(+model).
 */

import type { LLMProvider } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Router } from '../routing/router.js';
import type { ModelTier } from '../routing/complexity.js';

/** A resolvable model target for a single purpose. */
export type ModelRef =
  /** Use the primary chat provider chain (registry default), or a dedicated
   *  non-foreground "background" upstream to avoid hammering a single-slot local LLM. */
  | { use: 'main' | 'background' }
  /** Route by complexity tier through the Router. */
  | { tier: ModelTier }
  /** Pin an explicit provider, optionally with a specific model id. */
  | { provider: string; model?: string };

/** Every LLM-using purpose in the system. Add a key here + a default in config.ts. */
export interface ModelsConfig {
  /** LLM re-ranking of memory search results. */
  reranker: ModelRef;
  /** Session fact extraction + summarization (background, avoids foreground upstream). */
  factExtraction: ModelRef;
  /** Nightly cognition: dream cycle (NREM/REM), self-reflection, proactive evaluation. */
  cognition: ModelRef;
  /** Optional LLM-judge critic for best-of-N response selection. */
  critic: ModelRef;
  /** Self-evolution reflective optimizer (skill/prompt mutation). */
  evolution: ModelRef;
  /** Eval harness (reproducible benchmark runs). */
  eval: ModelRef;
}

export type ModelPurpose = keyof ModelsConfig;

/**
 * Canonical per-purpose defaults — the single source of truth. Each value
 * reproduces the prior inline selection exactly, so default behavior is unchanged:
 *   reranker/cognition → fast tier · factExtraction → 2nd non-local upstream
 *   critic/evolution   → primary chain · eval → Moonshot kimi-k2.5 (reproducibility)
 */
export const DEFAULT_MODELS: ModelsConfig = {
  reranker: { tier: 'fast' },
  factExtraction: { use: 'background' },
  cognition: { tier: 'fast' },
  critic: { use: 'main' },
  evolution: { use: 'main' },
  eval: { provider: 'moonshot', model: 'kimi-k2.5' },
};

/**
 * Parse a `MODEL_<PURPOSE>` env string into a ModelRef.
 * Accepted forms:
 *   "main"               → { use: 'main' }
 *   "background"         → { use: 'background' }
 *   "tier:fast"          → { tier: 'fast' }
 *   "groq"               → { provider: 'groq' }
 *   "moonshot:kimi-k2.5" → { provider: 'moonshot', model: 'kimi-k2.5' }
 * Returns undefined for empty/unparseable input (caller keeps the default).
 */
export function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  if (value === 'main' || value === 'background') {
    return { use: value };
  }
  if (value.startsWith('tier:')) {
    const tier = value.slice('tier:'.length).trim();
    if (tier === 'fast' || tier === 'standard' || tier === 'capable') {
      return { tier };
    }
    return undefined;
  }
  // provider or provider:model
  const [provider, ...modelParts] = value.split(':');
  if (!provider) return undefined;
  const model = modelParts.join(':').trim();
  return model ? { provider: provider.trim(), model } : { provider: provider.trim() };
}

/** Human-readable description of a ModelRef (for logs / CLI). */
export function describeModelRef(ref: ModelRef): string {
  if ('use' in ref) return ref.use;
  if ('tier' in ref) return `tier:${ref.tier}`;
  return ref.model ? `${ref.provider}:${ref.model}` : ref.provider;
}

/**
 * Resolves a purpose → concrete LLMProvider, given the registry + router.
 * Constructed once in the gateway and shared by every subsystem that needs to
 * pick a model for a non-chat job.
 */
export class PurposeRouter {
  constructor(
    private readonly models: ModelsConfig,
    private readonly registry: ProviderRegistry,
    private readonly router: Router,
  ) {}

  /** The configured ModelRef for a purpose (for logging / CLI introspection). */
  refFor(purpose: ModelPurpose): ModelRef {
    return this.models[purpose];
  }

  /**
   * Explicit pinned model id for a purpose, if any. Used by call sites that
   * construct their own provider instance (e.g. the eval harness).
   */
  modelFor(purpose: ModelPurpose): string | undefined {
    const ref = this.models[purpose];
    return 'provider' in ref ? ref.model : undefined;
  }

  /** Resolve the provider a purpose should run on. May be undefined if nothing is available. */
  async providerFor(purpose: ModelPurpose): Promise<LLMProvider | undefined> {
    return this.resolve(this.models[purpose]);
  }

  private async resolve(ref: ModelRef): Promise<LLMProvider | undefined> {
    if ('tier' in ref) {
      return (await this.router.selectProvider(ref.tier)) ?? undefined;
    }
    if ('provider' in ref) {
      const pinned = this.registry.getProvider(ref.provider);
      if (pinned && pinned.isAvailable()) return pinned;
      // Pinned provider unavailable — degrade to the primary chain rather than fail.
      return this.resolveMain();
    }
    if (ref.use === 'background') {
      return this.resolveBackground();
    }
    return this.resolveMain();
  }

  private resolveMain(): LLMProvider | undefined {
    return this.registry.getDefaultProvider();
  }

  /**
   * A dedicated non-foreground upstream: prefer the SECOND non-local provider in
   * PROVIDER_ORDER so a single-slot local LLM (e.g. Dell qwen3.6) isn't hammered by
   * the foreground turn and an async background job at once. Falls back to the first
   * non-local provider, then any non-local, then the default. (Preserves the prior
   * inline fact-extraction heuristic exactly.)
   */
  private resolveBackground(): LLMProvider | undefined {
    const order = this.router.getProviderOrder();
    const candidates: LLMProvider[] = [];
    for (const name of order) {
      const p = this.registry.getProvider(name);
      if (p && p.name !== 'ollama' && p.isAvailable()) candidates.push(p);
    }
    return (
      candidates[1] ||
      candidates[0] ||
      this.registry.getAvailableProviders().find((p) => p.name !== 'ollama') ||
      this.registry.getDefaultProvider()
    );
  }
}
