/**
 * One kernel per session, created on first use, reaped when idle.
 * Idle reaping only stops the worker: the on-disk snapshot stays, so the
 * next exec in that session resumes with its variables.
 */

import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import {
  KernelApi,
  type BackgroundEvent,
  type CallTool,
  type ShellBackend,
  type ToolCatalog,
} from './api.js';
import {
  Kernel,
  formatVariables,
  readSnapshotFile,
  sanitizeSessionId,
  type CellResult,
  type KernelVariable,
} from './kernel.js';

export function kernelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.SCALLOPBOT_HOME?.trim() || path.join(os.homedir(), '.scallopbot');
  return path.join(home, 'kernels');
}

export function kernelSnapshotPath(sessionId: string, dir = kernelsDir()): string {
  return path.join(dir, `${sanitizeSessionId(sessionId)}.bin`);
}

export interface KernelManagerOptions {
  workspace: string;
  callTool: CallTool;
  catalog: ToolCatalog;
  logger?: Logger;
  cellTimeoutMs?: number;
  interruptGraceMs?: number;
  /** Stop kernels idle this long (default 30 min). 0 disables reaping. */
  idleMs?: number;
  /** Live kernels kept at once; least recently used is stopped first (default 8). */
  maxKernels?: number;
  /** Snapshot directory; null disables disk persistence. Default kernelsDir(). */
  snapshotDir?: string | null;
  /** Custom background shell per session (default: process tool or awaited bash). */
  shell?: (sessionId: string) => ShellBackend;
  /** A background bash job finished while the session was idle. */
  onBashDone?: (event: BackgroundEvent) => void;
  hiddenTools?: string[];
}

export interface ExecRequest {
  userId?: string;
  userMessage?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Session {
  kernel: Kernel;
  api: KernelApi;
}

export class KernelManager {
  private readonly opts: KernelManagerOptions;
  private readonly sessions = new Map<string, Session>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: KernelManagerOptions) {
    this.opts = opts;
    const idleMs = opts.idleMs ?? 30 * 60_000;
    if (idleMs > 0) {
      this.reaper = setInterval(() => void this.reap(idleMs), Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))));
      this.reaper.unref?.();
    }
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  snapshotFile(sessionId: string): string | null {
    return this.opts.snapshotDir === null ? null : kernelSnapshotPath(sessionId, this.opts.snapshotDir ?? kernelsDir());
  }

  private session(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (session) return session;
    let kernel: Kernel;
    const api = new KernelApi({
      sessionId,
      workspace: this.opts.workspace,
      callTool: this.opts.callTool,
      catalog: this.opts.catalog,
      shell: this.opts.shell?.(sessionId),
      hiddenTools: this.opts.hiddenTools,
      onBashDone: this.opts.onBashDone,
      isBusy: () => kernel.busy,
    });
    kernel = new Kernel({
      sessionId,
      workspace: this.opts.workspace,
      dispatch: api.dispatch,
      cellTimeoutMs: this.opts.cellTimeoutMs,
      interruptGraceMs: this.opts.interruptGraceMs,
      snapshotFile: this.snapshotFile(sessionId),
      logger: this.opts.logger,
      collectNotes: () => api.drainNotes(),
    });
    session = { kernel, api };
    this.sessions.set(sessionId, session);
    this.evictOverflow(sessionId);
    return session;
  }

  private evictOverflow(keep: string): void {
    const max = this.opts.maxKernels ?? 8;
    if (this.sessions.size <= max) return;
    const idle = [...this.sessions.entries()]
      .filter(([id, s]) => id !== keep && !s.kernel.busy)
      .sort((a, b) => a[1].kernel.lastUsedAt - b[1].kernel.lastUsedAt);
    for (const [id] of idle.slice(0, this.sessions.size - max)) void this.dispose(id);
  }

  kernel(sessionId: string): Kernel {
    return this.session(sessionId).kernel;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async exec(sessionId: string, code: string, request: ExecRequest = {}): Promise<CellResult> {
    const { kernel, api } = this.session(sessionId);
    api.setExecContext({ userId: request.userId, userMessage: request.userMessage });
    return kernel.exec(code, { timeoutMs: request.timeoutMs, signal: request.signal });
  }

  async interrupt(sessionId: string): Promise<'idle' | 'cooperative' | 'restarted'> {
    const session = this.sessions.get(sessionId);
    return session ? session.kernel.interrupt() : 'idle';
  }

  async listVariables(sessionId: string): Promise<KernelVariable[]> {
    const session = this.sessions.get(sessionId);
    if (session) return session.kernel.listVariables();
    const file = this.snapshotFile(sessionId);
    const snapshot = file ? await readSnapshotFile(file) : null;
    if (!snapshot) return [];
    return [
      ...snapshot.entries.map(entry => ({ name: entry.name, summary: entry.summary })),
      ...snapshot.skipped.map(item => ({ name: item.name, summary: `not serializable: ${item.reason}` })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  async reap(idleMs: number): Promise<string[]> {
    const now = Date.now();
    const stopped: string[] = [];
    for (const [id, session] of this.sessions) {
      if (!session.kernel.busy && now - session.kernel.lastUsedAt >= idleMs) {
        stopped.push(id);
        await this.dispose(id);
      }
    }
    return stopped;
  }

  async dispose(sessionId: string, options: { deleteSnapshot?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.api.dispose();
    await session.kernel.dispose(options);
  }

  async disposeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await Promise.all([...this.sessions.keys()].map(id => this.dispose(id)));
  }
}

let defaultManager: KernelManager | null = null;

export function setDefaultKernelManager(manager: KernelManager | null): void {
  defaultManager = manager;
}

export function getDefaultKernelManager(): KernelManager | null {
  return defaultManager;
}

/**
 * `[kernel-state] vars: name: type (size), …` for re-injection after
 * compaction. Empty string when the session has no kernel state.
 */
export async function listKernelVariables(sessionId: string, manager: KernelManager | null = defaultManager): Promise<string> {
  if (manager) return formatVariables(await manager.listVariables(sessionId));
  const snapshot = await readSnapshotFile(kernelSnapshotPath(sessionId));
  if (!snapshot) return '';
  return formatVariables([
    ...snapshot.entries.map(entry => ({ name: entry.name, summary: entry.summary })),
    ...snapshot.skipped.map(item => ({ name: item.name, summary: `not serializable: ${item.reason}` })),
  ].sort((a, b) => a.name.localeCompare(b.name)));
}

/** Format a cell result as the tool output the model sees. */
export function formatCellResult(result: CellResult, mode: 'exec' | 'execute_code' = 'exec'): string {
  const parts: string[] = [];
  for (const note of result.notes) parts.push(note);
  if (result.background) parts.push(`[background output]\n${result.background.trimEnd()}`);
  if (result.stdout) parts.push(result.stdout.replace(/\n$/, ''));
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.replace(/\n$/, '')}`);
  if (mode === 'exec' && result.value !== undefined) parts.push(`→ ${result.value}`);
  if (result.error) parts.push(result.error);
  if (result.interrupted) {
    parts.push(result.timedOut
      ? `[cell ${result.n} timed out]`
      : `[cell ${result.n} interrupted${result.restarted ? '; kernel restarted from snapshot' : '; variables kept'}]`);
  }
  if (parts.length === 0) parts.push(`(cell ${result.n} ok, no output, ${result.durationMs}ms)`);
  return parts.join('\n');
}
