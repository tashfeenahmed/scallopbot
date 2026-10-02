/**
 * Wake a session from outside a user message: heartbeats, goal runs,
 * background completions.
 *
 * `wakeSession(sessionId, message, { kind })` either steers a running turn
 * (the message goes into the InterruptQueue and the loop sees it at its next
 * iteration) or starts a new agent turn on the session and delivers the reply
 * to the session's user. The message should already carry its harness header,
 * e.g. `[heartbeat: hb_123] check the build`.
 *
 * The gateway installs the runtime once with `configureWake()`; until then
 * every wake reports `unavailable`.
 */

export type WakeMode = 'steer' | 'follow_up';

export interface WakeOptions {
  /** What woke the session (heartbeat, goal, bash-done, …). Used for logs. */
  kind: string;
  /** steer = inject into a running turn if there is one; follow_up (default) = always a new turn. */
  mode?: WakeMode;
  /** Owner of the session; used to find their current session if this one was closed. */
  userId?: string;
  /** Return true to keep a reply private (e.g. a heartbeat with nothing to report). */
  isQuiet?: (response: string) => boolean;
}

export type WakeOutcome = 'steered' | 'completed' | 'unavailable' | 'failed';

export interface WakeResult {
  outcome: WakeOutcome;
  /** The session that actually received the message (may differ after /new). */
  sessionId?: string;
  response?: string;
  delivered?: boolean;
  error?: string;
}

export interface WakeRuntime {
  /** The active session to use, following the user to their current one when needed. */
  resolveSession(sessionId: string, userId?: string): Promise<{ sessionId: string; userId?: string } | null>;
  /** True while a turn is running on the session. */
  isBusy(sessionId: string): boolean;
  /** Inject text into the running turn. */
  steer(sessionId: string, text: string): void;
  /** Run one agent turn on the session. */
  runTurn(sessionId: string, message: string): Promise<{ response: string }>;
  /** Send text to the user on their channel. */
  deliver(userId: string, text: string): Promise<boolean>;
}

let runtime: WakeRuntime | null = null;

export function configureWake(next: WakeRuntime | null): void {
  runtime = next;
}

export function isWakeConfigured(): boolean {
  return runtime !== null;
}

export async function wakeSession(sessionId: string, message: string, options: WakeOptions): Promise<WakeResult> {
  const rt = runtime;
  if (!rt) return { outcome: 'unavailable', error: 'wake runtime not configured' };

  const resolved = await rt.resolveSession(sessionId, options.userId);
  if (!resolved) return { outcome: 'unavailable', error: 'session not found' };
  const target = resolved.sessionId;
  const userId = resolved.userId ?? options.userId;

  if ((options.mode ?? 'follow_up') === 'steer' && rt.isBusy(target)) {
    rt.steer(target, message);
    return { outcome: 'steered', sessionId: target };
  }

  try {
    const { response } = await rt.runTurn(target, message);
    const text = response.trim();
    let delivered = false;
    if (text && userId && !options.isQuiet?.(text)) {
      delivered = await rt.deliver(userId, text);
    }
    return { outcome: 'completed', sessionId: target, response, delivered };
  } catch (error) {
    return { outcome: 'failed', sessionId: target, error: (error as Error).message };
  }
}
