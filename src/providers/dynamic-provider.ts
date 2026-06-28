/**
 * A provider whose concrete implementation is resolved lazily, on every call.
 *
 * Background jobs (memory fact-extraction, search re-ranking, nightly cognition /
 * proactivity) used to capture a concrete provider once at startup — so a runtime
 * model switch (the `/model` command, via the global runtime override) couldn't
 * reach them without a process restart. Wrapping a purpose in a DynamicProvider
 * re-resolves the target on each call, so the single switch takes effect live,
 * with no changes at the many call sites that just expect an `LLMProvider`.
 */

import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from './types.js';

export class DynamicProvider implements LLMProvider {
  constructor(
    private readonly resolver: () => Promise<LLMProvider | undefined>,
    public readonly name: string = 'dynamic',
  ) {}

  private async require(): Promise<LLMProvider> {
    const provider = await this.resolver();
    if (!provider) throw new Error(`No provider available for "${this.name}"`);
    return provider;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return (await this.require()).complete(request);
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
