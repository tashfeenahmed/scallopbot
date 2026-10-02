/**
 * Host side of one code-mode kernel (one per session).
 *
 * Design for "interrupt keeps variables":
 *  1. Cooperative first. Every cell runs inside an AsyncLocalStorage scope in
 *     the worker. An interrupt rejects the cell's race promise, rejects its
 *     in-flight tool RPCs, aborts the host-side tool calls, and clears the
 *     cell's timers. The worker and all globals stay alive: nothing is lost.
 *  2. A synchronous top-level loop is stopped by vm's own `timeout` (the
 *     worker survives that too).
 *  3. Only if the worker does not answer within `interruptGraceMs` (it is
 *     stuck in synchronous code after an await) do we terminate it, spawn a
 *     new one and restore the snapshot taken after the last finished cell.
 *     Plain data, top-level functions/classes and bash/agent handles come
 *     back; the names that could not be serialized are reported.
 *
 * Snapshots are taken after every cell (in the worker, per variable with
 * v8.serialize; failures are skipped and named) and written to disk so a
 * restarted process resumes with state.
 */

import { Worker } from 'node:worker_threads';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { Logger } from 'pino';
import { CellSyntaxError, transformCell } from './transform.js';

export const DEFAULT_CELL_TIMEOUT_MS = 300_000;
export const OUTPUT_CAP_CHARS = 64_000;

export interface RpcContext {
  /** Kernel-local cell id that issued the call (undefined for background). */
  cellId?: number;
  /** Aborted when the issuing cell is interrupted. */
  signal?: AbortSignal;
}

export type RpcDispatch = (apiPath: string, args: unknown[], ctx: RpcContext) => Promise<unknown>;

export interface KernelOptions {
  sessionId: string;
  workspace: string;
  dispatch: RpcDispatch;
  cellTimeoutMs?: number;
  /** How long to wait for a cooperative interrupt before terminating the worker. */
  interruptGraceMs?: number;
  /** Disk snapshot path; null disables persistence. */
  snapshotFile?: string | null;
  logger?: Logger;
  outputCap?: number;
  /** Extra notes appended to each finished cell (e.g. unawaited bash-done). */
  collectNotes?: () => string[];
}

export interface CellResult {
  /** Cell number as shown in tracebacks (`<cell-N>`). */
  n: number;
  stdout: string;
  stderr: string;
  /** util.inspect of the last expression (raw text for strings). */
  value?: string;
  error?: string;
  interrupted: boolean;
  timedOut: boolean;
  /** Worker was terminated and respawned from the last snapshot. */
  restarted: boolean;
  /** Output printed by earlier cells' callbacks while no cell was running. */
  background?: string;
  /** Kernel notices: restore reports, bash-done, lost variables. */
  notes: string[];
  durationMs: number;
}

export interface SnapshotEntry {
  name: string;
  kind: 'value' | 'source' | 'handle';
  data?: Uint8Array;
  source?: string;
  handle?: { kind: 'bash' | 'agent'; id?: string; label: string };
  proto?: string;
  summary: string;
}

export interface KernelSnapshot {
  version: 1;
  sessionId: string;
  savedAt: number;
  cells: number;
  entries: SnapshotEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface KernelVariable {
  name: string;
  summary: string;
}

interface RunningCell {
  id: number;
  n: number;
  startedAt: number;
  resolve: (result: CellResult) => void;
  abort: AbortController;
  timedOut: boolean;
  interruptRequested: boolean;
  timer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

type WorkerReply = Record<string, any>;

function workerUrl(): URL {
  // Under vitest/tsx this module is .ts and Node strips the worker's types
  // natively; in dist both are .js.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./kernel-worker${ext}`, import.meta.url);
}

export function sanitizeSessionId(sessionId: string): string {
  const clean = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return clean || 'default';
}

export async function readSnapshotFile(file: string): Promise<KernelSnapshot | null> {
  if (!existsSync(file)) return null;
  try {
    const parsed = v8.deserialize(await readFile(file)) as KernelSnapshot;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class Kernel {
  readonly sessionId: string;
  private readonly opts: KernelOptions;
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;
  private cellCounter = 0;
  private nextExecId = 0;
  private running: RunningCell | null = null;
  private replies = new Map<number, (msg: WorkerReply) => void>();
  private nextReplyId = 0;
  private lastSnapshot: KernelSnapshot | null = null;
  private snapshotChain: Promise<void> = Promise.resolve();
  private pendingNotes: string[] = [];
  private disposed = false;
  lastUsedAt = Date.now();

  constructor(opts: KernelOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  get alive(): boolean {
    return this.worker !== null;
  }

  get cells(): number {
    return this.cellCounter;
  }

  /** Add a notice to the next cell result (e.g. a background job finished). */
  addNote(note: string): void {
    this.pendingNotes.push(note);
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('kernel disposed');
    if (this.worker) return;
    if (!this.starting) {
      this.starting = this.spawn(true).finally(() => { this.starting = null; });
    }
    await this.starting;
  }

  private async spawn(loadFromDisk: boolean): Promise<void> {
    const generation = ++this.generation;
    const worker = new Worker(workerUrl(), {
      workerData: { workspace: this.opts.workspace, outputCap: this.opts.outputCap ?? OUTPUT_CAP_CHARS },
      stdout: true,
      stderr: true,
    });
    // Drain the worker's raw stdio (native writes that bypass our capture).
    worker.stdout.resume();
    worker.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerReply) => {
        if (msg?.t === 'ready') {
          worker.off('error', onError);
          resolve();
        }
      };
      const onError = (error: Error) => reject(error);
      worker.once('message', onMessage);
      worker.once('error', onError);
    });
    worker.on('message', (msg: WorkerReply) => this.onMessage(generation, msg));
    worker.on('error', (error) => this.onWorkerGone(generation, `kernel crashed: ${error.message}`));
    worker.on('exit', (code) => this.onWorkerGone(generation, `kernel exited (code ${code})`));
    worker.unref();
    this.worker = worker;

    let snapshot = this.lastSnapshot;
    if (!snapshot && loadFromDisk && this.opts.snapshotFile) {
      snapshot = await readSnapshotFile(this.opts.snapshotFile);
      if (snapshot) this.cellCounter = Math.max(this.cellCounter, snapshot.cells);
    }
    if (snapshot && snapshot.entries.length > 0) {
      const result = await this.request('restore', { entries: snapshot.entries });
      const restored = (result.restored as string[]) ?? [];
      const lost = [
        ...snapshot.skipped.map(item => `${item.name} (${item.reason})`),
        ...((result.failed as Array<{ name: string; reason: string }>) ?? []).map(item => `${item.name} (${item.reason})`),
      ];
      const origin = loadFromDisk && !this.lastSnapshot ? 'saved session' : 'last snapshot';
      this.pendingNotes.push(
        `[kernel-restore] ${restored.length} variable(s) restored from the ${origin}: ${restored.join(', ') || '(none)'}`
        + (lost.length ? `; not restored: ${lost.join(', ')}` : ''),
      );
      this.lastSnapshot = snapshot;
    }
  }

  private onWorkerGone(generation: number, reason: string): void {
    if (generation !== this.generation || !this.worker) return;
    this.worker = null;
    for (const [, reply] of this.replies) reply({ t: 'gone' });
    this.replies.clear();
    const running = this.running;
    if (running) {
      this.finishRunning({
        stdout: '',
        stderr: '',
        error: `${reason}. Variables from the last finished cell are restored on the next exec.`,
        interrupted: true,
        restarted: true,
      });
    }
  }

  private onMessage(generation: number, msg: WorkerReply): void {
    if (generation !== this.generation) return;
    switch (msg.t) {
      case 'done': {
        if (!this.running || this.running.id !== msg.id) return;
        this.finishRunning(msg);
        this.takeSnapshot();
        break;
      }
      case 'rpc': {
        const running = this.running && this.running.id === msg.cell ? this.running : null;
        const ctx: RpcContext = { cellId: msg.cell, signal: running?.abort.signal };
        const reply = (payload: Record<string, unknown>) => {
          if (generation !== this.generation || !this.worker) return;
          try {
            this.worker.postMessage({ t: 'rpc-result', rid: msg.rid, ...payload });
          } catch (error) {
            this.worker.postMessage({ t: 'rpc-result', rid: msg.rid, ok: false, error: `result could not be sent to the kernel: ${(error as Error).message}` });
          }
        };
        this.opts.dispatch(String(msg.path), Array.isArray(msg.args) ? msg.args : [], ctx)
          .then(value => reply({ ok: true, value }))
          .catch((error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        break;
      }
      default: {
        const reply = typeof msg.rid === 'number' ? this.replies.get(msg.rid) : undefined;
        if (reply) {
          this.replies.delete(msg.rid);
          reply(msg);
        }
      }
    }
  }

  private request(type: string, payload: Record<string, unknown> = {}): Promise<WorkerReply> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('kernel not running'));
    const rid = ++this.nextReplyId;
    return new Promise((resolve, reject) => {
      this.replies.set(rid, (msg) => (msg.t === 'gone' ? reject(new Error('kernel stopped')) : resolve(msg)));
      worker.postMessage({ t: type, rid, ...payload });
    });
  }

  private finishRunning(msg: WorkerReply): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    if (running.timer) clearTimeout(running.timer);
    if (running.graceTimer) clearTimeout(running.graceTimer);
    running.abort.abort();
    const notes = [...this.pendingNotes, ...(this.opts.collectNotes?.() ?? [])];
    this.pendingNotes = [];
    running.resolve({
      n: running.n,
      stdout: String(msg.stdout ?? ''),
      stderr: String(msg.stderr ?? ''),
      value: msg.value === undefined ? undefined : String(msg.value),
      error: msg.error === undefined ? undefined : String(msg.error),
      interrupted: Boolean(msg.interrupted),
      timedOut: running.timedOut,
      restarted: Boolean(msg.restarted),
      background: msg.background ? String(msg.background) : undefined,
      notes,
      durationMs: Date.now() - running.startedAt,
    });
  }

  /** Snapshot after a cell; serialized so disk writes never interleave. */
  private takeSnapshot(): void {
    const generation = this.generation;
    this.snapshotChain = this.snapshotChain.then(async () => {
      if (generation !== this.generation || !this.worker) return;
      try {
        const reply = await this.request('snapshot');
        const snapshot: KernelSnapshot = {
          version: 1,
          sessionId: this.sessionId,
          savedAt: Date.now(),
          cells: this.cellCounter,
          entries: (reply.entries as SnapshotEntry[]) ?? [],
          skipped: (reply.skipped as KernelSnapshot['skipped']) ?? [],
        };
        this.lastSnapshot = snapshot;
        if (this.opts.snapshotFile) await this.writeSnapshot(this.opts.snapshotFile, snapshot);
      } catch (error) {
        this.opts.logger?.debug({ sessionId: this.sessionId, error: (error as Error).message }, 'kernel snapshot failed');
      }
    });
  }

  private async writeSnapshot(file: string, snapshot: KernelSnapshot): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, v8.serialize(snapshot));
    await rename(tmp, file);
  }

  /** Wait for any in-flight snapshot (tests, shutdown). */
  async flush(): Promise<void> {
    await this.snapshotChain;
  }

  async exec(code: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CellResult> {
    if (this.running) {
      throw new Error('a cell is already running in this kernel; wait for it or interrupt it');
    }
    this.lastUsedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.opts.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
    let resolve!: (result: CellResult) => void;
    const result = new Promise<CellResult>((r) => { resolve = r; });
    // Registered before the worker starts so an early interrupt is not lost.
    const running: RunningCell = {
      id: ++this.nextExecId,
      n: 0,
      startedAt: Date.now(),
      resolve,
      abort: new AbortController(),
      timedOut: false,
      interruptRequested: false,
    };
    this.running = running;
    running.timer = setTimeout(() => {
      running.timedOut = true;
      void this.interrupt();
    }, timeoutMs);
    running.timer.unref?.();
    const onAbort = () => void this.interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    try {
      try {
        await this.start();
      } catch (error) {
        this.finishRunning({ error: `kernel failed to start: ${(error as Error).message}` });
        return await result;
      }
      running.n = ++this.cellCounter;
      if (running.interruptRequested || !this.worker) {
        this.finishRunning({ interrupted: true });
        return await result;
      }

      let transformed: ReturnType<typeof transformCell>;
      try {
        transformed = transformCell(code);
      } catch (error) {
        if (error instanceof CellSyntaxError) {
          const text = code.split('\n')[error.line - 1] ?? '';
          const n = running.n;
          this.finishRunning({
            error: `SyntaxError: ${error.message}\n    at <cell-${n}>:${error.line}:${error.column + 1}\n  ${error.line} | ${text}\n  ${' '.repeat(String(error.line).length)} | ${' '.repeat(error.column)}^`,
          });
        } else {
          this.finishRunning({ error: String(error) });
        }
        return await result;
      }

      this.worker.postMessage({
        t: 'exec',
        id: running.id,
        n: running.n,
        code: transformed.code,
        source: code,
        shifts: transformed.shifts,
        hasValue: transformed.hasValue,
        timeoutMs,
        functionNames: transformed.functionNames,
      });
      const final = await result;
      if (final.timedOut) {
        final.notes.push(`[kernel] cell timed out after ${Math.round(timeoutMs / 1000)}s and was interrupted${final.restarted ? '' : '; variables kept'}. Start long work with bash() and end the turn instead.`);
      }
      return final;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.lastUsedAt = Date.now();
    }
  }

  /**
   * Interrupt the running cell. Cooperative first; if the worker is stuck in
   * synchronous code, terminate it and restore the last snapshot.
   * Returns 'idle' | 'cooperative' | 'restarted'.
   */
  async interrupt(): Promise<'idle' | 'cooperative' | 'restarted'> {
    const running = this.running;
    if (!running) return 'idle';
    if (!this.worker) {
      // Not started yet (or respawning): exec() sees the flag and stops.
      running.interruptRequested = true;
      running.abort.abort();
      return 'cooperative';
    }
    if (!running.interruptRequested) {
      running.interruptRequested = true;
      running.abort.abort();
      this.worker.postMessage({ t: 'interrupt', id: running.id });
    }
    const grace = this.opts.interruptGraceMs ?? 2_000;
    const outcome = await new Promise<'cooperative' | 'restarted'>((resolve) => {
      const check = setInterval(() => {
        if (this.running !== running) {
          clearInterval(check);
          clearTimeout(deadline);
          resolve('cooperative');
        }
      }, 10);
      const deadline = setTimeout(() => {
        clearInterval(check);
        resolve(this.running === running ? 'restarted' : 'cooperative');
      }, grace);
    });
    if (outcome === 'cooperative') return outcome;
    await this.hardRestart(running);
    return 'restarted';
  }

  private async hardRestart(running: RunningCell): Promise<void> {
    const old = this.worker;
    this.generation++; // ignore everything the old worker still says
    this.worker = null;
    for (const [, reply] of this.replies) reply({ t: 'gone' });
    this.replies.clear();
    await old?.terminate().catch(() => {});
    // Let the in-flight snapshot (if any) settle before restoring from it.
    await this.snapshotChain.catch(() => {});
    try {
      await this.spawn(false);
    } catch (error) {
      this.pendingNotes.push(`[kernel] respawn failed: ${(error as Error).message}`);
    }
    if (this.running === running) {
      this.finishRunning({
        stdout: '',
        stderr: '',
        interrupted: true,
        restarted: true,
        error: undefined,
      });
      this.pendingNotes.push('[kernel] the cell was stuck in synchronous code, so the kernel was restarted from the snapshot taken after the previous cell; changes made by the interrupted cell are lost.');
    }
  }

  async listVariables(): Promise<KernelVariable[]> {
    if (!this.worker || this.running) {
      const snapshot = this.lastSnapshot ?? (this.opts.snapshotFile ? await readSnapshotFile(this.opts.snapshotFile) : null);
      if (!snapshot) return [];
      return [
        ...snapshot.entries.map(entry => ({ name: entry.name, summary: entry.summary })),
        ...snapshot.skipped.map(item => ({ name: item.name, summary: `not serializable: ${item.reason}` })),
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    const reply = await this.request('vars');
    return (reply.vars as KernelVariable[]) ?? [];
  }

  /** Stop the worker; the on-disk snapshot stays for the next start. */
  async dispose(options: { deleteSnapshot?: boolean } = {}): Promise<void> {
    if (this.running) await this.interrupt().catch(() => 'idle');
    await this.flush().catch(() => {});
    this.disposed = true;
    const worker = this.worker;
    this.generation++;
    this.worker = null;
    await worker?.terminate().catch(() => {});
    if (options.deleteSnapshot && this.opts.snapshotFile) await rm(this.opts.snapshotFile, { force: true });
  }
}

export function formatVariables(vars: KernelVariable[], maxChars = 2_000): string {
  if (vars.length === 0) return '';
  let text = '[kernel-state] vars: ';
  const parts: string[] = [];
  let used = text.length;
  for (const v of vars) {
    const part = `${v.name}: ${v.summary}`;
    if (used + part.length + 2 > maxChars) {
      parts.push(`… +${vars.length - parts.length} more`);
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  text += parts.join(', ');
  return text;
}
