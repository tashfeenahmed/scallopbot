/**
 * Verification evidence ledger.
 *
 * Tracks, per session, when code was edited and which verify commands (tests,
 * type checks, linters, builds) ran with which exit code. When the model is
 * about to finish after editing code without a fresh passing run,
 * {@link verifyOnStopNudge} returns one line naming the verify commands to run.
 * It is a nudge, never a block.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { VERIFY_COMMAND_RE, exitCodeIsMasked } from '../shell/analysis.js';

interface VerifyRun {
  command: string;
  exitCode: number;
  /** The exit code was hidden by `|| true`, a pipe into tail, etc. */
  masked: boolean;
  seq: number;
}

interface SessionLedger {
  seq: number;
  lastEditSeq: number;
  editedPaths: string[];
  runs: VerifyRun[];
  lastCwd?: string;
}

const ledgers = new Map<string, SessionLedger>();
const MAX_RUNS = 50;

const CODE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.rb', '.php', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs', '.swift',
  '.scala', '.sh', '.bash', '.zsh', '.vue', '.svelte', '.astro', '.css', '.scss', '.sass',
  '.less', '.html', '.sql', '.dart', '.ex', '.exs', '.erl', '.hs', '.ml', '.lua', '.r', '.jl',
  '.zig', '.nim', '.m', '.mm', '.gradle', '.tf',
]);
const CODE_FILES = new Set(['Makefile', 'Dockerfile', 'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);

function ledger(sessionId: string): SessionLedger {
  let l = ledgers.get(sessionId);
  if (!l) {
    l = { seq: 0, lastEditSeq: 0, editedPaths: [], runs: [] };
    ledgers.set(sessionId, l);
  }
  return l;
}

/** True for files whose edits should be verified (source, styles, build config). */
export function isCodePath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (CODE_FILES.has(base)) return true;
  return CODE_EXT.has(path.extname(base).toLowerCase());
}

/** Extract the verify command(s) from a shell command, e.g. `npx vitest run`. */
export function detectVerifyCommands(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const s = segment.trim();
    if (s && VERIFY_COMMAND_RE.test(s)) out.push(s.replace(/^(?:set\s+-o\s+pipefail\s*)/, '').slice(0, 120));
  }
  return out;
}

/** Shell writes to code files (`sed -i`, `> file.ts`, `tee file.py`) count as edits. */
function shellEditedPaths(command: string): string[] {
  const paths: string[] = [];
  for (const m of command.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&<>]+)/g)) {
    if (isCodePath(m[1]) && !m[1].startsWith('/dev/')) paths.push(m[1]);
  }
  if (/\b(?:sed|perl)\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*i/.test(command)) {
    for (const m of command.matchAll(/(\S+\.[A-Za-z0-9]+)(?=\s|$)/g)) {
      const p = m[1].replace(/^["']|["']$/g, '');
      if (isCodePath(p)) paths.push(p);
    }
  }
  return paths;
}

/** Record a finished shell command (called by the bash tool for every command). */
export function recordShellResult(sessionId: string, command: string, exitCode: number, cwd?: string): void {
  const l = ledger(sessionId);
  if (cwd) l.lastCwd = cwd;
  for (const p of shellEditedPaths(command)) {
    recordEdit(sessionId, cwd ? path.resolve(cwd, p) : p);
  }
  const verify = detectVerifyCommands(command);
  if (verify.length === 0) return;
  const masked = exitCodeIsMasked(command);
  l.seq++;
  for (const v of verify) {
    l.runs.push({ command: v, exitCode, masked, seq: l.seq });
  }
  if (l.runs.length > MAX_RUNS) l.runs.splice(0, l.runs.length - MAX_RUNS);
}

/** Record a code edit (call from file tools: write_file, patch, ...). */
export function recordEdit(sessionId: string, filePath: string): void {
  if (!isCodePath(filePath)) return;
  const l = ledger(sessionId);
  l.seq++;
  l.lastEditSeq = l.seq;
  if (!l.editedPaths.includes(filePath)) {
    l.editedPaths.push(filePath);
    if (l.editedPaths.length > 20) l.editedPaths.shift();
  }
}

/** Find the nearest directory at or above `start` containing `name`. */
function findUp(start: string, name: string, maxDepth = 8): string | null {
  let dir = start;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Likely verify commands for a project, from package.json scripts and marker files. */
export function suggestVerifyCommands(fromDir: string): string[] {
  const suggestions: string[] = [];
  const pkgDir = findUp(fromDir, 'package.json');
  if (pkgDir) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const runner = existsSync(path.join(pkgDir, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(path.join(pkgDir, 'yarn.lock')) ? 'yarn' : 'npm';
      for (const name of ['typecheck', 'type-check', 'test', 'lint', 'build']) {
        const body = scripts[name];
        if (!body) continue;
        // `vitest` alone is watch mode; point at a one-shot run instead.
        if (name === 'test' && /^\s*vitest\s*$/.test(body)) suggestions.push('npx vitest run');
        else if (name === 'test') suggestions.push(`${runner} test`);
        else suggestions.push(`${runner} run ${name}`);
      }
      if (!scripts.typecheck && !scripts['type-check'] && existsSync(path.join(pkgDir, 'tsconfig.json'))) {
        suggestions.unshift('npx tsc --noEmit');
      }
    } catch {
      // Unreadable package.json: fall through to other markers.
    }
  }
  if (findUp(fromDir, 'pyproject.toml') || findUp(fromDir, 'pytest.ini')) suggestions.push('pytest');
  if (findUp(fromDir, 'Cargo.toml')) suggestions.push('cargo test');
  if (findUp(fromDir, 'go.mod')) suggestions.push('go test ./...');
  return [...new Set(suggestions)].slice(0, 4);
}

/**
 * One-line nudge when code was edited after the last passing verify run, else
 * null. Names the verify commands already used this session, or suggests
 * likely ones from the project files.
 */
export function verifyOnStopNudge(sessionId: string, opts: { workspace?: string } = {}): string | null {
  const l = ledgers.get(sessionId);
  if (!l || l.lastEditSeq === 0) return null;
  const freshPass = l.runs.some(r => r.seq > l.lastEditSeq && r.exitCode === 0 && !r.masked);
  if (freshPass) return null;

  const edited = l.editedPaths.slice(-3).map(p => path.basename(p)).join(', ');
  const used = [...new Set(l.runs.map(r => r.command))].slice(-3);
  const lastAfterEdit = [...l.runs].reverse().find(r => r.seq > l.lastEditSeq);

  let commands: string[] = used;
  if (commands.length === 0) {
    const lastEdited = l.editedPaths[l.editedPaths.length - 1];
    const fromDir = lastEdited && path.isAbsolute(lastEdited)
      ? path.dirname(lastEdited)
      : (l.lastCwd ?? opts.workspace ?? process.cwd());
    commands = suggestVerifyCommands(fromDir);
  }
  const list = commands.length > 0 ? commands.map(c => `\`${c}\``).join(', ') : 'the project\'s tests or type check';
  const status = lastAfterEdit
    ? lastAfterEdit.masked
      ? `the last run of \`${lastAfterEdit.command}\` hid its exit code`
      : `the last run of \`${lastAfterEdit.command}\` exited ${lastAfterEdit.exitCode}`
    : 'no verify command has passed since';
  return `[verify] You edited code (${edited}) and ${status}. Run ${list} and check it passes before you finish, or say plainly that it is unverified.`;
}

/** Inspect the ledger (tests and debugging). */
export function getLedgerState(sessionId: string): Readonly<SessionLedger> | undefined {
  return ledgers.get(sessionId);
}

export function clearLedger(sessionId?: string): void {
  if (sessionId === undefined) ledgers.clear();
  else ledgers.delete(sessionId);
}
