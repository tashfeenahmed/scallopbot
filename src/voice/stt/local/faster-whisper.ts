/**
 * faster-whisper STT - CTranslate2 optimized Whisper
 *
 * Requires: pip install faster-whisper
 * Uses int8 quantization by default for low memory usage
 */

import { spawn } from 'child_process';
import { writeFile, unlink, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { STTProvider, STTOptions, STTResult } from '../../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type FasterWhisperModel = 'tiny' | 'tiny.en' | 'base' | 'base.en' | 'small' | 'small.en' | 'medium' | 'medium.en' | 'large-v3';

export interface FasterWhisperConfig {
  model?: FasterWhisperModel;
  device?: 'cpu' | 'cuda';
  computeType?: 'int8' | 'float16' | 'float32';
  pythonPath?: string;
  beamSize?: number;
}

// Default Python path - checks for scallopbot venv first
function getDefaultPythonPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const venvPython = `${homeDir}/.scallopbot/venv/bin/python3`;
  return process.env.VOICE_PYTHON_PATH || venvPython;
}

interface TranscriptionResult {
  success: boolean;
  text?: string;
  language?: string;
  language_probability?: number;
  duration?: number;
  error?: string;
}

export class FasterWhisperSTT implements STTProvider {
  public readonly name = 'faster-whisper';

  private model: FasterWhisperModel;
  private device: string;
  private computeType: string;
  private pythonPath: string;
  private beamSize: number;
  private scriptPath: string;
  private available: boolean | null = null;

  constructor(config: FasterWhisperConfig = {}) {
    this.model = config.model || 'small';
    this.device = config.device || 'cpu';
    this.computeType = config.computeType || 'int8';
    this.pythonPath = config.pythonPath || getDefaultPythonPath();
    this.beamSize = config.beamSize || 5;
    // Script is in src folder (not copied to dist by TypeScript)
    // __dirname in dist is dist/voice/stt/local, so go up to project root then into src
    this.scriptPath = join(__dirname, '..', '..', '..', '..', 'src', 'voice', 'scripts', 'faster_whisper_stt.py');
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if script exists
      await access(this.scriptPath);

      // Check if faster-whisper is installed
      const result = await new Promise<boolean>((resolve) => {
        const proc = spawn(this.pythonPath, ['-c', 'import faster_whisper; print("ok")']);
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

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!await this.isAvailable()) {
      throw new Error('faster-whisper is not available. Install with: pip install faster-whisper');
    }

    // Write audio to temp file
    const tempFile = join(tmpdir(), `faster-whisper-${nanoid()}.wav`);

    try {
      await writeFile(tempFile, audio);

      const args = [
        this.scriptPath,
        '--model', this.model,
        '--device', this.device,
        '--compute-type', this.computeType,
        '--beam-size', this.beamSize.toString(),
        '--file', tempFile,
      ];

      if (options.language) {
        args.push('--language', options.language);
      }

      const result = await new Promise<TranscriptionResult>((resolve, reject) => {
        const proc = spawn(this.pythonPath, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
          if (code === 0 && stdout) {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new Error(`Invalid JSON response: ${stdout}`));
            }
          } else {
            reject(new Error(`faster-whisper failed: ${stderr || stdout}`));
          }
        });
      });

      if (!result.success) {
        throw new Error(result.error || 'Transcription failed');
      }

      return {
        text: result.text || '',
        language: result.language,
        confidence: result.language_probability,
        duration: result.duration,
      };
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }
}

/**
 * Check if faster-whisper can be installed/used
 */
export async function checkFasterWhisperRequirements(pythonPath: string = 'python3'): Promise<{
  pythonAvailable: boolean;
  fasterWhisperInstalled: boolean;
  recommendedModel: FasterWhisperModel;
}> {
  let pythonAvailable = false;
  let fasterWhisperInstalled = false;

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

  // Check faster-whisper
  if (pythonAvailable) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonPath, ['-c', 'import faster_whisper']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject();
        });
      });
      fasterWhisperInstalled = true;
    } catch {
      fasterWhisperInstalled = false;
    }
  }

  return {
    pythonAvailable,
    fasterWhisperInstalled,
    recommendedModel: 'small', // Best balance for 4GB RAM with int8
  };
}
