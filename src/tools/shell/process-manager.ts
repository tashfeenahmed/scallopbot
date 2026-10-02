/**
 * Background process manager (one per gateway process).
 *
 * Every bash command is spawned through here. Output (stdout and stderr,
 * interleaved) streams to a log file in the session's tool-output dir and into
 * an in-memory ring of recent lines. A foreground command that outlives its
 * timeout is simply adopted as a background process instead of being killed.
 *
 * When a background process exits, the manager emits an `exit` event
 * ({@link BackgroundExitEvent}); the gateway turns it into a
 * `[bash-done ...]` message for the owning session.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { exitCodeForSignal } from './analysis.js';

export type ProcessStatus = 'running' | 'exited' | 'killed';

export interface BackgroundExitEvent {
  sessionId: string;
  userId?: string;
  id: number;
  pid: number;
  exitCode: number;
  signal?: string | null;
  command: string;
  /** Last lines of output (up to 20). */
  tail: string;
  runtimeMs: number;
  log: string;
}

export interface SpawnSpec {
  /** The command as the model wrote it (for display and notices). */
  command: string;
  /** Program and args actually spawned (already sandbox-wrapped). */
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  sessionId: string;
  userId?: string;
  logPath: string;
  /** Background from the start: keep stdin open for `process write`. */
  background: boolean;
  /** Called once when the process has fully finished (foreground or background). */
  onFinish?: (proc: ManagedProcess) => void;
}

export interface ManagedProcess {
  id: number;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  userId?: string;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  /** True once the process is a background process (explicitly or adopted after timeout). */
  background: boolean;
  /** stdin still writable. */
  stdinOpen: boolean;
  bytes: number;
  /** Resolves when the process has exited and its log is flushed. */
  done: Promise<void>;
}

interface Internal extends ManagedProcess {
  child: ChildProcess;
  log: WriteStream;
  ring: string[];
  partial: string;
  waiters: number;
  killedByAgent: boolean;
  finalized: boolean;
  resolveDone: () => void;
  onFinish?: (proc: ManagedProcess) => void;
}

const RING_LINES = 500;
const MAX_LINE = 2_000;
const MAX_KEPT_PER_SESSION = 30;
const CLOSE_GRACE_MS = 1_500;

export const NOTICE_TAIL_LINES = 20;

/** `[bash-done id:N pid:P exit:M] <command>` followed by the last output lines. */
export function formatBashDone(e: Pick<BackgroundExitEvent, 'id' | 'pid' | 'exitCode' | 'command' | 'tail'>): string {
  const head = `[bash-done id:${e.id} pid:${e.pid} exit:${e.exitCode}] ${e.command.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  const tail = e.tail.trimEnd();
  return tail ? `${head}\n${tail}` : `${head}\n(no output)`;
}

export class BackgroundProcessManager extends EventEmitter {
  private procs = new Map<number, Internal>();
  private nextId = 1;

  /** Spawn a command. Throws only if `spawn` itself throws synchronously. */
  start(spec: SpawnSpec): ManagedProcess {
    const log = createWriteStream(spec.logPath, { flags: 'a' });
    const child = spawn(spec.program, spec.args, {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so kill() reaches the whole tree.
      detached: process.platform !== 'win32',
    });
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const proc: Internal = {
      id: this.nextId++,
      pid: child.pid ?? -1,
      command: spec.command,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      userId: spec.userId,
      logPath: spec.logPath,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      background: spec.background,
      stdinOpen: spec.background,
      bytes: 0,
      done,
      child,
      log,
      ring: [],
      partial: '',
      waiters: 0,
      killedByAgent: false,
      finalized: false,
      resolveDone,
      onFinish: spec.onFinish,
    };
    this.procs.set(proc.id, proc);

    // Swallow EPIPE when the child exits before reading stdin.
    child.stdin?.on('error', () => { proc.stdinOpen = false; });
    if (!spec.background) {
      child.stdin?.end();
    }

    const onData = (chunk: Buffer) => {
      proc.bytes += chunk.length;
      log.write(chunk);
      this.appendRing(proc, chunk.toString('utf8'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    child.on('exit', (code, signal) => {
      proc.exitCode = code ?? exitCodeForSignal(signal);
      proc.signal = signal;
      // Grandchildren that inherited stdout can keep 'close' from firing.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.finalize(proc);
      }, CLOSE_GRACE_MS);
      graceTimer.unref?.();
    });
    child.on('close', (code, signal) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (proc.exitCode === null) {
        proc.exitCode = code ?? exitCodeForSignal(signal);
        proc.signal = signal;
      }
      this.finalize(proc);
    });
    child.on('error', (err) => {
      const msg = `failed to start: ${err.message}\n`;
      log.write(msg);
      this.appendRing(proc, msg);
      if (proc.exitCode === null) proc.exitCode = 127;
      this.finalize(proc);
    });

    this.prune(spec.sessionId);
    return proc;
  }

  private appendRing(proc: Internal, text: string): void {
    const combined = proc.partial + text;
    const lines = combined.split('\n');
    proc.partial = lines.pop() ?? '';
    if (proc.partial.length > MAX_LINE * 4) {
      lines.push(proc.partial);
      proc.partial = '';
    }
    for (const line of lines) {
      proc.ring.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    }
    if (proc.ring.length > RING_LINES) proc.ring.splice(0, proc.ring.length - RING_LINES);
  }

  private finalize(proc: Internal): void {
    if (proc.finalized) return;
    proc.finalized = true;
    proc.endedAt = Date.now();
    proc.status = proc.killedByAgent ? 'killed' : 'exited';
    if (proc.exitCode === null) proc.exitCode = 1;
    proc.stdinOpen = false;
    if (proc.partial) {
      proc.ring.push(proc.partial);
      proc.partial = '';
    }
    proc.log.end(() => {
      proc.resolveDone();
      try {
        proc.onFinish?.(proc);
      } catch {
        // Ledger hooks must never break process bookkeeping.
      }
      // Notify only for background work nobody is already watching.
      if (proc.background && !proc.killedByAgent && proc.waiters === 0) {
        const event: BackgroundExitEvent = {
          sessionId: proc.sessionId,
          userId: proc.userId,
          id: proc.id,
          pid: proc.pid,
          exitCode: proc.exitCode!,
          signal: proc.signal,
          command: proc.command,
          tail: this.tail(proc.id, NOTICE_TAIL_LINES),
          runtimeMs: proc.endedAt! - proc.startedAt,
          log: proc.logPath,
        };
        this.emit('exit', event);
      }
    });
  }

  /** Keep the last MAX_KEPT_PER_SESSION finished entries per session. */
  private prune(sessionId: string): void {
    const finished = [...this.procs.values()]
      .filter(p => p.sessionId === sessionId && p.status !== 'running')
      .sort((a, b) => a.id - b.id);
    while (finished.length > MAX_KEPT_PER_SESSION) {
      const old = finished.shift()!;
      this.procs.delete(old.id);
    }
  }

  get(id: number): ManagedProcess | undefined {
    return this.procs.get(id);
  }

  /** Processes visible to a session: its own, plus same-user ones from its sub-agents. */
  list(sessionId?: string, userId?: string): ManagedProcess[] {
    return [...this.procs.values()].filter(p =>
      p.background && (
        sessionId === undefined
        || p.sessionId === sessionId
        || (userId !== undefined && p.userId === userId)
      ),
    );
  }

  /** Look up a process the caller may act on. */
  find(id: number, sessionId: string, userId?: string): ManagedProcess | undefined {
    const p = this.procs.get(id);
    if (!p) return undefined;
    if (p.sessionId === sessionId || (userId !== undefined && p.userId === userId)) return p;
    return undefined;
  }

  /** Turn a still-running foreground command into a background process. */
  adopt(id: number): void {
    const p = this.procs.get(id);
    if (p) p.background = true;
  }

  /** Drop a finished foreground command from the table. */
  forget(id: number): void {
    const p = this.procs.get(id);
    if (p && p.status !== 'running') this.procs.delete(id);
  }

  /** Last `n` lines of output (including a trailing partial line). */
  tail(id: number, n = NOTICE_TAIL_LINES): string {
    const p = this.procs.get(id);
    if (!p) return '';
    const lines = p.partial ? [...p.ring, p.partial] : p.ring;
    return lines.slice(-n).join('\n');
  }

  /**
   * Read lines from the full log. `offset` is a 1-based line number; when
   * omitted the last `limit` lines are returned.
   */
  readLog(id: number, offset?: number, limit = 200): { text: string; from: number; to: number; total: number } {
    const p = this.procs.get(id);
    if (!p || !existsSync(p.logPath)) return { text: '', from: 0, to: 0, total: 0 };
    const lines = readFileSync(p.logPath, 'utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const count = Math.max(1, Math.min(limit, 2_000));
    const start = offset && offset > 0 ? Math.min(offset - 1, total) : Math.max(0, total - count);
    const slice = lines.slice(start, start + count);
    return { text: slice.join('\n'), from: slice.length ? start + 1 : 0, to: start + slice.length, total };
  }

  /**
   * Wait up to `timeoutMs` for the process to finish. While a caller waits,
   * the exit notice is suppressed because the caller sees the result directly.
   */
  async wait(id: number, timeoutMs: number): Promise<boolean> {
    const p = this.procs.get(id);
    if (!p) return false;
    if (p.status !== 'running' && p.finalized) {
      await p.done;
      return true;
    }
    p.waiters++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p.done.then(() => true),
        new Promise<boolean>(r => { timer = setTimeout(() => r(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      p.waiters--;
    }
  }

  /** Write to the process's stdin. */
  write(id: number, input: string): { ok: boolean; error?: string } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `no process with id ${id}` };
    if (p.status !== 'running') return { ok: false, error: `process ${id} has already exited` };
    if (!p.stdinOpen || !p.child.stdin || p.child.stdin.destroyed) {
      return { ok: false, error: `stdin of process ${id} is closed (only processes started with background:true keep stdin open)` };
    }
    p.child.stdin.write(input);
    return { ok: true };
  }

  /** Kill the process group: SIGTERM, then SIGKILL after `graceMs`. */
  kill(id: number, graceMs = 3_000, byAgent = true): boolean {
    const p = this.procs.get(id);
    if (!p || p.status !== 'running') return false;
    if (byAgent) p.killedByAgent = true;
    this.signal(p, 'SIGTERM');
    const t = setTimeout(() => {
      if (!p.finalized) this.signal(p, 'SIGKILL');
    }, graceMs);
    t.unref?.();
    return true;
  }

  private signal(p: Internal, sig: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && p.pid > 0) process.kill(-p.pid, sig);
      else p.child.kill(sig);
    } catch {
      try { p.child.kill(sig); } catch { /* already gone */ }
    }
  }

  /** Kill everything (gateway shutdown). Resolves once all are gone or after `graceMs` + SIGKILL. */
  async killAll(graceMs = 1_000): Promise<void> {
    const running = [...this.procs.values()].filter(p => p.status === 'running');
    for (const p of running) {
      p.killedByAgent = true;
      this.signal(p, 'SIGTERM');
    }
    if (running.length === 0) return;
    const allDone = Promise.all(running.map(p => p.done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      allDone.then(() => true),
      new Promise<boolean>(r => { timer = setTimeout(() => r(false), graceMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      for (const p of running) if (!p.finalized) this.signal(p, 'SIGKILL');
    }
  }

  /** Test helper: forget everything without killing. */
  reset(): void {
    this.procs.clear();
    this.removeAllListeners();
  }
}

/** The gateway-wide singleton. Subscribe with `backgroundProcesses.on('exit', ...)`. */
export const backgroundProcesses = new BackgroundProcessManager();
