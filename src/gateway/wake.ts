/**
 * Session wake-up: start a new parent turn when background work finishes.
 *
 * Used for `[agent-result: …]` / `[agent-exited: …]` (sub-agents) and
 * `[bash-done …]` (background shell). When the session is idle, the waker
 * starts one turn carrying every pending message; when the session is busy,
 * the message waits and is retried once the session goes idle — unless the
 * running turn consumed it first (`isPending` returns false), e.g. agent.ts
 * drained the announce queue at an iteration boundary.
 *
 * Concurrency: at most one wake turn per session at a time (the `running`
 * set is checked and set synchronously). Messages that arrive during a wake
 * turn are batched into the next one. Agent.processMessage additionally
 * serializes all turns per session lane, so a wake turn can never interleave
 * with a user turn.
 *
 * Callers that do not hold a gateway reference use the module-level
 * `wakeSession()`, which forwards to whichever waker the gateway installed.
 */

import type { Logger } from 'pino';

export type WakeKind = 'agent-result' | 'agent-exited' | 'bash-done' | (string & {});

export interface WakeOptions {
  kind: WakeKind;
  /**
   * Still undelivered? Return false once a running turn consumed the message
   * through its own in-turn channel (announce queue, notice queue…).
   * Default: always pending — the waker is the only carrier.
   */
  isPending?: () => boolean;
  /** Called just before a wake turn carries the message (remove it from in-turn queues). */
  claim?: () => void;
}

export interface WakeTurnRequest {
  sessionId: string;
  /** All pending messages joined with blank lines, oldest first. */
  message: string;
  kinds: WakeKind[];
}

export interface SessionWakerDeps {
  /** True while a turn is running or queued for this session. */
  isBusy(sessionId: string): boolean;
  /** Run one parent turn with `message` and deliver its reply to the user. */
  runTurn(request: WakeTurnRequest): Promise<void>;
  logger?: Logger;
  /** How often to re-check a busy session. Default 500ms. */
  pollMs?: number;
}

export type WakeOutcome = 'started' | 'queued';

interface PendingWake {
  message: string;
  opts: WakeOptions;
}

export class SessionWaker {
  private pending = new Map<string, PendingWake[]>();
  private running = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly pollMs: number;

  constructor(private readonly deps: SessionWakerDeps) {
    this.pollMs = Math.max(10, deps.pollMs ?? 500);
  }

  /** Queue `message` for `sessionId` and start a turn now if the session is idle. */
  wake(sessionId: string, message: string, opts: WakeOptions): WakeOutcome {
    const list = this.pending.get(sessionId) ?? [];
    list.push({ message, opts });
    this.pending.set(sessionId, list);
    return this.flush(sessionId) ? 'started' : 'queued';
  }

  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  isWaking(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Resolves when the current wake turn for this session (if any) settles. */
  async idle(sessionId: string): Promise<void> {
    while (this.inflight.has(sessionId) || this.timers.has(sessionId)) {
      await (this.inflight.get(sessionId) ?? new Promise(resolve => setTimeout(resolve, this.pollMs)));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Returns true when a wake turn was started by this call. */
  private flush(sessionId: string): boolean {
    if (this.stopped) return false;
    // Drop anything a running turn already consumed.
    const list = (this.pending.get(sessionId) ?? []).filter(item => item.opts.isPending?.() ?? true);
    if (list.length === 0) {
      this.pending.delete(sessionId);
      this.clearTimer(sessionId);
      return false;
    }
    this.pending.set(sessionId, list);
    // One wake turn at a time; its completion re-flushes.
    if (this.running.has(sessionId)) return false;
    if (this.deps.isBusy(sessionId)) {
      this.schedule(sessionId);
      return false;
    }

    this.clearTimer(sessionId);
    this.pending.delete(sessionId);
    this.running.add(sessionId);
    for (const item of list) {
      try { item.opts.claim?.(); } catch { /* claim is best effort */ }
    }
    const request: WakeTurnRequest = {
      sessionId,
      message: list.map(item => item.message).join('\n\n'),
      kinds: [...new Set(list.map(item => item.opts.kind))],
    };
    const turn = (async () => {
      try {
        await this.deps.runTurn(request);
      } catch (error) {
        this.deps.logger?.warn({ sessionId, error: (error as Error).message }, 'Wake turn failed');
      } finally {
        this.running.delete(sessionId);
        this.inflight.delete(sessionId);
        // Messages that arrived during the turn go out in the next one.
        if (this.pending.has(sessionId)) this.flush(sessionId);
      }
    })();
    this.inflight.set(sessionId, turn);
    return true;
  }

  private schedule(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.flush(sessionId);
    }, this.pollMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}

let installed: SessionWaker | null = null;

/** Install (or clear) the process-wide waker. The gateway does this at startup. */
export function setSessionWaker(waker: SessionWaker | null): void {
  installed = waker;
}

export function getSessionWaker(): SessionWaker | null {
  return installed;
}

/**
 * Wake `sessionId` with a harness message (`[kind: …]` header included by the
 * caller). Returns 'unavailable' when no gateway waker is installed (tests,
 * CLI), in which case the caller's own in-turn channel is the only carrier.
 */
export function wakeSession(sessionId: string, message: string, opts: WakeOptions): WakeOutcome | 'unavailable' {
  return installed ? installed.wake(sessionId, message, opts) : 'unavailable';
}
