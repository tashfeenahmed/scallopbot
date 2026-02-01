/**
 * OpenAI TTS API for cloud-based text-to-speech
 *
 * Voices: alloy, echo, fable, onyx, nova, shimmer
 * Models: tts-1 (faster), tts-1-hd (higher quality)
 */

import OpenAI from 'openai';
import type { TTSProvider, TTSOptions, TTSResult } from '../../types.js';

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
type OpenAIVoice = typeof OPENAI_VOICES[number];

export interface OpenAITTSConfig {
  apiKey: string;
  model?: 'tts-1' | 'tts-1-hd';
  voice?: OpenAIVoice;
}

export class OpenAITTS implements TTSProvider {
  public readonly name = 'openai-tts';

  private client: OpenAI;
  private model: string;
  private defaultVoice: OpenAIVoice;
  private available: boolean | null = null;

  constructor(config: OpenAITTSConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model || 'tts-1';
    this.defaultVoice = config.voice || 'alloy';
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    this.available = !!this.client.apiKey && this.client.apiKey.length > 0;
    return this.available;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    if (!await this.isAvailable()) {
      throw new Error('OpenAI API key not configured');
    }

    const voice = (options.voice as OpenAIVoice) || this.defaultVoice;
    const format = options.format || 'mp3';

    const response = await this.client.audio.speech.create({
      model: this.model,
      voice,
      input: text,
      response_format: format as 'mp3' | 'opus' | 'aac' | 'flac',
      speed: options.speed || 1.0,
    });

    // Get the audio data as a buffer
    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);

    return {
      audio,
      format,
      // Duration estimation based on text length and speed
      duration: (text.length / 15) / (options.speed || 1.0), // ~15 chars/sec estimate
    };
  }
}
