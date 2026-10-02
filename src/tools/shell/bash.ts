/**
 * Native `bash` tool.
 *
 * - Runs `bash -c <command>` through the optional sandbox (SANDBOX_MODE).
 * - First line of the result is the exit code, with an explanation when it is
 *   not 0. Warnings follow when the command's shape can hide a failure.
 * - Output is capped at 50k chars (40% head, 60% tail); bigger output stays
 *   on disk and the result gives the path.
 * - A foreground command that runs past its timeout (default 180s) is not
 *   killed: it becomes a background process and the result gives its handle.
 * - `background: true` returns a handle at once; a `[bash-done ...]` message
 *   arrives when it exits.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { SkillHandlerContext } from '../../skills/types.js';
import type { Skill } from '../../skills/types.js';
import { buildSkillSubprocessEnv } from '../../skills/executor.js';
import { loadSandboxConfig, prepareSandboxedCommand } from '../../security/sandbox/index.js';
import { readFileHeadTail, toolOutputDir, toolOutputStem } from '../tool-output.js';
import { recordShellResult } from '../verify/ledger.js';
import { checkShellFloor } from './floor.js';
import { curlHttpErrorHint, detectMaskingWarnings, explainExitCode } from './analysis.js';
import { backgroundProcesses, NOTICE_TAIL_LINES, type BackgroundProcessManager, type ManagedProcess } from './process-manager.js';

export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000;
export const OUTPUT_CAP_CHARS = 50_000;
export const OUTPUT_HEAD_RATIO = 0.4;

export interface BashToolDeps {
  manager?: BackgroundProcessManager;
  /** Override the default foreground timeout (tests). */
  defaultTimeoutMs?: number;
  /** Override the output cap (tests). */
  outputCapChars?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BashArgs {
  command?: unknown;
  timeout?: unknown;
  background?: unknown;
  cwd?: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

const BASH_SKILL_IDENTITY = {
  name: 'bash',
  description: 'bash',
  path: '',
  source: 'sdk',
  frontmatter: { name: 'bash', description: 'bash' },
  content: '',
  available: true,
  hasScripts: true,
} as unknown as Skill;

/** Least-privilege env (no provider keys or bot tokens), same as the old skill subprocess. */
function shellEnv(ctx: SkillHandlerContext, workspace: string): Record<string, string> {
  const env = buildSkillSubprocessEnv(BASH_SKILL_IDENTITY, {
    skillName: 'bash',
    cwd: workspace,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  });
  delete env.SKILL_ARGS;
  delete env.SKILL_DIR;
  delete env.SKILL_NAME;
  return env;
}

/** `timeout` is seconds; values above 600 are taken as milliseconds (the old schema). */
export function resolveTimeoutMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallbackMs;
  const ms = raw > 600 ? raw : raw * 1000;
  return Math.min(Math.max(ms, 10), MAX_FOREGROUND_TIMEOUT_MS);
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function fail(output: string): ToolResult {
  return { success: false, output };
}

function formatRuntime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 120) return `${s}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export { formatRuntime };

function handleText(proc: ManagedProcess): string {
  return JSON.stringify({ pid: proc.pid, id: proc.id, log: proc.logPath });
}

/** Build the final result text for a finished foreground command. */
function finishedResult(proc: ManagedProcess, command: string, capChars: number): ToolResult {
  const exitCode = proc.exitCode ?? 1;
  const lines: string[] = [];
  const why = explainExitCode(exitCode);
  lines.push(why ? `exit code: ${exitCode} (${why})` : 'exit code: 0');

  let body = '';
  let truncated = false;
  let bytes = 0;
  try {
    const read = readFileHeadTail(proc.logPath, capChars, OUTPUT_HEAD_RATIO);
    body = read.text;
    truncated = read.truncated;
    bytes = read.bytes;
  } catch {
    body = '';
  }

  for (const w of detectMaskingWarnings(command)) lines.push(`warning: ${w}`);
  const curlHint = curlHttpErrorHint(command, body, exitCode);
  if (curlHint) lines.push(`hint: ${curlHint}`);

  if (truncated) {
    lines.push(
      `output: ${bytes} bytes, too long to show in full. Full output saved to ${proc.logPath} (use read_file with offset/limit to read it). Showing the first 40% and last 60%.`,
    );
  } else {
    try { rmSync(proc.logPath, { force: true }); } catch { /* best effort */ }
  }
  lines.push('');
  lines.push(body.trim() === '' ? '(no output)' : body.replace(/\s+$/, ''));
  return { success: exitCode === 0, output: lines.join('\n') };
}

export async function runBash(
  args: BashArgs,
  ctx: SkillHandlerContext,
  deps: BashToolDeps = {},
): Promise<ToolResult> {
  const manager = deps.manager ?? backgroundProcesses;
  const env = deps.env ?? process.env;
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) return fail('Missing required parameter: command');

  const floor = checkShellFloor(command, env);
  if (floor.blocked) {
    return fail(
      `exit code: 126 (refused: ${floor.reason}). This command would destroy the disk or the home directory, so it is never run. If you meant a narrower path, name it explicitly.`,
    );
  }

  const workspace = path.resolve(ctx.workspace || env.AGENT_WORKSPACE || process.cwd());
  const cwd = typeof args.cwd === 'string' && args.cwd.trim()
    ? path.resolve(workspace, args.cwd.replace(/^~(?=$|\/)/, env.HOME ?? '~'))
    : workspace;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return fail(`exit code: 1 (cwd does not exist or is not a directory: ${cwd})`);
  }
  const sandboxed = loadSandboxConfig(env).mode !== 'off';
  if (sandboxed && !isInside(workspace, cwd)) {
    return fail(`exit code: 126 (cwd ${cwd} is outside the workspace ${workspace}; the sandbox only exposes the workspace)`);
  }

  const background = args.background === true || args.background === 'true';
  const timeoutMs = resolveTimeoutMs(args.timeout, deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  const prepared = prepareSandboxedCommand({
    argv: ['bash', '-c', command],
    cwd,
    workspace,
    env: shellEnv(ctx, workspace),
  }, env);
  if (!prepared.ok) {
    return fail(`exit code: 126 (${prepared.error})`);
  }
  const { wrapped } = prepared;

  let logPath: string;
  try {
    logPath = path.join(toolOutputDir(ctx.sessionId, env), `${toolOutputStem('bash')}.txt`);
  } catch (err) {
    return fail(`exit code: 1 (cannot create the tool-output directory: ${(err as Error).message})`);
  }

  let proc: ManagedProcess;
  try {
    proc = manager.start({
      command,
      program: wrapped.command,
      args: wrapped.args,
      cwd,
      env: wrapped.env,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      logPath,
      background,
      onFinish: (p) => recordShellResult(p.sessionId, p.command, p.exitCode ?? 1, p.cwd),
    });
  } catch (err) {
    return fail(`exit code: 127 (failed to start: ${(err as Error).message})`);
  }

  if (background) {
    return {
      success: true,
      output: [
        `started in background: id ${proc.id}, pid ${proc.pid}`,
        handleText(proc),
        `A [bash-done id:${proc.id} ...] message arrives when it exits. Do not sleep or poll: end your turn or do other work, and you will be woken. Use the process tool (poll/log/wait/kill/write, id ${proc.id}) if you need it sooner.`,
      ].join('\n'),
    };
  }

  // Foreground: wait for exit, the timeout, or the turn deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const outcome = await Promise.race<'exited' | 'timeout' | 'aborted'>([
    proc.done.then(() => 'exited' as const),
    new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs); }),
    new Promise<'aborted'>(r => {
      if (!ctx.signal) return;
      if (ctx.signal.aborted) { r('aborted'); return; }
      onAbort = () => r('aborted');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (onAbort) ctx.signal?.removeEventListener('abort', onAbort);

  if (outcome === 'exited') {
    const result = finishedResult(proc, command, deps.outputCapChars ?? OUTPUT_CAP_CHARS);
    manager.forget(proc.id);
    return result;
  }

  // Still running: adopt it as a background process instead of killing it.
  manager.adopt(proc.id);
  const why = outcome === 'timeout'
    ? `still running after ${formatRuntime(timeoutMs)}`
    : 'still running when the turn deadline hit';
  const tail = manager.tail(proc.id, NOTICE_TAIL_LINES);
  return {
    success: true,
    output: [
      `${why}: moved to background (not killed). id ${proc.id}, pid ${proc.pid}`,
      handleText(proc),
      `A [bash-done id:${proc.id} ...] message arrives when it exits. Do not sleep or poll; use the process tool (wait/poll/log/kill, id ${proc.id}) if you need it sooner.`,
      '',
      tail.trim() ? `last output:\n${tail}` : '(no output yet)',
    ].join('\n'),
  };
}
