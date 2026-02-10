/**
 * Piper TTS - Fast local text-to-speech
 *
 * Requires: piper-tts installed locally
 * Install: pip install piper-tts or download binary from GitHub
 * Models: https://github.com/rhasspy/piper/releases
 */

import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { join } from 'path';
import type { TTSProvider, TTSOptions, TTSResult } from '../../types.js';

export interface PiperConfig {
  piperPath?: string;
  modelPath?: string;
  voice?: string;
}

export class PiperTTS implements TTSProvider {
  public readonly name = 'piper-local';

  private piperPath: string;
  private modelPath: string;
  private available: boolean | null = null;

  constructor(config: PiperConfig = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const defaultModelDir = join(homeDir, '.scallopbot', 'models', 'piper');

    this.piperPath = config.piperPath || 'piper';
    this.modelPath = config.modelPath || join(defaultModelDir, 'en_US-lessac-medium.onnx');
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if piper binary exists
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.piperPath, ['--help']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 || code === 1) resolve();
          else reject(new Error('piper not found'));
        });
      });

      // Check if model file exists
      await access(this.modelPath);

      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    if (!await this.isAvailable()) {
      throw new Error('Piper TTS is not available. Install with: pip install piper-tts');
    }

    const args = [
      '--model', this.modelPath,
      '--output_raw',
    ];

    if (options.speed && options.speed !== 1.0) {
      args.push('--length_scale', (1.0 / options.speed).toString());
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.piperPath, args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (data) => {
        chunks.push(data);
      });

      proc.stderr.on('data', (_data) => {
        // Piper outputs progress to stderr, ignore it
      });

      proc.on('error', reject);

      proc.on('close', (code) => {
        if (code === 0) {
          const audio = Buffer.concat(chunks);
          resolve({
            audio,
            format: 'raw', // 16-bit PCM, 22050 Hz, mono
            duration: audio.length / (22050 * 2), // Estimate duration
          });
        } else {
          reject(new Error(`Piper failed with code ${code}`));
        }
      });

      // Send text to stdin
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }
}

/**
 * Download Piper voice model if not present
 */
export async function downloadPiperModel(
  voice: string = 'en_US-lessac-medium',
  targetDir?: string
): Promise<string> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const modelDir = targetDir || join(homeDir, '.scallopbot', 'models', 'piper');
  const modelFile = join(modelDir, `${voice}.onnx`);
  const configFile = join(modelDir, `${voice}.onnx.json`);

  try {
    await access(modelFile);
    await access(configFile);
    return modelFile; // Already exists
  } catch {
    // Need to download
    const baseUrl = process.env.PIPER_MODEL_BASE_URL || 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
    const [lang, region, name, quality] = voice.split(/[-_]/);
    const voicePath = `${lang}_${region}/${name}/${quality}`;

    console.log(`Downloading Piper voice: ${voice}...`);

    // Download model and config
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const url = `${baseUrl}/${voicePath}/${voice}.onnx`;
        const proc = spawn('curl', ['-L', '-o', modelFile, '--create-dirs', url]);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Download failed`));
        });
      }),
      new Promise<void>((resolve, reject) => {
        const url = `${baseUrl}/${voicePath}/${voice}.onnx.json`;
        const proc = spawn('curl', ['-L', '-o', configFile, '--create-dirs', url]);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Download failed`));
        });
      }),
    ]);

    return modelFile;
  }
}
