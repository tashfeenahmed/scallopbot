/**
 * Run Code Skill Execution Script
 *
 * Writes a throwaway program to a temp file, runs it with the appropriate
 * interpreter (python3 / node / bash), captures stdout/stderr/exit, and returns
 * JSON. Receives arguments via the SKILL_ARGS environment variable.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';

const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

type Language = 'python' | 'javascript' | 'bash';

interface RunCodeArgs {
  language: Language;
  code: string;
  timeout?: number;
}

interface RunCodeResult {
  success: boolean;
  output: string;
  error: string;
  exitCode: number;
  language: Language;
}

const RUNNERS: Record<Language, { cmd: string; args: (file: string) => string[]; ext: string; missingHint: string }> = {
  python: {
    cmd: 'python3',
    args: (file) => [file],
    ext: '.py',
    missingHint: 'python3 not found on PATH. Install it (e.g. `brew install python3` or `apt-get install python3`) or use language "javascript".',
  },
  javascript: {
    cmd: 'node',
    args: (file) => [file],
    ext: '.js',
    missingHint: 'node not found on PATH.',
  },
  bash: {
    cmd: 'bash',
    args: (file) => [file],
    ext: '.sh',
    missingHint: 'bash not found on PATH.',
  },
};

function emit(result: RunCodeResult): void {
  process.stdout.write(JSON.stringify(result));
}

function fail(language: Language, error: string, exitCode = 1): void {
  emit({ success: false, output: '', error, exitCode, language });
}

async function main(): Promise<void> {
  let args: RunCodeArgs;
  try {
    args = JSON.parse(process.env.SKILL_ARGS || '{}');
  } catch {
    fail('bash', 'Invalid SKILL_ARGS JSON');
    return;
  }

  const language = args.language;
  if (!language || !(language in RUNNERS)) {
    fail((language as Language) || 'bash', `Unsupported language "${language}". Use one of: python, javascript, bash.`);
    return;
  }
  if (typeof args.code !== 'string' || args.code.trim().length === 0) {
    fail(language, 'No code provided.');
    return;
  }

  const timeout = Math.min(Math.max(1000, args.timeout || DEFAULT_TIMEOUT), MAX_TIMEOUT);
  const runner = RUNNERS[language];

  // Write the program to a uniquely-named temp file.
  const tmpFile = path.join(os.tmpdir(), `runcode-${Date.now()}-${randomBytes(4).toString('hex')}${runner.ext}`);
  try {
    fs.writeFileSync(tmpFile, args.code, 'utf-8');
  } catch (e) {
    fail(language, `Failed to write temp file: ${(e as Error).message}`);
    return;
  }

  const cwd = process.env.SKILL_WORKSPACE || process.env.AGENT_WORKSPACE || process.cwd();
  const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };

  await new Promise<void>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let outputBytes = 0;
    let truncated = false;
    let settled = false;

    const child = spawn(runner.cmd, runner.args(tmpFile), {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: RunCodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      emit(result);
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        success: false,
        output: stdout.join(''),
        error: `Execution timed out after ${timeout}ms`,
        exitCode: 124,
        language,
      });
    }, timeout);

    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return;
      outputBytes += d.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        stdout.push('\n[OUTPUT TRUNCATED - exceeded 1MB limit]');
        child.kill('SIGTERM');
        return;
      }
      stdout.push(d.toString());
    });

    child.stderr?.on('data', (d: Buffer) => {
      if (!truncated) stderr.push(d.toString());
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err.code === 'ENOENT' ? runner.missingHint : `Failed to execute: ${err.message}`;
      finish({ success: false, output: stdout.join(''), error: msg, exitCode: 127, language });
    });

    child.on('close', (code) => {
      const exitCode = code ?? 0;
      finish({
        success: exitCode === 0,
        output: stdout.join(''),
        error: stderr.join(''),
        exitCode,
        language,
      });
    });
  });
}

main().catch((e) => fail('bash', `run_code crashed: ${(e as Error).message}`));
