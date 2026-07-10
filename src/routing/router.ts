import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
} from '../providers/types.js';
import { analyzeComplexity, type ModelTier } from './complexity.js';

export interface ProviderHealth {
  isHealthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
  lastError?: string;
  /** When the provider was marked unhealthy (for auto-recovery timing) */
  unhealthySince?: Date;
}

/** Auto-recovery cooldown: retry unhealthy providers after this many ms (5 minutes). */
const DEFAULT_HEALTH_RECOVERY_MS = 5 * 60 * 1000;

/**
 * Provider preferences by workload. The global provider order controls which
 * providers are enabled; these lists only rank those enabled providers for the
 * requested workload. Unknown/custom providers remain first, preserving the
 * common "prefer my local endpoint" deployment pattern.
 */
const TIER_PREFERENCES: Record<ModelTier, readonly string[]> = {
  fast: ['groq', 'moonshot', 'openrouter', 'ollama', 'openai', 'xai', 'anthropic'],
  standard: ['moonshot', 'openai', 'openrouter', 'anthropic', 'xai', 'groq', 'ollama'],
  capable: ['anthropic', 'moonshot', 'openai', 'openrouter', 'xai', 'groq', 'ollama'],
};

const KNOWN_TIERED_PROVIDERS = new Set(Object.values(TIER_PREFERENCES).flat());

function uniqueProviderNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/**
 * Build genuinely distinct provider chains for fast/standard/capable work.
 *
 * Previously the gateway copied PROVIDER_ORDER into all three tiers, making
 * complexity analysis observational only: every request chose the same first
 * provider. This helper keeps custom/local providers at the front while ranking
 * known cloud providers according to the workload.
 */
export function buildTierMapping(providerOrder: readonly string[]): Record<ModelTier, string[]> {
  const enabled = uniqueProviderNames(providerOrder);
  const custom = enabled.filter((name) => !KNOWN_TIERED_PROVIDERS.has(name));

  const rank = (tier: ModelTier): string[] => {
    const preferred = TIER_PREFERENCES[tier].filter((name) => enabled.includes(name));
    return uniqueProviderNames([
      ...custom,
      ...preferred,
      // Forward compatibility: retain providers not yet classified above.
      ...enabled,
    ]);
  };

  return {
    fast: rank('fast'),
    standard: rank('standard'),
    capable: rank('capable'),
  };
}

export interface RouterOptions {
  providerOrder?: string[];
  tierMapping?: Record<ModelTier, string[]>;
  healthCheckInterval?: number;
  unhealthyThreshold?: number;
  /** Base cooldown before an unhealthy provider gets a half-open recovery attempt. */
  healthRecoveryMs?: number;
}

export interface ExecutionResult {
  response: CompletionResponse;
  provider: string;
  attemptedProviders: string[];
}

type ProviderWithHealth = LLMProvider & {
  checkHealth?: () => Promise<boolean>;
};

export class Router {
  private providers: Map<string, ProviderWithHealth> = new Map();
  private providerHealth: Map<string, ProviderHealth> = new Map();
  private providerOrder: string[];
  private tierMapping: Record<ModelTier, string[]>;
  private unhealthyThreshold: number;
  private healthRecoveryMs: number;

  constructor(options: RouterOptions) {
    this.providerOrder = uniqueProviderNames(
      options.providerOrder ?? ['moonshot', 'anthropic', 'openai', 'openrouter', 'groq', 'xai', 'ollama'],
    );
    const mapping = options.tierMapping ?? buildTierMapping(this.providerOrder);
    this.tierMapping = {
      fast: uniqueProviderNames(mapping.fast),
      standard: uniqueProviderNames(mapping.standard),
      capable: uniqueProviderNames(mapping.capable),
    };
    this.unhealthyThreshold = options.unhealthyThreshold ?? 3;
    this.healthRecoveryMs = options.healthRecoveryMs ?? DEFAULT_HEALTH_RECOVERY_MS;
  }

  getProviderOrder(): string[] {
    return [...this.providerOrder];
  }

  getTierMapping(): Record<ModelTier, string[]> {
    return {
      fast: [...this.tierMapping.fast],
      standard: [...this.tierMapping.standard],
      capable: [...this.tierMapping.capable],
    };
  }

  registerProvider(provider: ProviderWithHealth): void {
    this.providers.set(provider.name, provider);
    this.providerHealth.set(provider.name, {
      isHealthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    });
  }

  getProvider(name: string): ProviderWithHealth | undefined {
    return this.providers.get(name);
  }

  getProviderHealth(name: string): ProviderHealth | undefined {
    return this.providerHealth.get(name);
  }

  async checkProviderHealth(name: string): Promise<boolean> {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }

    const health = this.providerHealth.get(name) || {
      isHealthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    };

    try {
      let isHealthy = provider.isAvailable();

      // If provider has a checkHealth method, use it
      if (provider.checkHealth) {
        isHealthy = isHealthy && (await provider.checkHealth());
      }

      if (isHealthy) {
        health.isHealthy = true;
        health.consecutiveFailures = 0;
        health.lastError = undefined;
        health.unhealthySince = undefined;
      } else {
        health.consecutiveFailures++;
        health.isHealthy = health.consecutiveFailures < this.unhealthyThreshold;
        if (!health.isHealthy && !health.unhealthySince) {
          health.unhealthySince = new Date();
        }
      }
    } catch (error) {
      health.consecutiveFailures++;
      health.lastError = (error as Error).message;
      health.isHealthy = health.consecutiveFailures < this.unhealthyThreshold;
      if (!health.isHealthy && !health.unhealthySince) {
        health.unhealthySince = new Date();
      }
    }

    health.lastCheck = new Date();
    this.providerHealth.set(name, health);

    return health.isHealthy;
  }

  /** Check if an unhealthy provider should be retried (auto-recovery) */
  private shouldRetryUnhealthy(health: ProviderHealth): boolean {
    if (health.isHealthy) return true;
    if (!health.unhealthySince) return false;
    // Exponential backoff: 5min * 2^(failures-3), capped at 1 hour
    const backoffMs = Math.min(
      this.healthRecoveryMs * Math.pow(2, Math.max(0, health.consecutiveFailures - this.unhealthyThreshold)),
      60 * 60 * 1000
    );
    return Date.now() - health.unhealthySince.getTime() >= backoffMs;
  }

  /**
   * A selection call cannot observe completion, so a provider whose cooldown
   * elapsed is admitted optimistically. executeWithFallback uses a true
   * half-open attempt and only clears health after a successful completion.
   */
  private admitRecoveredProvider(health: ProviderHealth): void {
    health.isHealthy = true;
    health.consecutiveFailures = 0;
    health.lastError = undefined;
    health.unhealthySince = undefined;
    health.lastCheck = new Date();
  }

  /** Whether a provider may be attempted now, including a cooldown-expired probe. */
  canAttemptProvider(name: string): boolean {
    const health = this.providerHealth.get(name);
    return !health || health.isHealthy || this.shouldRetryUnhealthy(health);
  }

  /** Feed outcomes from dynamic/background provider chains into shared health. */
  recordProviderSuccess(name: string): void {
    const health = this.providerHealth.get(name) || {
      isHealthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    };
    this.admitRecoveredProvider(health);
    this.providerHealth.set(name, health);
  }

  /** Feed outcomes from dynamic/background provider chains into shared health. */
  recordProviderFailure(name: string, error: Error): void {
    const health = this.providerHealth.get(name) || {
      isHealthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    };

    health.consecutiveFailures++;
    health.lastError = error.message;
    health.isHealthy = health.consecutiveFailures < this.unhealthyThreshold;
    health.lastCheck = new Date();
    if (!health.isHealthy) {
      // Start (or restart after a failed half-open attempt) the recovery clock.
      health.unhealthySince = new Date();
    }

    this.providerHealth.set(name, health);
  }

  async selectProvider(tier: ModelTier): Promise<ProviderWithHealth | undefined> {
    const tierProviders = this.tierMapping[tier] || [];

    for (const name of tierProviders) {
      const provider = this.providers.get(name);
      if (!provider) continue;

      const health = this.providerHealth.get(name);
      if (health && !health.isHealthy) {
        // Auto-recovery: retry if enough time has passed
        if (this.shouldRetryUnhealthy(health)) {
          this.admitRecoveredProvider(health);
        } else {
          continue;
        }
      }

      if (provider.isAvailable()) {
        return provider;
      }
    }

    // Fallback: try any available provider
    for (const name of this.providerOrder) {
      const provider = this.providers.get(name);
      if (!provider) continue;

      const health = this.providerHealth.get(name);
      if (health && !health.isHealthy) {
        if (this.shouldRetryUnhealthy(health)) {
          this.admitRecoveredProvider(health);
        } else {
          continue;
        }
      }

      if (provider.isAvailable()) {
        return provider;
      }
    }

    return undefined;
  }

  async selectProviderForMessage(
    message: string,
    overrideTier?: ModelTier
  ): Promise<ProviderWithHealth | undefined> {
    const tier = overrideTier || analyzeComplexity(message).suggestedModelTier;
    return this.selectProvider(tier);
  }

  async executeWithFallback(
    request: CompletionRequest,
    tier: ModelTier,
    options: { excludeProviders?: readonly string[] } = {},
  ): Promise<ExecutionResult> {
    // Sanitize messages before sending to any fallback provider
    const sanitizedMessages = request.messages.filter(msg => {
      if (msg.content == null) return false;
      if (typeof msg.content === 'string') return msg.content.length > 0;
      if (Array.isArray(msg.content)) return msg.content.length > 0;
      return true;
    });
    const sanitizedRequest = sanitizedMessages.length !== request.messages.length
      ? { ...request, messages: sanitizedMessages }
      : request;

    const tierProviders = this.tierMapping[tier] || [];
    const attemptedProviders: string[] = [];
    const errors: Error[] = [];
    const excludedProviders = new Set(options.excludeProviders ?? []);

    // Try tier-specific providers first
    for (const name of tierProviders) {
      if (excludedProviders.has(name)) continue;
      const provider = this.providers.get(name);
      if (!provider) continue;

      if (!this.canAttemptProvider(name)) continue;

      if (!provider.isAvailable()) continue;

      attemptedProviders.push(name);

      try {
        const response = await provider.complete(sanitizedRequest);
        this.recordProviderSuccess(name);
        return {
          response,
          provider: name,
          attemptedProviders,
        };
      } catch (error) {
        errors.push(error as Error);
        this.recordProviderFailure(name, error as Error);
      }
    }

    // Try remaining providers
    for (const name of this.providerOrder) {
      if (excludedProviders.has(name)) continue;
      if (attemptedProviders.includes(name)) continue;

      const provider = this.providers.get(name);
      if (!provider) continue;

      if (!this.canAttemptProvider(name)) continue;

      if (!provider.isAvailable()) continue;

      attemptedProviders.push(name);

      try {
        const response = await provider.complete(sanitizedRequest);
        this.recordProviderSuccess(name);
        return {
          response,
          provider: name,
          attemptedProviders,
        };
      } catch (error) {
        errors.push(error as Error);
        this.recordProviderFailure(name, error as Error);
      }
    }

    throw new Error(
      `All providers failed. Attempted: ${attemptedProviders.join(', ')}. Errors: ${errors.map((e) => e.message).join('; ')}`
    );
  }

}
