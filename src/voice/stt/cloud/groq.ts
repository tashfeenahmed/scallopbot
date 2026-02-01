/**
 * Groq Whisper API for cloud-based STT
 *
 * Faster and cheaper than OpenAI Whisper
 * Use as primary cloud fallback
 */

import Groq from 'groq-sdk';
import type { STTProvider, STTOptions, STTResult } from '../../types.js';

export interface GroqSTTConfig {
  apiKey: string;
  model?: 'whisper-large-v3' | 'whisper-large-v3-turbo' | 'distil-whisper-large-v3-en';
}

export class GroqSTT implements STTProvider {
  public readonly name = 'groq-whisper';

  private client: Groq;
  private model: string;
  private available: boolean | null = null;

  constructor(config: GroqSTTConfig) {
    this.client = new Groq({ apiKey: config.apiKey });
    this.model = config.model || 'whisper-large-v3-turbo'; // Fastest option
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
      throw new Error('Groq API key not configured');
    }

    // Create a File-like object from the buffer
    const file = new File([audio], 'audio.wav', { type: 'audio/wav' });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      language: options.language,
      prompt: options.prompt,
      response_format: 'json',
    });

    return {
      text: response.text,
      language: options.language,
    };
  }
}
