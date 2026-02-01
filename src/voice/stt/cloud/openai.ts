/**
 * OpenAI Whisper API for cloud-based STT
 *
 * Pricing: $0.006 per minute
 * Use as fallback when local Whisper is not available
 */

import OpenAI from 'openai';
import type { STTProvider, STTOptions, STTResult } from '../../types.js';

export interface OpenAISTTConfig {
  apiKey: string;
  model?: 'whisper-1';
}

export class OpenAISTT implements STTProvider {
  public readonly name = 'openai-whisper';

  private client: OpenAI;
  private model: string;
  private available: boolean | null = null;

  constructor(config: OpenAISTTConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model || 'whisper-1';
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    // Check if API key is set
    this.available = !!this.client.apiKey && this.client.apiKey.length > 0;
    return this.available;
  }

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!await this.isAvailable()) {
      throw new Error('OpenAI API key not configured');
    }

    // Create a File-like object from the buffer
    const file = new File([audio], 'audio.wav', { type: 'audio/wav' });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      language: options.language,
      prompt: options.prompt,
      response_format: 'verbose_json',
    });

    return {
      text: response.text,
      language: response.language,
      duration: response.duration,
    };
  }
}
