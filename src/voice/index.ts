/**
 * Voice module - STT and TTS with local-first priority
 *
 * Provides unified interface for speech-to-text and text-to-speech
 * with automatic fallback from local to cloud providers.
 */

import type { Logger } from 'pino';
import { STTRouter, type STTRouterConfig } from './stt/index.js';
import { TTSRouter, type TTSRouterConfig } from './tts/index.js';
import { AudioRecorder, AudioPlayer } from './audio.js';
import type {
  VoiceConfig,
  STTOptions,
  STTResult,
  TTSOptions,
  TTSResult,
  DEFAULT_VOICE_CONFIG,
} from './types.js';

export interface VoiceManagerConfig {
  stt: STTRouterConfig;
  tts: TTSRouterConfig;
  logger?: Logger;
}

export class VoiceManager {
  private stt: STTRouter;
  private tts: TTSRouter;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private logger?: Logger;

  constructor(config: VoiceManagerConfig) {
    this.stt = new STTRouter(config.stt);
    this.tts = new TTSRouter(config.tts);
    this.recorder = new AudioRecorder();
    this.player = new AudioPlayer();
    this.logger = config.logger;
  }

  /**
   * Create a VoiceManager from environment config
   */
  static fromEnv(logger?: Logger): VoiceManager {
    const openaiKey = process.env.OPENAI_API_KEY || '';
    const groqKey = process.env.GROQ_API_KEY || '';

    return new VoiceManager({
      stt: {
        preferLocal: true,
        groq: groqKey ? { apiKey: groqKey } : undefined,
        openai: openaiKey ? { apiKey: openaiKey } : undefined,
      },
      tts: {
        preferLocal: true,
        openai: openaiKey ? { apiKey: openaiKey } : undefined,
      },
      logger,
    });
  }

  /**
   * Check if voice capabilities are available
   */
  async isAvailable(): Promise<{ stt: boolean; tts: boolean; recording: boolean; playback: boolean }> {
    const [stt, tts, recording, playback] = await Promise.all([
      this.stt.isAvailable(),
      this.tts.isAvailable(),
      AudioRecorder.isAvailable(),
      AudioPlayer.isAvailable(),
    ]);

    return { stt, tts, recording, playback };
  }

  /**
   * Get status of active providers
   */
  async getStatus(): Promise<{
    stt: { available: boolean; provider: string | null };
    tts: { available: boolean; provider: string | null };
  }> {
    const [sttProvider, ttsProvider] = await Promise.all([
      this.stt.getActiveProvider(),
      this.tts.getActiveProvider(),
    ]);

    return {
      stt: {
        available: !!sttProvider,
        provider: sttProvider?.name || null,
      },
      tts: {
        available: !!ttsProvider,
        provider: ttsProvider?.name || null,
      },
    };
  }

  /**
   * Transcribe audio buffer to text
   */
  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    this.logger?.debug({ audioSize: audio.length }, 'Transcribing audio');

    const result = await this.stt.transcribe(audio, options);

    this.logger?.debug(
      { text: result.text.substring(0, 50), provider: (result as any).provider },
      'Transcription complete'
    );

    return result;
  }

  /**
   * Synthesize text to audio
   */
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    this.logger?.debug({ textLength: text.length }, 'Synthesizing speech');

    const result = await this.tts.synthesize(text, options);

    this.logger?.debug(
      { audioSize: result.audio.length, provider: (result as any).provider },
      'Synthesis complete'
    );

    return result;
  }

  /**
   * Record audio from microphone
   * Returns when recording is stopped via stopRecording()
   */
  async startRecording(): Promise<void> {
    this.logger?.debug('Starting audio recording');
    await this.recorder.start();
  }

  /**
   * Stop recording and return audio buffer
   */
  async stopRecording(): Promise<Buffer> {
    this.logger?.debug('Stopping audio recording');
    return this.recorder.stop();
  }

  /**
   * Cancel recording without saving
   */
  cancelRecording(): void {
    this.recorder.cancel();
  }

  /**
   * Check if currently recording
   */
  get isRecording(): boolean {
    return this.recorder.recording;
  }

  /**
   * Play audio buffer through speakers
   */
  async playAudio(audio: Buffer, format: string = 'wav'): Promise<void> {
    this.logger?.debug({ format, size: audio.length }, 'Playing audio');
    await this.player.play(audio, format);
  }

  /**
   * Stop current audio playback
   */
  stopPlayback(): void {
    this.player.stop();
  }

  /**
   * Convenience: Record, transcribe, and return text
   * Press Enter to stop recording
   */
  async listen(options?: STTOptions): Promise<string> {
    await this.startRecording();

    // Wait for user to press Enter (handled by caller)
    // This method should be called with a way to stop recording

    const audio = await this.stopRecording();
    const result = await this.transcribe(audio, options);
    return result.text;
  }

  /**
   * Convenience: Synthesize and play text
   */
  async speak(text: string, options?: TTSOptions): Promise<void> {
    const result = await this.synthesize(text, options);
    await this.playAudio(result.audio, result.format);
  }
}

// Re-export types and components
export * from './types.js';
export { STTRouter } from './stt/index.js';
export { TTSRouter } from './tts/index.js';
export { AudioRecorder, AudioPlayer, detectVoiceActivity } from './audio.js';
export { WhisperSTT, downloadWhisperModel } from './stt/local/whisper.js';
export { MacOSSTT } from './stt/local/macos.js';
export { GroqSTT } from './stt/cloud/groq.js';
export { OpenAISTT } from './stt/cloud/openai.js';
export { PiperTTS, downloadPiperModel } from './tts/local/piper.js';
export { MacOSTTS } from './tts/local/macos.js';
export { OpenAITTS } from './tts/cloud/openai.js';
