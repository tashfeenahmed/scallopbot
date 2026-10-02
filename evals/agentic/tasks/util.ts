/** Shared helpers for task setup and scoring. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskTrace } from '../types.js';

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function readText(root: string, relative: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relative), 'utf8');
  } catch {
    return null;
  }
}

export function exists(root: string, relative: string): boolean {
  return existsSync(path.join(root, relative));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command for scoring (never through the agent). `env` replaces the environment when given. */
export function run(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, ...(env && { env }) }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Every user-visible text the agent produced: final replies plus send_message texts. */
export function visibleText(trace: TaskTrace): string {
  return [trace.allResponses, ...trace.sentMessages].join('\n');
}

/** All numbers in a text, with thousands separators and currency signs removed. */
export function numbersIn(text: string): number[] {
  const matches = text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number).filter(Number.isFinite);
}

/** True when `text` states `value` (tolerates rounding to `decimals` places). */
export function mentionsNumber(text: string, value: number, decimals = 2): boolean {
  const tolerance = 0.5 * 10 ** -decimals + 1e-9;
  return numbersIn(text).some(n => Math.abs(n - value) <= tolerance);
}

/** Shell commands the agent ran: bash calls plus run_code with a shell language. */
export function bashCommands(trace: TaskTrace): string[] {
  return trace.toolCalls.flatMap((call) => {
    if (call.name === 'bash' && typeof call.input.command === 'string') return [call.input.command];
    if (call.name === 'run_code'
      && typeof call.input.code === 'string'
      && /^(?:bash|sh|shell|zsh)$/i.test(String(call.input.language ?? ''))) return [call.input.code];
    return [];
  });
}

export function callsNamed(trace: TaskTrace, name: string) {
  return trace.toolCalls.filter(call => call.name === name);
}

/** Small deterministic PRNG (mulberry32) so fixtures are identical on every run. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ok(details: string) {
  return { pass: true, details };
}

export function fail(details: string) {
  return { pass: false, details };
}

/** Combine named checks into one result; details list the failures (or all passes). */
export function checks(results: Array<[string, boolean]>) {
  const failed = results.filter(([, passed]) => !passed).map(([name]) => name);
  return failed.length === 0
    ? ok(results.map(([name]) => name).join('; '))
    : fail(`failed: ${failed.join('; ')}`);
}

/** A minimal ESM node project whose `npm test` runs `node --test`. */
export function nodeProject(name: string, files: Record<string, string>): Record<string, string> {
  return {
    'package.json': `${JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    ...files,
  };
}

/** Run `fn` against a scratch dir (deleted afterwards). */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `scallopbench-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a hidden `node --test` file the agent never sees. It lives in a scratch
 * dir outside the workspace; `@ws/` in the source becomes the workspace's
 * file URL, so `import x from '@ws/src/a.js'` reaches the agent's code.
 */
export function runHiddenTest(ws: string, id: string, source: string): Promise<CommandResult> {
  const base = `${pathToFileURL(ws).href}/`;
  return withTempDir(`hidden-${id}`, async (dir) => {
    const file = path.join(dir, `${id}.test.mjs`);
    await writeFile(file, source.replaceAll('@ws/', base));
    return run('node', ['--test', file], dir);
  });
}

/** sha256 of every file under `root` (relative paths), skipping .git and node_modules. */
export async function fileHashes(root: string, relative = ''): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return hashes;
  }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      for (const [file, hash] of await fileHashes(root, child)) hashes.set(file, hash);
    } else if (entry.isFile()) {
      hashes.set(child, createHash('sha256').update(await readFile(path.join(root, child))).digest('hex'));
    }
  }
  return hashes;
}

/**
 * Files of the pristine seed (re-created with `setup` in a scratch dir) that
 * the agent deleted or changed, ignoring `allowed` paths.
 */
export async function changedSeedFiles(
  ws: string,
  setup: (dir: string) => Promise<void> | void,
  allowed: readonly string[] = [],
): Promise<string[]> {
  const seed = await withTempDir('seed', async (dir) => {
    await setup(dir);
    return fileHashes(dir);
  });
  const now = await fileHashes(ws);
  return [...seed].filter(([file, hash]) => !allowed.includes(file) && now.get(file) !== hash).map(([file]) => file).sort();
}

/** Count whole-word matches of `word` in every .js/.mjs file under the given dirs. */
export async function countWord(ws: string, dirs: string[], word: string): Promise<number> {
  const re = new RegExp(`\\b${word}\\b`, 'g');
  let total = 0;
  for (const dir of dirs) {
    for (const file of (await fileHashes(path.join(ws, dir))).keys()) {
      if (!/\.m?js$/.test(file)) continue;
      total += ((await readText(path.join(ws, dir), file)) ?? '').match(re)?.length ?? 0;
    }
  }
  return total;
}
