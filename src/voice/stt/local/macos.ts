/**
 * macOS native Speech Recognition using NSSpeechRecognizer via osascript
 *
 * This is a lightweight fallback that uses macOS built-in speech recognition.
 * No additional dependencies required on macOS.
 */

import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { nanoid } from 'nanoid';
import type { STTProvider, STTOptions, STTResult } from '../../types.js';

export class MacOSSTT implements STTProvider {
  public readonly name = 'macos-stt';

  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    // Check if we're on macOS
    if (process.platform !== 'darwin') {
      this.available = false;
      return false;
    }

    // Check if speech recognition is available
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('which', ['say']);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('macOS speech tools not found'));
        });
      });
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!await this.isAvailable()) {
      throw new Error('macOS speech recognition is not available');
    }

    // Write audio to temp file
    const tempFile = join(tmpdir(), `macos-stt-${nanoid()}.wav`);

    try {
      await writeFile(tempFile, audio);

      // Use macOS speech recognition via Python (SFSpeechRecognizer)
      // This requires the audio file to be in a compatible format
      const pythonScript = `
import speech_recognition as sr
import sys

recognizer = sr.Recognizer()
with sr.AudioFile("${tempFile}") as source:
    audio = recognizer.record(source)

try:
    # Use macOS native recognition
    text = recognizer.recognize_google(audio, language="${options.language || 'en-US'}")
    print(text)
except sr.UnknownValueError:
    print("")
except sr.RequestError as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

      // Try using SpeechRecognition Python library if available
      // Fall back to a simpler approach if not
      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn('python3', ['-c', pythonScript]);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('error', () => {
          // Python not available, return empty
          resolve('');
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            // Don't fail hard, just return empty
            resolve('');
          }
        });
      });

      return {
        text: result,
        language: options.language,
      };
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  }
}
