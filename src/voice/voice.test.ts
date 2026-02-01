import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceManager } from './index.js';
import { STTRouter } from './stt/index.js';
import { TTSRouter } from './tts/index.js';
import type { STTResult, TTSResult } from './types.js';

// Mock the providers
vi.mock('./stt/local/whisper.js', () => ({
  WhisperSTT: vi.fn().mockImplementation(() => ({
    name: 'whisper-local',
    isAvailable: vi.fn().mockResolvedValue(false),
    transcribe: vi.fn(),
  })),
}));

vi.mock('./stt/local/macos.js', () => ({
  MacOSSTT: vi.fn().mockImplementation(() => ({
    name: 'macos-stt',
    isAvailable: vi.fn().mockResolvedValue(false),
    transcribe: vi.fn(),
  })),
}));

vi.mock('./stt/cloud/groq.js', () => ({
  GroqSTT: vi.fn().mockImplementation(() => ({
    name: 'groq-whisper',
    isAvailable: vi.fn().mockResolvedValue(true),
    transcribe: vi.fn().mockResolvedValue({
      text: 'Hello world',
      language: 'en',
      duration: 1.5,
    }),
  })),
}));

vi.mock('./stt/cloud/openai.js', () => ({
  OpenAISTT: vi.fn().mockImplementation(() => ({
    name: 'openai-whisper',
    isAvailable: vi.fn().mockResolvedValue(true),
    transcribe: vi.fn().mockResolvedValue({
      text: 'Hello from OpenAI',
      language: 'en',
    }),
  })),
}));

vi.mock('./tts/local/piper.js', () => ({
  PiperTTS: vi.fn().mockImplementation(() => ({
    name: 'piper-local',
    isAvailable: vi.fn().mockResolvedValue(false),
    synthesize: vi.fn(),
  })),
}));

vi.mock('./tts/local/macos.js', () => ({
  MacOSTTS: vi.fn().mockImplementation(() => ({
    name: 'macos-say',
    isAvailable: vi.fn().mockResolvedValue(true),
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from('audio-data'),
      format: 'aiff',
    }),
  })),
}));

vi.mock('./tts/cloud/openai.js', () => ({
  OpenAITTS: vi.fn().mockImplementation(() => ({
    name: 'openai-tts',
    isAvailable: vi.fn().mockResolvedValue(true),
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from('openai-audio'),
      format: 'mp3',
      duration: 2.0,
    }),
  })),
}));

vi.mock('./audio.js', () => {
  const MockAudioRecorder = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(Buffer.from('audio-data')),
    cancel: vi.fn(),
    recording: false,
  }));
  (MockAudioRecorder as any).isAvailable = vi.fn().mockResolvedValue(true);

  const MockAudioPlayer = vi.fn().mockImplementation(() => ({
    play: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  }));
  (MockAudioPlayer as any).isAvailable = vi.fn().mockResolvedValue(true);

  return {
    AudioRecorder: MockAudioRecorder,
    AudioPlayer: MockAudioPlayer,
    detectVoiceActivity: vi.fn().mockReturnValue({ hasVoice: true, avgLevel: 1000 }),
  };
});

describe('Voice Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('STTRouter', () => {
    it('should create STT router with config', () => {
      const router = new STTRouter({
        preferLocal: true,
        groq: { apiKey: 'test-key' },
      });

      expect(router.name).toBe('stt-router');
    });

    it('should check availability', async () => {
      const router = new STTRouter({
        preferLocal: false,
        groq: { apiKey: 'test-key' },
      });

      const available = await router.isAvailable();
      expect(available).toBe(true);
    });

    it('should transcribe audio with fallback', async () => {
      const router = new STTRouter({
        preferLocal: true, // Local not available, should fall back to Groq
        groq: { apiKey: 'test-key' },
      });

      const audio = Buffer.from('test-audio');
      const result = await router.transcribe(audio);

      expect(result.text).toBe('Hello world');
    });

    it('should get active provider', async () => {
      const router = new STTRouter({
        preferLocal: false,
        groq: { apiKey: 'test-key' },
      });

      const provider = await router.getActiveProvider();
      expect(provider?.name).toBe('groq-whisper');
    });
  });

  describe('TTSRouter', () => {
    it('should create TTS router with config', () => {
      const router = new TTSRouter({
        preferLocal: true,
        openai: { apiKey: 'test-key' },
      });

      expect(router.name).toBe('tts-router');
    });

    it('should check availability', async () => {
      const router = new TTSRouter({
        preferLocal: true,
        openai: { apiKey: 'test-key' },
      });

      const available = await router.isAvailable();
      expect(available).toBe(true);
    });

    it('should synthesize text with local provider on macOS', async () => {
      // Mock platform as darwin
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const router = new TTSRouter({
        preferLocal: true,
        openai: { apiKey: 'test-key' },
      });

      const result = await router.synthesize('Hello');

      expect(result.audio).toBeDefined();
      expect(result.format).toBe('aiff');

      // Restore platform
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should get active provider', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const router = new TTSRouter({
        preferLocal: true,
      });

      const provider = await router.getActiveProvider();
      expect(provider?.name).toBe('macos-say');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('VoiceManager', () => {
    it('should create from environment', () => {
      const manager = VoiceManager.fromEnv();
      expect(manager).toBeDefined();
    });

    it('should check availability status', async () => {
      const manager = VoiceManager.fromEnv();
      const status = await manager.isAvailable();

      expect(status).toHaveProperty('stt');
      expect(status).toHaveProperty('tts');
      expect(status).toHaveProperty('recording');
      expect(status).toHaveProperty('playback');
    });

    it('should get provider status', async () => {
      const manager = VoiceManager.fromEnv();
      const status = await manager.getStatus();

      expect(status).toHaveProperty('stt');
      expect(status).toHaveProperty('tts');
      expect(status.stt).toHaveProperty('available');
      expect(status.stt).toHaveProperty('provider');
    });

    it('should transcribe audio', async () => {
      process.env.GROQ_API_KEY = 'test-key';

      const manager = VoiceManager.fromEnv();
      const audio = Buffer.from('test-audio');
      const result = await manager.transcribe(audio);

      expect(result.text).toBeDefined();

      delete process.env.GROQ_API_KEY;
    });

    it('should synthesize speech', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const manager = VoiceManager.fromEnv();
      const result = await manager.synthesize('Hello world');

      expect(result.audio).toBeDefined();
      expect(result.format).toBeDefined();

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should track recording state', () => {
      const manager = VoiceManager.fromEnv();
      expect(manager.isRecording).toBe(false);
    });
  });

  describe('Voice Types', () => {
    it('should have valid STTResult type', () => {
      const result: STTResult = {
        text: 'Hello',
        confidence: 0.95,
        language: 'en',
        duration: 2.5,
      };

      expect(result.text).toBe('Hello');
      expect(result.confidence).toBe(0.95);
    });

    it('should have valid TTSResult type', () => {
      const result: TTSResult = {
        audio: Buffer.from('audio'),
        format: 'mp3',
        duration: 3.0,
      };

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.format).toBe('mp3');
    });
  });
});

describe('Voice Integration', () => {
  it('should handle STT -> process -> TTS flow', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.GROQ_API_KEY = 'test-key';

    const manager = VoiceManager.fromEnv();

    // Simulate: record -> transcribe -> (process) -> synthesize
    const audio = Buffer.from('test-audio');
    const transcription = await manager.transcribe(audio);

    expect(transcription.text).toBeDefined();

    // Simulate processing (would go through agent)
    const responseText = `You said: ${transcription.text}`;

    // Synthesize response
    const speech = await manager.synthesize(responseText);

    expect(speech.audio).toBeDefined();
    expect(speech.format).toBeDefined();

    delete process.env.GROQ_API_KEY;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should gracefully handle unavailable providers', async () => {
    // No API keys set, local not available
    const manager = VoiceManager.fromEnv();

    // Should not throw but indicate unavailability
    const status = await manager.isAvailable();
    expect(typeof status.stt).toBe('boolean');
    expect(typeof status.tts).toBe('boolean');
  });
});
