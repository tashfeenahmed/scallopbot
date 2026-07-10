/**
 * A provider whose concrete implementation is resolved lazily, on every call.
 *
 * Background jobs (memory fact-extraction, search re-ranking, nightly cognition /
 * proactivity) used to capture a concrete provider once at startup — so a runtime
 * model switch (the `/model` command, via the global runtime override) couldn't
 * reach them without a process restart. Wrapping a purpose in a DynamicProvider
 * re-resolves the target on each call, so the single switch takes effect live,
 * with no changes at the many call sites that just expect an `LLMProvider`.
 *
 * Cascade fallback: when a `chain` resolver is supplied, complete() tries each
 * provider in order until one succeeds. This gives background purposes the same
 * resilience the foreground chat path already has — a purpose pinned to a local
 * model (e.g. the Dell P40) transparently fails over to the cloud chain
 * (PROVIDER_ORDER) when the local box is down, instead of erroring out. The
 * first entry is the purpose's resolved primary; the rest are the remaining
 * PROVIDER_ORDER providers. Purposes that must not drift off their configured
 * model (the pinned set, e.g. eval) are given no chain and keep single-provider
 * behavior.
 */

import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from './types.js';

/** Minimal pino-compatible sink for fallback diagnostics (optional). */
export interface FallbackLogger {
  warn(obj: unknown, msg: string): void;
}

/** Shared health sink supplied by Router without coupling this provider to it. */
export interface ProviderOutcomeReporter {
  success(provider: string): void;
  failure(provider: string, error: Error): void;
}

export class DynamicProvider implements LLMProvider {
  constructor(
    private readonly resolver: () => Promise<LLMProvider | undefined>,
    public readonly name: string = 'dynamic',
    /**
     * Optional ordered fallback chain, re-resolved per call. When provided,
     * complete() walks it (primary first, then the PROVIDER_ORDER cloud
     * fallbacks) until one provider succeeds. Omitted for pinned purposes.
     */
    private readonly chain?: () => Promise<LLMProvider[]>,
    private readonly logger?: FallbackLogger,
    private readonly outcomes?: ProviderOutcomeReporter,
  ) {}

  private async require(): Promise<LLMProvider> {
    const provider = await this.resolver();
    if (!provider) throw new Error(`No provider available for "${this.name}"`);
    return provider;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.chain) {
      const provider = await this.require();
      try {
        const response = await provider.complete(request);
        this.outcomes?.success(provider.name);
        return response;
      } catch (error) {
        this.outcomes?.failure(provider.name, error as Error);
        throw error;
      }
    }

    const providers = await this.chain();
    if (providers.length === 0) {
      throw new Error(`No provider available for "${this.name}"`);
    }

    let lastError: unknown;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      try {
        const response = await provider.complete(request);
        this.outcomes?.success(provider.name);
        return response;
      } catch (error) {
        lastError = error;
        this.outcomes?.failure(provider.name, error as Error);
        const next = providers[i + 1];
        if (next) {
          this.logger?.warn(
            {
              purpose: this.name,
              failed: provider.name,
              fallback: next.name,
              error: (error as Error).message,
            },
            'Background purpose provider failed, falling back',
          );
        }
      }
    }
    throw lastError;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const provider = await this.require();
    if (!provider.stream) {
      throw new Error(`Provider "${provider.name}" does not support streaming`);
    }
    yield* provider.stream(request);
  }

  /**
   * Resolved lazily at call time, so availability isn't known synchronously.
   * Report available and let complete() surface a real outage — callers gate
   * features on truthiness, and this keeps them enabled.
   */
  isAvailable(): boolean {
    return true;
  }
}
