/**
 * Lint delta for file edits.
 *
 * A fast per-language checker runs before and after a write; only problems
 * that are new after the edit are reported, so the model fixes what it
 * broke and ignores what was already there. Every run is timeout-bounded
 * and never throws.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from './state.js';

export interface LintProblem {
  line?: number;
  /** Stable identity used for the before/after comparison (no line numbers). */
  key: string;
  message: string;
}

export interface LintRun {
  checker: string;
  problems: LintProblem[];
  /** Set when the checker could not run; the delta is then skipped. */
  skipped?: string;
}

export interface LintOptions {
  /** Directory the search for tsconfig.json stops at (inclusive). */
  workspace: string;
  tscTimeoutMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 8_000;
const TSC_TIMEOUT = 20_000;

/** tsconfig paths whose tsc run exceeded the budget; skipped for the process lifetime. */
const slowTsProjects = new Set<string>();

interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message });
      return;
    }
    const cap = (s: string, d: Buffer) => (s.length > 2_000_000 ? s : s + d.toString('utf8'));
    child.stdout?.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
    child.stderr?.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => finish({ code: null, stdout, stderr, timedOut, error: e.message }));
    child.on('close', code => finish({ code, stdout, stderr, timedOut }));
  });
}

function findUp(startDir: string, name: string, stopAt?: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    if (stopAt && path.resolve(dir) === path.resolve(stopAt)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function tsBuildInfoPath(tsconfig: string): string {
  const dir = path.join(os.tmpdir(), 'scallopbot-tsc');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return path.join(dir, `${sha256(tsconfig).slice(0, 16)}.tsbuildinfo`);
}

function findTsconfig(absPath: string, workspace: string): string | null {
  const stopAt = isInside(workspace, absPath) ? workspace : undefined;
  return findUp(path.dirname(absPath), 'tsconfig.json', stopAt);
}

/** One tsc run for a project; diagnostics split per requested file. */
async function lintTypeScriptProject(tsconfig: string | null, absPaths: string[], opts: LintOptions): Promise<Map<string, LintRun>> {
  const checker = 'tsc';
  const out = new Map<string, LintRun>();
  const all = (r: Omit<LintRun, 'checker'>) => { for (const p of absPaths) out.set(p, { checker, ...r }); return out; };
  if (!tsconfig) return all({ problems: [], skipped: 'no tsconfig.json' });
  if (slowTsProjects.has(tsconfig)) return all({ problems: [], skipped: 'tsc too slow for this project' });
  const tsc = findUp(path.dirname(tsconfig), path.join('node_modules', '.bin', 'tsc'));
  if (!tsc) return all({ problems: [], skipped: 'typescript not installed' });
  const timeoutMs = opts.tscTimeoutMs ?? TSC_TIMEOUT;
  const res = await run(tsc, ['--noEmit', '--pretty', 'false', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', tsBuildInfoPath(tsconfig)], {
    cwd: path.dirname(tsconfig), timeoutMs, signal: opts.signal,
  });
  if (res.timedOut) {
    slowTsProjects.add(tsconfig);
    return all({ problems: [], skipped: `tsc took over ${Math.round(timeoutMs / 1000)}s` });
  }
  if (res.error) return all({ problems: [], skipped: res.error });
  const base = path.dirname(tsconfig);
  const wanted = new Map(absPaths.map(p => [path.resolve(p), p] as const));
  for (const p of absPaths) out.set(p, { checker, problems: [] });
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  for (const line of (res.stdout + '\n' + res.stderr).split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const key = wanted.get(path.resolve(base, m[1]));
    if (!key) continue;
    out.get(key)!.problems.push({ line: Number(m[2]), key: `${m[4]}: ${m[5]}`, message: `${m[4]} ${m[5]}` });
  }
  return out;
}

async function lintWithCommand(
  checker: string, cmd: string, args: string[], absPath: string, opts: LintOptions,
  parse: (out: string) => LintProblem[],
): Promise<LintRun> {
  const res = await run(cmd, args, { cwd: path.dirname(absPath), timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT, signal: opts.signal });
  if (res.error) return { checker, problems: [], skipped: `${cmd} unavailable` };
  if (res.timedOut) return { checker, problems: [], skipped: `${checker} timed out` };
  if (res.code === 0 && !res.stderr.trim()) return { checker, problems: [] };
  const problems = parse(res.stderr + '\n' + res.stdout);
  if (res.code !== 0 && !problems.length) {
    const msg = (res.stderr || res.stdout).trim().split('\n').filter(Boolean).pop() ?? 'failed';
    problems.push({ key: msg.replace(/\d+/g, '#'), message: msg.slice(0, 300) });
  }
  return { checker, problems };
}

function parseNodeCheck(out: string): LintProblem[] {
  const lineMatch = /:(\d+)\s*$/m.exec(out.split('\n')[0] ?? '');
  const err = out.split('\n').find(l => /^\w*Error:/.test(l.trim()));
  if (!err) return [];
  return [{ line: lineMatch ? Number(lineMatch[1]) : undefined, key: err.trim(), message: err.trim() }];
}

function parsePython(out: string): LintProblem[] {
  const lines = out.trim().split('\n');
  const err = [...lines].reverse().find(l => /^\w+(Error|Exception)\b/.test(l.trim()));
  if (!err) return [];
  const lm = /line (\d+)/.exec(out);
  return [{ line: lm ? Number(lm[1]) : undefined, key: err.trim(), message: err.trim() }];
}

function parseBash(out: string): LintProblem[] {
  return out.split('\n').filter(l => /line \d+:/.test(l)).map(l => {
    const m = /line (\d+): (.*)$/.exec(l)!;
    return { line: Number(m[1]), key: m[2].trim(), message: m[2].trim() };
  });
}

function parseGofmt(out: string): LintProblem[] {
  return out.split('\n').map(l => /:(\d+):(\d+): (.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ line: Number(m[1]), key: m[3].trim(), message: m[3].trim() }));
}

function lintJson(absPath: string): LintRun {
  let text: string;
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { return { checker: 'json', problems: [], skipped: 'unreadable' }; }
  if (!text.trim()) return { checker: 'json', problems: [] };
  try {
    JSON.parse(text.replace(/^﻿/, ''));
    return { checker: 'json', problems: [] };
  } catch (e) {
    const msg = (e as Error).message;
    const pos = /position (\d+)/.exec(msg);
    const lineM = /line (\d+)/.exec(msg);
    const line = lineM ? Number(lineM[1]) : pos ? text.slice(0, Number(pos[1])).split('\n').length : undefined;
    return { checker: 'json', problems: [{ line, key: msg.replace(/\d+/g, '#'), message: msg }] };
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Which checker (if any) applies to this file. */
export function checkerFor(absPath: string): string | null {
  const base = path.basename(absPath).toLowerCase();
  const ext = path.extname(base);
  if (ext === '.json') {
    // JSON-with-comments files.
    if (/^(tsconfig|jsconfig)(\..*)?\.json$/.test(base) || base.endsWith('.code-workspace') || absPath.includes(`${path.sep}.vscode${path.sep}`)) return null;
    return 'json';
  }
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext) && !base.endsWith('.d.ts')) return 'tsc';
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'node';
  if (ext === '.py') return 'python';
  if (ext === '.sh' || ext === '.bash') return 'bash';
  if (ext === '.go') return 'gofmt';
  return null;
}

async function lintOne(absPath: string, checker: string, opts: LintOptions): Promise<LintRun> {
  switch (checker) {
    case 'json': return lintJson(absPath);
    case 'node': return lintWithCommand('node --check', process.execPath, ['--check', absPath], absPath, opts, parseNodeCheck);
    case 'python': return lintWithCommand('python', 'python3', ['-c',
      'import ast,sys\nsrc=open(sys.argv[1],encoding="utf-8").read()\ncompile(src,sys.argv[1],"exec",ast.PyCF_ONLY_AST)', absPath],
      absPath, opts, parsePython);
    case 'bash': return lintWithCommand('bash -n', 'bash', ['-n', absPath], absPath, opts, parseBash);
    case 'gofmt': return lintWithCommand('gofmt', 'gofmt', ['-l', '-e', absPath], absPath, opts, parseGofmt);
    default: return { checker, problems: [], skipped: 'no checker' };
  }
}

/**
 * Run the checkers for files as they are on disk now (TypeScript files of
 * one project share a single tsc run). A file with no applicable checker
 * maps to null. Never throws.
 */
export async function lintFiles(absPaths: string[], opts: LintOptions): Promise<Map<string, LintRun | null>> {
  const out = new Map<string, LintRun | null>();
  const tsGroups = new Map<string, string[]>();
  for (const p of absPaths) {
    const checker = checkerFor(p);
    if (!checker) { out.set(p, null); continue; }
    if (!fs.existsSync(p)) { out.set(p, { checker, problems: [] }); continue; }
    if (checker === 'tsc') {
      const key = findTsconfig(p, opts.workspace) ?? '';
      tsGroups.set(key, [...(tsGroups.get(key) ?? []), p]);
      continue;
    }
    try {
      out.set(p, await lintOne(p, checker, opts));
    } catch (e) {
      out.set(p, { checker, problems: [], skipped: (e as Error).message });
    }
  }
  for (const [tsconfig, files] of tsGroups) {
    try {
      for (const [p, r] of await lintTypeScriptProject(tsconfig || null, files, opts)) out.set(p, r);
    } catch (e) {
      for (const p of files) out.set(p, { checker: 'tsc', problems: [], skipped: (e as Error).message });
    }
  }
  return out;
}

/** Single-file convenience wrapper around lintFiles. */
export async function lintFile(absPath: string, opts: LintOptions): Promise<LintRun | null> {
  return (await lintFiles([absPath], opts)).get(absPath) ?? null;
}

/**
 * Format the delta between two runs for the tool result. Returns undefined
 * when no checker applies.
 */
export function formatLintDelta(before: LintRun | null, after: LintRun | null): string | undefined {
  if (!after) return undefined;
  if (after.skipped) return `lint: skipped (${after.skipped})`;
  const remaining = new Map<string, number>();
  for (const p of before?.skipped ? [] : before?.problems ?? []) remaining.set(p.key, (remaining.get(p.key) ?? 0) + 1);
  const fresh: LintProblem[] = [];
  for (const p of after.problems) {
    const n = remaining.get(p.key) ?? 0;
    if (n > 0) remaining.set(p.key, n - 1);
    else fresh.push(p);
  }
  const preExisting = after.problems.length - fresh.length;
  const fixed = [...remaining.values()].reduce((a, b) => a + b, 0);
  if (!fresh.length) {
    if (!after.problems.length) return fixed ? `lint: clean (${after.checker}; fixed ${fixed})` : `lint: clean (${after.checker})`;
    return `lint: no new problems (${after.checker}; ${preExisting} pre-existing, not caused by this edit)`;
  }
  const shown = fresh.slice(0, 8).map(p => `  ${p.line !== undefined ? `L${p.line}: ` : ''}${p.message.slice(0, 240)}`);
  if (fresh.length > 8) shown.push(`  … +${fresh.length - 8} more`);
  return `lint: ${fresh.length} new problem(s) from this edit (${after.checker}) — fix these:\n${shown.join('\n')}`;
}

/**
 * Cache of lint runs keyed by file content hash, so the "before" run of the
 * next edit reuses the "after" run of the previous one.
 */
export class LintCache {
  private entries = new Map<string, { hash: string; run: LintRun; at: number }>();
  constructor(private readonly ttlMs = 120_000, private readonly max = 500) {}

  get(absPath: string, hash: string, now = Date.now()): LintRun | undefined {
    const e = this.entries.get(absPath);
    if (!e || e.hash !== hash || now - e.at > this.ttlMs) return undefined;
    return e.run;
  }

  set(absPath: string, hash: string, runResult: LintRun, now = Date.now()): void {
    this.entries.delete(absPath);
    this.entries.set(absPath, { hash, run: runResult, at: now });
    while (this.entries.size > this.max) {
      const k = this.entries.keys().next().value;
      if (k === undefined) break;
      this.entries.delete(k);
    }
  }
}
