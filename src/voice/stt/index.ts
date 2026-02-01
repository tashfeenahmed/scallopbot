/**
 * STT Router - manages local and cloud STT providers
 *
 * Priority: Local (Whisper.cpp) -> Cloud (Groq) -> Cloud (OpenAI)
 */

import type { STTProvider, STTOptions, STTResult } from '../types.js';
import { WhisperSTT, type WhisperConfig } from './local/whisper.js';
import { MacOSSTT } from './local/macos.js';
import { GroqSTT, type GroqSTTConfig } from './cloud/groq.js';
import { OpenAISTT, type OpenAISTTConfig } from './cloud/openai.js';

export interface STTRouterConfig {
  preferLocal: boolean;
  whisper?: WhisperConfig;
  groq?: GroqSTTConfig;
  openai?: OpenAISTTConfig;
}

export class STTRouter implements STTProvider {
  public readonly name = 'stt-router';

  private providers: STTProvider[] = [];
  private preferLocal: boolean;

  constructor(config: STTRouterConfig) {
    this.preferLocal = config.preferLocal;

    // Add local providers first if preferLocal
    if (config.preferLocal) {
      this.providers.push(new WhisperSTT(config.whisper));
      if (process.platform === 'darwin') {
        this.providers.push(new MacOSSTT());
      }
    }

    // Add cloud providers
    if (config.groq?.apiKey) {
      this.providers.push(new GroqSTT(config.groq));
    }
    if (config.openai?.apiKey) {
      this.providers.push(new OpenAISTT(config.openai));
    }

    // Add local providers at end if not preferLocal
    if (!config.preferLocal) {
      this.providers.push(new WhisperSTT(config.whisper));
      if (process.platform === 'darwin') {
        this.providers.push(new MacOSSTT());
      }
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

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    const errors: Error[] = [];

    for (const provider of this.providers) {
      if (!await provider.isAvailable()) {
        continue;
      }

      try {
        const result = await provider.transcribe(audio, options);
        return {
          ...result,
          // Add metadata about which provider was used
          provider: provider.name,
        } as STTResult & { provider: string };
      } catch (error) {
        errors.push(error as Error);
        // Continue to next provider
      }
    }

    if (errors.length > 0) {
      throw new Error(`All STT providers failed: ${errors.map(e => e.message).join(', ')}`);
    }

    throw new Error('No STT providers available');
  }

  /**
   * Get the first available provider (for status checks)
   */
  async getActiveProvider(): Promise<STTProvider | null> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        return provider;
      }
    }
    return null;
  }
}

// Re-export individual providers
export { WhisperSTT } from './local/whisper.js';
export { MacOSSTT } from './local/macos.js';
export { GroqSTT } from './cloud/groq.js';
export { OpenAISTT } from './cloud/openai.js';
