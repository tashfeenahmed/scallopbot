/**
 * TTS Router - manages local and cloud TTS providers
 *
 * Priority: Local (macOS say / Piper) -> Cloud (OpenAI)
 */

import type { TTSProvider, TTSOptions, TTSResult } from '../types.js';
import { PiperTTS, type PiperConfig } from './local/piper.js';
import { MacOSTTS, type MacOSTTSConfig } from './local/macos.js';
import { OpenAITTS, type OpenAITTSConfig } from './cloud/openai.js';

export interface TTSRouterConfig {
  preferLocal: boolean;
  piper?: PiperConfig;
  macos?: MacOSTTSConfig;
  openai?: OpenAITTSConfig;
}

export class TTSRouter implements TTSProvider {
  public readonly name = 'tts-router';

  private providers: TTSProvider[] = [];
  private preferLocal: boolean;

  constructor(config: TTSRouterConfig) {
    this.preferLocal = config.preferLocal;

    // Add local providers first if preferLocal
    if (config.preferLocal) {
      // macOS say is zero-config, add it first for ease
      if (process.platform === 'darwin') {
        this.providers.push(new MacOSTTS(config.macos));
      }
      this.providers.push(new PiperTTS(config.piper));
    }

    // Add cloud providers
    if (config.openai?.apiKey) {
      this.providers.push(new OpenAITTS(config.openai));
    }

    // Add local providers at end if not preferLocal
    if (!config.preferLocal) {
      if (process.platform === 'darwin') {
        this.providers.push(new MacOSTTS(config.macos));
      }
      this.providers.push(new PiperTTS(config.piper));
    }
  }

  async isAvailable(): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const errors: Error[] = [];

    for (const provider of this.providers) {
      if (!await provider.isAvailable()) {
        continue;
      }

      try {
        const result = await provider.synthesize(text, options);
        return {
          ...result,
          provider: provider.name,
        } as TTSResult & { provider: string };
      } catch (error) {
        errors.push(error as Error);
        // Continue to next provider
      }
    }

    if (errors.length > 0) {
      throw new Error(`All TTS providers failed: ${errors.map(e => e.message).join(', ')}`);
    }

    throw new Error('No TTS providers available');
  }

  /**
   * Get the first available provider (for status checks)
   */
  async getActiveProvider(): Promise<TTSProvider | null> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        return provider;
      }
    }
    return null;
  }
}

// Re-export individual providers
export { PiperTTS } from './local/piper.js';
export { MacOSTTS } from './local/macos.js';
export { OpenAITTS } from './cloud/openai.js';
