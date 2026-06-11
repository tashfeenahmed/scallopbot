import type { LLMProvider } from './types.js';
import { wrapProviderWithTraceTap } from '../routing/trace-tap.js';

/**
 * Registry for managing LLM providers
 * Supports dynamic loading based on available API keys
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();

  /**
   * Register a provider. Wrapped with the LLM trace tap so tagged calls
   * (purpose set, or tools present) are recorded for fine-tune datasets.
   * The wrap is a transparent Proxy — a no-op until a trace sink is set.
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, wrapProviderWithTraceTap(provider));
  }

  /**
   * Get a provider by name
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get the default (first available) provider
   */
  getDefaultProvider(): LLMProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.isAvailable()) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): LLMProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.isAvailable());
  }

  /**
   * Get all registered provider names
   */
  getRegisteredNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is registered
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Remove a provider
   */
  removeProvider(name: string): boolean {
    return this.providers.delete(name);
  }

  /**
   * Clear all providers
   */
  clear(): void {
    this.providers.clear();
  }
}
