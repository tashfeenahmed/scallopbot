/**
 * Audio utilities for recording and playback
 *
 * Provides cross-platform audio capture and playback capabilities
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Audio recorder using system tools
 * - macOS: Uses `rec` from SoX or built-in tools
 * - Linux: Uses `arecord` or `rec`
 */
export class AudioRecorder extends EventEmitter {
  private process: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private isRecording = false;

  /**
   * Check if audio recording is available on this system
   */
  static async isAvailable(): Promise<boolean> {
    const commands = process.platform === 'darwin'
      ? ['rec', 'sox']
      : ['arecord', 'rec'];

    for (const cmd of commands) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('which', [cmd]);
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject();
          });
        });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Start recording audio
   * Returns a promise that resolves when recording starts
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Already recording');
    }

    this.chunks = [];
    this.isRecording = true;

    // Determine which command to use
    let args: string[];
    let cmd: string;

    if (process.platform === 'darwin') {
      // macOS: Use sox/rec to record WAV
      cmd = 'rec';
      args = [
        '-q',           // Quiet
        '-t', 'wav',    // Output format
        '-r', '16000',  // Sample rate (16kHz for speech)
        '-c', '1',      // Mono
        '-b', '16',     // 16-bit
        '-',            // Output to stdout
      ];
    } else {
      // Linux: Use arecord
      cmd = 'arecord';
      args = [
        '-q',           // Quiet
        '-f', 'S16_LE', // 16-bit signed little-endian
        '-r', '16000',  // Sample rate
        '-c', '1',      // Mono
        '-t', 'wav',    // WAV format
        '-',            // Output to stdout
      ];
    }

    this.process = spawn(cmd, args);

    this.process.stdout?.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.emit('data', chunk);
    });

    this.process.stderr?.on('data', (data) => {
      // Ignore stderr (progress info)
    });

    this.process.on('error', (error) => {
      this.isRecording = false;
      this.emit('error', error);
    });

    this.process.on('close', (code) => {
      this.isRecording = false;
      if (code !== 0 && code !== null) {
        this.emit('error', new Error(`Recording process exited with code ${code}`));
      }
      this.emit('end');
    });

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Stop recording and return the audio buffer
   */
  async stop(): Promise<Buffer> {
    if (!this.isRecording || !this.process) {
      throw new Error('Not recording');
    }

    const proc = this.process;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (proc) {
          proc.kill('SIGKILL');
        }
        resolve(Buffer.concat(this.chunks));
      }, 1000);

      proc.on('close', () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(this.chunks));
      });

      // Send SIGINT to stop recording gracefully
      proc.kill('SIGINT');
    });
  }

  /**
   * Cancel recording without saving
   */
  cancel(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
    this.isRecording = false;
    this.chunks = [];
  }

  /**
   * Check if currently recording
   */
  get recording(): boolean {
    return this.isRecording;
  }
}

/**
 * Audio player using system tools
 * - macOS: Uses `afplay` or `play` from SoX
 * - Linux: Uses `aplay` or `play`
 */
export class AudioPlayer {
  private process: ChildProcess | null = null;

  /**
   * Check if audio playback is available
   */
  static async isAvailable(): Promise<boolean> {
    const commands = process.platform === 'darwin'
      ? ['afplay', 'play']
      : ['aplay', 'play'];

    for (const cmd of commands) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('which', [cmd]);
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject();
          });
        });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Play audio from a buffer
   */
  async play(audio: Buffer, format: string = 'wav'): Promise<void> {
    return new Promise((resolve, reject) => {
      let cmd: string;
      let args: string[];

      if (process.platform === 'darwin') {
        if (format === 'aiff' || format === 'mp3' || format === 'wav') {
          cmd = 'afplay';
          args = ['-']; // Read from stdin
        } else {
          cmd = 'play';
          args = ['-t', format, '-'];
        }
      } else {
        if (format === 'wav') {
          cmd = 'aplay';
          args = ['-q', '-'];
        } else {
          cmd = 'play';
          args = ['-t', format, '-'];
        }
      }

      this.process = spawn(cmd, args);

      this.process.on('error', reject);
      this.process.on('close', (code) => {
        this.process = null;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Playback failed with code ${code}`));
        }
      });

      // Write audio to stdin
      this.process.stdin?.write(audio);
      this.process.stdin?.end();
    });
  }

  /**
   * Stop current playback
   */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }
}

/**
 * Simple voice activity detection based on audio level
 */
export function detectVoiceActivity(
  audioBuffer: Buffer,
  threshold: number = 500
): { hasVoice: boolean; avgLevel: number } {
  // Assuming 16-bit PCM audio
  let sum = 0;
  const samples = audioBuffer.length / 2;

  for (let i = 0; i < audioBuffer.length; i += 2) {
    const sample = audioBuffer.readInt16LE(i);
    sum += Math.abs(sample);
  }

  const avgLevel = sum / samples;
  return {
    hasVoice: avgLevel > threshold,
    avgLevel,
  };
}
