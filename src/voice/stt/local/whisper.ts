/**
 * Local STT using whisper.cpp via node bindings or subprocess
 *
 * Requires: whisper.cpp installed locally
 * Install: brew install whisper-cpp (macOS) or build from source
 */

import { spawn } from 'child_process';
import { writeFile, unlink, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { nanoid } from 'nanoid';
import type { STTProvider, STTOptions, STTResult } from '../../types.js';

const WHISPER_MODELS = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  large: 'ggml-large-v3.bin',
} as const;

type WhisperModel = keyof typeof WHISPER_MODELS;

export interface WhisperConfig {
  modelPath?: string;
  model?: WhisperModel;
  whisperPath?: string; // Path to whisper binary
  threads?: number;
}

export class WhisperSTT implements STTProvider {
  public readonly name = 'whisper-local';

  private modelPath: string;
  private whisperPath: string;
  private threads: number;
  private available: boolean | null = null;

  constructor(config: WhisperConfig = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const defaultModelDir = join(homeDir, '.scallopbot', 'models');

    this.modelPath = config.modelPath || join(defaultModelDir, WHISPER_MODELS[config.model || 'base']);
    this.whisperPath = config.whisperPath || 'whisper-cpp';
    this.threads = config.threads || 4;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if whisper binary exists
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.whisperPath, ['--help']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 || code === 1) resolve(); // --help may return 1
          else reject(new Error(`whisper-cpp not found`));
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

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!await this.isAvailable()) {
      throw new Error('Whisper.cpp is not available. Install with: brew install whisper-cpp');
    }

    // Write audio to temp file (whisper needs a file)
    const tempFile = join(tmpdir(), `whisper-${nanoid()}.wav`);

    try {
      await writeFile(tempFile, audio);

      const args = [
        '-m', this.modelPath,
        '-f', tempFile,
        '-t', this.threads.toString(),
        '--output-txt',
        '--no-timestamps',
      ];

      if (options.language) {
        args.push('-l', options.language);
      }

      if (options.prompt) {
        args.push('--prompt', options.prompt);
      }

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn(this.whisperPath, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`Whisper failed: ${stderr}`));
          }
        });
      });

      return {
        text: result.trim(),
        language: options.language,
      };
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }
}

/**
 * Download whisper model if not present
 */
export async function downloadWhisperModel(
  model: WhisperModel = 'base',
  targetDir?: string
): Promise<string> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const modelDir = targetDir || join(homeDir, '.scallopbot', 'models');
  const modelFile = join(modelDir, WHISPER_MODELS[model]);

  try {
    await access(modelFile);
    return modelFile; // Already exists
  } catch {
    // Need to download
    const baseUrl = process.env.WHISPER_MODEL_BASE_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
    const url = `${baseUrl}/${WHISPER_MODELS[model]}`;

    console.log(`Downloading whisper model: ${model}...`);
    console.log(`From: ${url}`);
    console.log(`To: ${modelFile}`);

    // Use curl for download (available on most systems)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('curl', ['-L', '-o', modelFile, '--create-dirs', url]);
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Download failed with code ${code}`));
      });
    });

    return modelFile;
  }
}
