/**
 * Routes background-process exit notices back to the agent.
 *
 * - Session busy: the `[bash-done ...]` message is queued as a steering
 *   message, which the running turn picks up at its next iteration. If the
 *   turn ends before it drains the queue, the notice is taken back and run as
 *   a fresh turn instead, so it is never stranded.
 * - Session idle: a new agent turn starts with the notice as its message and
 *   the reply is delivered to the user's channel.
 *
 * Everything runtime-specific is injected, so the gateway wiring stays small
 * and this logic is testable with fakes.
 */

import { formatBashDone, type BackgroundExitEvent } from './process-manager.js';

export interface BashDoneRouterDeps {
  /** True while an agent turn is running (or queued) for the session. */
  isBusy(sessionId: string): boolean;
  /** Queue a steering message into the running turn. */
  enqueueSteering(sessionId: string, text: string): void;
  /** Resolve once the session has no running or queued turn. */
  waitForIdle(sessionId: string): Promise<void>;
  /** Remove a still-undelivered steering message; true if it was still queued. */
  takeSteering(sessionId: string, text: string): boolean;
  /** Start an agent turn with `text`; resolves with the reply text. */
  runTurn(sessionId: string, text: string): Promise<string | undefined>;
  /** Deliver the reply to the user's channel. */
  deliver(userId: string, text: string, sessionId: string): Promise<unknown>;
  /** Sub-agent child sessions are never woken on their own. */
  isSubAgentSession?(sessionId: string): Promise<boolean>;
  logger?: {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
  };
}

/** Build the `exit` listener. Returns a promise per event (handy for tests). */
export function createBashDoneRouter(deps: BashDoneRouterDeps): (e: BackgroundExitEvent) => Promise<void> {
  return async (e: BackgroundExitEvent) => {
    const text = formatBashDone(e);
    try {
      if (deps.isBusy(e.sessionId)) {
        deps.enqueueSteering(e.sessionId, text);
        deps.logger?.info({ sessionId: e.sessionId, id: e.id, exitCode: e.exitCode }, 'bash-done queued as steering');
        await deps.waitForIdle(e.sessionId);
        // The running turn drained it: done.
        if (!deps.takeSteering(e.sessionId, text)) return;
      }
      if (deps.isSubAgentSession && await deps.isSubAgentSession(e.sessionId)) {
        deps.logger?.info({ sessionId: e.sessionId, id: e.id }, 'bash-done for an idle sub-agent session; not waking it');
        return;
      }
      deps.logger?.info({ sessionId: e.sessionId, id: e.id, exitCode: e.exitCode }, 'bash-done starting a new turn');
      const reply = await deps.runTurn(e.sessionId, text);
      if (reply && reply.trim() && e.userId) {
        await deps.deliver(e.userId, reply, e.sessionId);
      }
    } catch (err) {
      deps.logger?.warn({ sessionId: e.sessionId, id: e.id, error: (err as Error).message }, 'bash-done routing failed');
    }
  };
}
