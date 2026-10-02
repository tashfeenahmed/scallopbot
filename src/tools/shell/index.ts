/**
 * Shell tools: native `bash` and `process` (background process control).
 *
 * Wire with one call: `registerShellTools(skillRegistry, deps)`.
 */

import { defineSkill } from '../../skills/sdk.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { SkillHandlerContext } from '../../skills/types.js';
import { formatRuntime, runBash, type BashToolDeps, type ToolResult } from './bash.js';
import { explainExitCode } from './analysis.js';
import { backgroundProcesses, type BackgroundProcessManager } from './process-manager.js';

export { runBash, resolveTimeoutMs, DEFAULT_TIMEOUT_MS, OUTPUT_CAP_CHARS } from './bash.js';
export type { BashToolDeps } from './bash.js';
export { checkShellFloor, shellFloorEnabled } from './floor.js';
export { explainExitCode, detectMaskingWarnings, curlHttpErrorHint, VERIFY_COMMAND_RE } from './analysis.js';
export {
  backgroundProcesses,
  BackgroundProcessManager,
  formatBashDone,
  type BackgroundExitEvent,
  type ManagedProcess,
} from './process-manager.js';
export { createBashDoneRouter, type BashDoneRouterDeps } from './notify.js';

export interface ShellToolDeps extends BashToolDeps {
  manager?: BackgroundProcessManager;
}

const BASH_DESCRIPTION = [
  'Run a shell command with bash -c in the workspace. Use it for builds, tests, git, package managers, scripts and system state.',
  'The first line of the result is the exit code (0 = success, otherwise explained). Output over 50k chars is cut to head+tail and the full text is saved to a file you can page with read_file.',
  'Default timeout 180s; a command still running then is moved to the background (not killed) and you get its id.',
  'For long jobs (servers, watchers, long builds/tests) pass background:true: it returns {pid,id,log} at once and a [bash-done id:N pid:P exit:M] message arrives when it exits.',
  'Never sleep or poll in a loop waiting for a background job; end your turn and you will be woken. Use the process tool to inspect or stop it sooner.',
  'Prefer `&&` over `;`, and avoid `|| true` / `| tail` patterns that hide the real exit code (or use set -o pipefail).',
].join(' ');

const PROCESS_DESCRIPTION = [
  'Manage background bash processes started with background:true or moved to the background after the timeout.',
  'Actions: list (all of this session\'s processes), poll (status + last 20 lines), log (lines from the full log; offset is a 1-based line number, limit lines, default last 200),',
  'wait (block until it exits, timeout seconds default 60, max 600), kill (SIGTERM then SIGKILL), write (send input to stdin; include "\\n" to submit a line).',
  'You do not need to poll: a [bash-done] message arrives on exit.',
].join(' ');

function statusLine(p: ReturnType<BackgroundProcessManager['get']>): string {
  if (!p) return '';
  const runtime = formatRuntime((p.endedAt ?? Date.now()) - p.startedAt);
  if (p.status === 'running') return `id ${p.id} pid ${p.pid} running ${runtime}`;
  const why = explainExitCode(p.exitCode ?? 1);
  return `id ${p.id} pid ${p.pid} ${p.status} exit ${p.exitCode}${why ? ` (${why})` : ''} after ${runtime}`;
}

function parseId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export async function runProcessAction(
  args: Record<string, unknown>,
  ctx: Pick<SkillHandlerContext, 'sessionId' | 'userId'>,
  manager: BackgroundProcessManager = backgroundProcesses,
): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (action === 'list') {
    const procs = manager.list(ctx.sessionId, ctx.userId);
    if (procs.length === 0) return { success: true, output: 'No background processes.' };
    const rows = procs.map(p => `${statusLine(p)} | ${p.command.replace(/\s+/g, ' ').slice(0, 120)}`);
    return { success: true, output: rows.join('\n') };
  }

  const id = parseId(args.id);
  if (id === null) return { success: false, output: `process ${action || '?'}: "id" is required (see action:"list")` };
  const proc = manager.find(id, ctx.sessionId, ctx.userId);
  if (!proc) return { success: false, output: `No background process with id ${id} in this session (see action:"list").` };

  switch (action) {
    case 'poll': {
      const tail = manager.tail(id, 20);
      return { success: true, output: `${statusLine(proc)}\nlog: ${proc.logPath}\n\n${tail.trim() ? tail : '(no output yet)'}` };
    }
    case 'log': {
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit
        : typeof args.lines === 'number' ? args.lines : 200;
      const read = manager.readLog(id, offset, limit);
      if (read.total === 0) return { success: true, output: `${statusLine(proc)}\n(log is empty)` };
      return {
        success: true,
        output: `${statusLine(proc)}\nlines ${read.from}-${read.to} of ${read.total} (${proc.logPath})\n\n${read.text}`,
      };
    }
    case 'wait': {
      const seconds = typeof args.timeout === 'number' && args.timeout > 0 ? Math.min(args.timeout, 600) : 60;
      const exited = await manager.wait(id, seconds * 1000);
      const tail = manager.tail(id, 20);
      return {
        success: true,
        output: `${exited ? '' : `still running after waiting ${seconds}s. `}${statusLine(manager.get(id) ?? proc)}\n\n${tail.trim() ? tail : '(no output)'}`,
      };
    }
    case 'kill': {
      if (proc.status !== 'running') return { success: true, output: `already finished: ${statusLine(proc)}` };
      manager.kill(id);
      await manager.wait(id, 4_000);
      return { success: true, output: `kill sent. ${statusLine(manager.get(id) ?? proc)}` };
    }
    case 'write': {
      const input = typeof args.input === 'string' ? args.input : '';
      if (!input) return { success: false, output: 'process write: "input" is required' };
      const res = manager.write(id, input);
      return res.ok
        ? { success: true, output: `wrote ${input.length} chars to stdin of process ${id}` }
        : { success: false, output: res.error ?? 'write failed' };
    }
    default:
      return { success: false, output: `Unknown action "${action}". Use list, poll, log, wait, kill or write.` };
  }
}

/** Register the native `bash` and `process` tools. */
export function registerShellTools(registry: Pick<SkillRegistry, 'registerSkill'>, deps: ShellToolDeps = {}): void {
  const bash = defineSkill('bash', BASH_DESCRIPTION)
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
        timeout: { type: 'number', description: 'Foreground timeout in seconds (default 180, max 600). When it passes, the command keeps running in the background.' },
        background: { type: 'boolean', description: 'Start in the background and return {pid,id,log} immediately. Use for servers, watchers and long jobs.' },
        cwd: { type: 'string', description: 'Working directory, relative to the workspace or absolute (default: workspace)' },
      },
      required: ['command'],
    })
    .onNativeExecute(ctx => runBash(ctx.args, ctx, deps))
    .build();
  registry.registerSkill(bash.skill);

  const proc = defineSkill('process', PROCESS_DESCRIPTION)
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'poll', 'log', 'wait', 'kill', 'write'], description: 'What to do' },
        id: { type: 'number', description: 'Process id from bash (not the OS pid); required except for list' },
        timeout: { type: 'number', description: 'wait: seconds to block (default 60, max 600)' },
        input: { type: 'string', description: 'write: text to send to stdin' },
        offset: { type: 'number', description: 'log: 1-based line to start from (default: the last `limit` lines)' },
        limit: { type: 'number', description: 'log: number of lines (default 200, max 2000)' },
        lines: { type: 'number', description: 'log: alias for limit' },
      },
      required: ['action'],
    })
    .onNativeExecute(ctx => runProcessAction(ctx.args, ctx, deps.manager ?? backgroundProcesses))
    .build();
  registry.registerSkill(proc.skill);
}
