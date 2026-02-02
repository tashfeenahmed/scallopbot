/**
 * Kokoro TTS - Lightweight 82M parameter TTS
 *
 * Requires: pip install kokoro-onnx (or pip install kokoro)
 * Uses ONNX runtime for efficient CPU inference
 */

import { spawn } from 'child_process';
import { access, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { TTSProvider, TTSOptions, TTSResult } from '../../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Available Kokoro voices
export const KOKORO_VOICES = {
  // American Female
  'af_heart': 'af_heart',      // Warm, expressive
  'af_bella': 'af_bella',      // Clear, professional
  'af_nicole': 'af_nicole',    // Friendly, casual
  'af_sarah': 'af_sarah',      // Calm, soothing
  'af_sky': 'af_sky',          // Bright, energetic
  // American Male
  'am_adam': 'am_adam',        // Deep, authoritative
  'am_michael': 'am_michael',  // Warm, friendly
  // British Female
  'bf_emma': 'bf_emma',        // British accent
  'bf_isabella': 'bf_isabella',
  // British Male
  'bm_george': 'bm_george',    // British accent
  'bm_lewis': 'bm_lewis',
} as const;

export type KokoroVoice = keyof typeof KOKORO_VOICES;

export interface KokoroConfig {
  voice?: KokoroVoice;
  lang?: 'a' | 'b'; // a = American, b = British
  pythonPath?: string;
  speed?: number;
}

// Default Python path - checks for scallopbot venv first
function getDefaultPythonPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const venvPython = `${homeDir}/.scallopbot/venv/bin/python3`;
  return process.env.VOICE_PYTHON_PATH || venvPython;
}

interface SynthesisInfo {
  success: boolean;
  sample_rate?: number;
  duration?: number;
  format?: string;
  size?: number;
  file?: string;
  error?: string;
}

export class KokoroTTS implements TTSProvider {
  public readonly name = 'kokoro';

  private voice: KokoroVoice;
  private lang: string;
  private pythonPath: string;
  private defaultSpeed: number;
  private scriptPath: string;
  private available: boolean | null = null;

  constructor(config: KokoroConfig = {}) {
    this.voice = config.voice || 'af_heart';
    this.lang = config.lang || 'a';
    this.pythonPath = config.pythonPath || getDefaultPythonPath();
    this.defaultSpeed = config.speed || 1.0;
    // Script is in src folder (not copied to dist by TypeScript)
    // __dirname in dist is dist/voice/tts/local, so go up to project root then into src
    this.scriptPath = join(__dirname, '..', '..', '..', '..', 'src', 'voice', 'scripts', 'kokoro_tts.py');
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if script exists
      await access(this.scriptPath);

      // Check if kokoro-onnx or kokoro is installed
      const result = await new Promise<boolean>((resolve) => {
        const proc = spawn(this.pythonPath, [
          '-c',
          'try:\n  import kokoro_onnx; print("ok")\nexcept:\n  try:\n    from kokoro import KPipeline; print("ok")\n  except:\n    print("no")',
        ]);
        let stdout = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.on('error', () => resolve(false));
        proc.on('close', (code) => {
          resolve(code === 0 && stdout.includes('ok'));
        });
      });

      this.available = result;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    if (!await this.isAvailable()) {
      throw new Error('Kokoro TTS is not available. Install with: pip install kokoro-onnx');
    }

    const voice = (options.voice as KokoroVoice) || this.voice;
    const speed = options.speed || this.defaultSpeed;
    const outputFormat = options.format || 'wav';

    // Use temp file for output
    const tempFile = join(tmpdir(), `kokoro-${nanoid()}.wav`);

    try {
      const args = [
        this.scriptPath,
        '--voice', voice,
        '--lang', this.lang,
        '--speed', speed.toString(),
        '--output', tempFile,
        '--text', text,
      ];

      const result = await new Promise<{ audio: Buffer; info: SynthesisInfo }>((resolve, reject) => {
        const proc = spawn(this.pythonPath, args);
        let stderr = '';

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('error', (err) => reject(err));
        proc.on('close', async (code) => {
          if (code === 0) {
            try {
              // Read the output file
              const { readFile } = await import('fs/promises');
              const audio = await readFile(tempFile);
              const info: SynthesisInfo = stderr ? JSON.parse(stderr) : { success: true };
              resolve({ audio, info });
            } catch (e) {
              reject(new Error(`Failed to read output: ${e}`));
            }
          } else {
            // Try to parse error from stderr
            try {
              const errorInfo = JSON.parse(stderr);
              reject(new Error(errorInfo.error || 'Synthesis failed'));
            } catch {
              reject(new Error(`Kokoro failed: ${stderr}`));
            }
          }
        });
      });

      // Convert to opus if requested
      let audio = result.audio;
      let format = 'wav';

      if (outputFormat === 'opus') {
        audio = await this.convertToOpus(result.audio);
        format = 'opus';
      }

      return {
        audio,
        format,
        duration: result.info.duration,
      };
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Convert WAV to Opus using ffmpeg
   */
  private async convertToOpus(wavBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', 'pipe:0',           // Input from stdin
        '-c:a', 'libopus',        // Opus codec
        '-b:a', '32k',            // Bitrate
        '-ar', '48000',           // Sample rate for Opus
        '-ac', '1',               // Mono
        '-f', 'ogg',              // OGG container
        'pipe:1',                 // Output to stdout
      ]);

      const chunks: Buffer[] = [];

      proc.stdout.on('data', (data) => {
        chunks.push(data);
      });

      proc.stderr.on('data', () => {
        // ffmpeg outputs progress to stderr, ignore it
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg conversion failed with code ${code}`));
        }
      });

      // Send WAV to stdin
      proc.stdin.write(wavBuffer);
      proc.stdin.end();
    });
  }

  /**
   * Get list of available voices
   */
  static getAvailableVoices(): { id: KokoroVoice; description: string }[] {
    return [
      { id: 'af_heart', description: 'American Female - Warm, expressive' },
      { id: 'af_bella', description: 'American Female - Clear, professional' },
      { id: 'af_nicole', description: 'American Female - Friendly, casual' },
      { id: 'af_sarah', description: 'American Female - Calm, soothing' },
      { id: 'af_sky', description: 'American Female - Bright, energetic' },
      { id: 'am_adam', description: 'American Male - Deep, authoritative' },
      { id: 'am_michael', description: 'American Male - Warm, friendly' },
      { id: 'bf_emma', description: 'British Female' },
      { id: 'bf_isabella', description: 'British Female' },
      { id: 'bm_george', description: 'British Male' },
      { id: 'bm_lewis', description: 'British Male' },
    ];
  }
}

/**
 * Check if Kokoro can be installed/used
 */
export async function checkKokoroRequirements(pythonPath: string = 'python3'): Promise<{
  pythonAvailable: boolean;
  kokoroInstalled: boolean;
  ffmpegAvailable: boolean;
  variant: 'kokoro-onnx' | 'kokoro' | null;
}> {
  let pythonAvailable = false;
  let kokoroInstalled = false;
  let ffmpegAvailable = false;
  let variant: 'kokoro-onnx' | 'kokoro' | null = null;

  // Check Python
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonPath, ['--version']);
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject();
      });
    });
    pythonAvailable = true;
  } catch {
    pythonAvailable = false;
  }

  // Check kokoro variants
  if (pythonAvailable) {
    // Try kokoro-onnx first
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonPath, ['-c', 'import kokoro_onnx']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject();
        });
      });
      kokoroInstalled = true;
      variant = 'kokoro-onnx';
    } catch {
      // Try full kokoro
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(pythonPath, ['-c', 'from kokoro import KPipeline']);
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject();
          });
        });
        kokoroInstalled = true;
        variant = 'kokoro';
      } catch {
        kokoroInstalled = false;
      }
    }
  }

  // Check ffmpeg
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject();
      });
    });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  return {
    pythonAvailable,
    kokoroInstalled,
    ffmpegAvailable,
    variant,
  };
}
