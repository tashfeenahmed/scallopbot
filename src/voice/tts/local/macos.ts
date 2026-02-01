/**
 * macOS native TTS using the `say` command
 *
 * Zero setup required on macOS - uses built-in voices.
 * Available voices: Alex, Samantha, Victoria, etc.
 */

import { spawn } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { nanoid } from 'nanoid';
import type { TTSProvider, TTSOptions, TTSResult } from '../../types.js';

// Available high-quality macOS voices
const MACOS_VOICES = [
  'Alex',      // US English, male
  'Samantha',  // US English, female
  'Victoria',  // US English, female
  'Daniel',    // UK English, male
  'Karen',     // Australian English, female
  'Moira',     // Irish English, female
  'Tessa',     // South African English, female
] as const;

export interface MacOSTTSConfig {
  voice?: string;
}

export class MacOSTTS implements TTSProvider {
  public readonly name = 'macos-say';

  private voice: string;
  private available: boolean | null = null;

  constructor(config: MacOSTTSConfig = {}) {
    this.voice = config.voice || 'Samantha'; // Default to Samantha (good quality)
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    // Check if we're on macOS
    if (process.platform !== 'darwin') {
      this.available = false;
      return false;
    }

    // Check if say command is available
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('which', ['say']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('say command not found'));
        });
      });
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    if (!await this.isAvailable()) {
      throw new Error('macOS TTS is not available (not on macOS)');
    }

    const voice = options.voice || this.voice;
    const tempFile = join(tmpdir(), `macos-tts-${nanoid()}.aiff`);

    try {
      const args = [
        '-v', voice,
        '-o', tempFile,
        '--data-format=LEI16@22050', // 16-bit little-endian, 22050 Hz
      ];

      if (options.speed) {
        // macOS say uses words per minute, default ~175
        const wpm = Math.round(175 * options.speed);
        args.push('-r', wpm.toString());
      }

      // Add the text
      args.push(text);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('say', args);

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`say command failed with code ${code}`));
          }
        });
      });

      // Read the generated audio file
      const audio = await readFile(tempFile);

      return {
        audio,
        format: 'aiff',
        duration: undefined, // Would need to parse AIFF header to get duration
      };
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  /**
   * List available voices on this system
   */
  static async listVoices(): Promise<string[]> {
    if (process.platform !== 'darwin') {
      return [];
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('say', ['-v', '?']);
      let stdout = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          // Parse voice list: "Alex                en_US    # Most people..."
          const voices = stdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => line.split(/\s+/)[0]);
          resolve(voices);
        } else {
          reject(new Error('Failed to list voices'));
        }
      });
    });
  }
}
