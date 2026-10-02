/**
 * Goal mode (`/goal <objective>`): keep working until the goal is verified.
 *
 * The first turn is `[goal: start] <objective>`. After every turn that did
 * not end with the `goal_complete` tool, the controller sends
 * GOAL_CONTINUATION_MESSAGE as the next turn. A run stops when:
 *
 * - the model calls `goal_complete {summary, evidence}` (completed),
 * - the user sends /stop or `/goal stop` (stopped),
 * - the budget is exhausted (CostTracker.canMakeRequest) (budget_exhausted),
 * - GOAL_MAX_TURNS turns have run (max_turns, default 30),
 * - three turns in a row made no progress: no successful tool call and no
 *   new tool output (no_progress). Each no-progress turn backs off
 *   exponentially before the next continuation.
 *
 * The controller is channel-agnostic. Channels decide how to show turns: the
 * web UI shows every turn, Telegram shows the first reply, then at most one
 * progress note every few minutes, then the final report.
 */

import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import type { ScallopDatabase } from '../memory/db.js';
import type { BoardService } from '../board/board-service.js';
import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import { parseSessionContentBlocks } from '../memory/session-message-kinds.js';

export const GOAL_CONTINUATION_MESSAGE =
  '[goal: continuation] Keep working on the goal. Audit every requirement before completing; never complete because the budget is low. Call goal_complete when everything is verified.';

export const DEFAULT_GOAL_MAX_TURNS = 30;
export const GOAL_NO_PROGRESS_CAP = 3;

export function goalStartMessage(objective: string): string {
  return `[goal: start] ${objective}`;
}

export type GoalRunStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'budget_exhausted'
  | 'max_turns'
  | 'no_progress'
  | 'failed';

export interface GoalRun {
  id: string;
  sessionId: string;
  userId?: string;
  objective: string;
  status: GoalRunStatus;
  turns: number;
  maxTurns: number;
  noProgressStreak: number;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  evidence?: string[];
  lastResponse?: string;
  stopReason?: string;
  boardItemId?: string;
}

export interface GoalTurnProgress {
  /** Tool calls in the turn that returned without error. */
  successfulToolCalls: number;
}

/** Measures what a turn changed in the session transcript. */
export interface GoalProgressProbe {
  snapshot(sessionId: string): number;
  measure(sessionId: string, snapshot: number): GoalTurnProgress;
}

/** Mirrors the run on the task board so it is visible next to other work. */
export interface GoalBoardLink {
  onStart(run: GoalRun): string | undefined;
  onFinish(run: GoalRun): void;
}

export interface GoalTurnResult {
  response: string;
  completionReason?: string;
}

export interface GoalModeOptions {
  /** One agent turn on the session (Agent.processMessage). */
  runTurn: (sessionId: string, message: string, shouldStop: () => boolean) => Promise<GoalTurnResult>;
  probe: GoalProgressProbe;
  /** CostTracker.canMakeRequest; the run stops when it is not allowed. */
  canSpend?: () => { allowed: boolean; reason?: string };
  board?: GoalBoardLink;
  maxTurns?: number;
  noProgressCap?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  logger?: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

export interface GoalRunHooks {
  userId?: string;
  /** The channel's own stop flag (/stop). */
  shouldStop?: () => boolean;
  /** Called after every turn that did not finish the run. */
  onTurn?: (run: GoalRun, response: string) => Promise<void> | void;
  /** Channel-specific turn runner (progress callbacks, /model override). */
  runTurn?: GoalModeOptions['runTurn'];
}

export class GoalAlreadyRunningError extends Error {
  constructor(public readonly run: GoalRun) {
    super(`A goal is already running in this conversation: "${run.objective}". Send /goal stop first.`);
    this.name = 'GoalAlreadyRunningError';
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class GoalModeController {
  private active = new Map<string, { run: GoalRun; abort: AbortController; completeRequested: boolean }>();
  private last = new Map<string, GoalRun>();
  private options: Required<Pick<GoalModeOptions, 'maxTurns' | 'noProgressCap' | 'backoffBaseMs' | 'backoffMaxMs'>> & GoalModeOptions;

  constructor(options: GoalModeOptions) {
    this.options = {
      maxTurns: DEFAULT_GOAL_MAX_TURNS,
      noProgressCap: GOAL_NO_PROGRESS_CAP,
      backoffBaseMs: 5_000,
      backoffMaxMs: 60_000,
      ...options,
    };
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** The running goal, or the last finished one, for this session. */
  status(sessionId: string): GoalRun | undefined {
    const live = this.active.get(sessionId);
    return live ? { ...live.run } : this.last.get(sessionId);
  }

  /** Ask a running goal to stop after (or during) the current turn. */
  stop(sessionId: string, reason = 'stopped by the user'): boolean {
    const live = this.active.get(sessionId);
    if (!live) return false;
    live.run.stopReason = reason;
    live.abort.abort();
    return true;
  }

  /** Called by the goal_complete tool. Returns null when no goal is running. */
  complete(sessionId: string, summary: string, evidence: string[]): GoalRun | null {
    const live = this.active.get(sessionId);
    if (!live) return null;
    live.completeRequested = true;
    live.run.summary = summary;
    live.run.evidence = evidence;
    return { ...live.run };
  }

  /**
   * Run a goal to the end. Resolves with the finished run; never rejects for
   * turn failures (they end the run as `failed`).
   */
  async run(sessionId: string, objective: string, hooks: GoalRunHooks = {}): Promise<GoalRun> {
    const existing = this.active.get(sessionId);
    if (existing) throw new GoalAlreadyRunningError({ ...existing.run });

    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? abortableSleep;
    const run: GoalRun = {
      id: `goal_${randomUUID().slice(0, 8)}`,
      sessionId,
      ...(hooks.userId ? { userId: hooks.userId } : {}),
      objective,
      status: 'running',
      turns: 0,
      maxTurns: this.options.maxTurns,
      noProgressStreak: 0,
      startedAt: now(),
    };
    const state = { run, abort: new AbortController(), completeRequested: false };
    this.active.set(sessionId, state);
    const stopRequested = (): boolean => state.abort.signal.aborted || hooks.shouldStop?.() === true;

    try {
      run.boardItemId = this.options.board?.onStart(run);
    } catch (error) {
      this.options.logger?.warn({ error: (error as Error).message }, 'Goal board link failed on start');
    }
    this.options.logger?.info({ goalId: run.id, sessionId, maxTurns: run.maxTurns }, 'Goal run started');

    const finish = (status: GoalRunStatus, reason?: string): GoalRun => {
      run.status = status;
      if (reason && !run.stopReason) run.stopReason = reason;
      run.endedAt = now();
      return run;
    };

    try {
      for (;;) {
        if (stopRequested()) {
          finish('stopped', 'stopped by the user');
          break;
        }
        const budget = this.options.canSpend?.();
        if (budget && !budget.allowed) {
          finish('budget_exhausted', budget.reason ?? 'budget exhausted');
          break;
        }
        if (run.turns >= run.maxTurns) {
          finish('max_turns', `reached the ${run.maxTurns}-turn limit`);
          break;
        }

        const message = run.turns === 0 ? goalStartMessage(objective) : GOAL_CONTINUATION_MESSAGE;
        const before = this.options.probe.snapshot(sessionId);
        let result: GoalTurnResult;
        try {
          result = await (hooks.runTurn ?? this.options.runTurn)(sessionId, message, stopRequested);
        } catch (error) {
          finish('failed', (error as Error).message);
          break;
        }
        run.turns++;
        run.lastResponse = result.response;

        if (state.completeRequested) {
          finish('completed');
          break;
        }
        if (stopRequested() || result.completionReason === 'stopped') {
          finish('stopped', 'stopped by the user');
          break;
        }

        const progress = this.options.probe.measure(sessionId, before);
        run.noProgressStreak = progress.successfulToolCalls > 0 ? 0 : run.noProgressStreak + 1;
        if (run.noProgressStreak >= this.options.noProgressCap) {
          finish('no_progress', `${run.noProgressStreak} turns in a row without progress`);
          break;
        }
        if (run.turns >= run.maxTurns) {
          finish('max_turns', `reached the ${run.maxTurns}-turn limit`);
          break;
        }

        try {
          await hooks.onTurn?.({ ...run }, result.response);
        } catch (error) {
          this.options.logger?.warn({ error: (error as Error).message }, 'Goal progress delivery failed');
        }

        if (run.noProgressStreak > 0) {
          const delay = Math.min(
            this.options.backoffBaseMs * Math.pow(2, run.noProgressStreak - 1),
            this.options.backoffMaxMs,
          );
          await sleep(delay, state.abort.signal);
        }
      }
    } finally {
      this.active.delete(sessionId);
      this.last.set(sessionId, { ...run });
      try {
        this.options.board?.onFinish(run);
      } catch (error) {
        this.options.logger?.warn({ error: (error as Error).message }, 'Goal board link failed on finish');
      }
      this.options.logger?.info(
        { goalId: run.id, sessionId, status: run.status, turns: run.turns, reason: run.stopReason },
        'Goal run finished',
      );
    }
    return { ...run };
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────

const trimTo = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const STATUS_LABEL: Record<GoalRunStatus, string> = {
  running: 'running',
  completed: 'complete',
  stopped: 'stopped',
  budget_exhausted: 'stopped: budget exhausted',
  max_turns: 'stopped: turn limit reached',
  no_progress: 'stopped: no progress',
  failed: 'stopped: error',
};

/** Final report sent to the user when a run ends. */
export function formatGoalOutcome(run: GoalRun): string {
  if (run.status === 'completed') {
    const evidence = run.evidence?.length ? `\n\nEvidence:\n${run.evidence.map(e => `- ${e}`).join('\n')}` : '';
    return `Goal complete after ${run.turns} turn${run.turns === 1 ? '' : 's'}: ${run.objective}\n\n${run.summary ?? ''}${evidence}`.trim();
  }
  const reason = run.stopReason ? ` (${run.stopReason})` : '';
  const last = run.lastResponse?.trim() ? `\n\nLatest update:\n${trimTo(run.lastResponse.trim(), 1500)}` : '';
  return `Goal ${STATUS_LABEL[run.status]}${reason} after ${run.turns} turn${run.turns === 1 ? '' : 's'}: ${run.objective}. It is not marked complete.${last}`;
}

export function formatGoalStatus(run: GoalRun | undefined): string {
  if (!run) return 'No goal in this conversation. Start one with /goal <objective>.';
  if (run.status === 'running') {
    return `Goal running: ${run.objective}\nTurn ${run.turns} of ${run.maxTurns}${run.noProgressStreak ? `, ${run.noProgressStreak} turn(s) without progress` : ''}. Send /goal stop to stop it.`;
  }
  return `Last goal ${STATUS_LABEL[run.status]} after ${run.turns} turn(s): ${run.objective}`;
}

export const GOAL_HELP =
  'Usage:\n/goal <objective> — keep working until the objective is verified\n/goal status — show the running goal\n/goal stop — stop it';

export type GoalCommand =
  | { action: 'start'; objective: string }
  | { action: 'status' }
  | { action: 'stop' }
  | { action: 'help' };

export function parseGoalCommand(args: string): GoalCommand {
  const text = args.trim();
  if (!text || /^help$/i.test(text)) return { action: 'help' };
  if (/^status$/i.test(text)) return { action: 'status' };
  if (/^(stop|cancel)$/i.test(text)) return { action: 'stop' };
  return { action: 'start', objective: text };
}

/**
 * Telegram-friendly delivery: the first turn's reply goes out at once (the
 * plan), later turns at most once per `intervalMs` (latest reply wins).
 */
export function throttledGoalProgress(
  send: (text: string) => Promise<unknown>,
  intervalMs = 5 * 60_000,
  now: () => number = Date.now,
): (run: GoalRun, response: string) => Promise<void> {
  let lastSentAt = -Infinity;
  return async (run, response) => {
    const text = response.trim();
    if (!text) return;
    const t = now();
    if (run.turns > 1 && t - lastSentAt < intervalMs) return;
    lastSentAt = t;
    await send(run.turns === 1 ? text : `Goal progress (turn ${run.turns}/${run.maxTurns}):\n${trimTo(text, 1200)}`);
  };
}

// ─── Progress probe + board link ──────────────────────────────────────────

/**
 * Progress = tool results written to the session during the turn that are
 * not errors. Reads durable rows by id, so in-place compaction of the cached
 * transcript does not confuse it.
 */
export function createSessionProgressProbe(db: Pick<ScallopDatabase, 'getSessionMessages'>): GoalProgressProbe {
  return {
    snapshot(sessionId) {
      return db.getSessionMessages(sessionId).at(-1)?.id ?? 0;
    },
    measure(sessionId, snapshot) {
      let successfulToolCalls = 0;
      for (const row of db.getSessionMessages(sessionId)) {
        if (row.id <= snapshot) continue;
        for (const block of parseSessionContentBlocks(row.content) ?? []) {
          if (block.type !== 'tool_result' || block.is_error === true) continue;
          const content = typeof block.content === 'string' ? block.content : '';
          if (/^\s*(?:\[TOOL_ERROR|Error:)/.test(content)) continue;
          successfulToolCalls++;
        }
      }
      return { successfulToolCalls };
    },
  };
}

export function boardGoalLink(board: Pick<BoardService, 'createItem' | 'markDone' | 'moveItem'>): GoalBoardLink {
  return {
    onStart(run) {
      const item = board.createItem(run.userId ?? 'default', {
        title: `Goal: ${trimTo(run.objective, 160)}`,
        source: 'agent',
        boardStatus: 'in_progress',
        labels: ['goal'],
        context: `Goal mode run ${run.id} in session ${run.sessionId}`,
      });
      return item.id;
    },
    onFinish(run) {
      if (!run.boardItemId) return;
      if (run.status === 'completed') {
        board.markDone(run.boardItemId, trimTo(run.summary ?? 'Goal complete', 2000));
      } else {
        board.moveItem(run.boardItemId, 'waiting');
      }
    },
  };
}

// ─── goal_complete tool ───────────────────────────────────────────────────

/** Native `goal_complete` tool; only succeeds while a /goal run is active. */
export function createGoalCompleteSkill(controller: Pick<GoalModeController, 'complete'>): Skill {
  return defineSkill(
    'goal_complete',
    'Finish the active /goal run. Call only after auditing every requirement of the goal and verifying each one; never because the budget is low.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was done, in a few sentences for the user' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'How each requirement was verified: commands run, files checked, outputs seen',
        },
      },
      required: ['summary', 'evidence'],
    })
    .onNativeExecute(async (ctx) => {
      const summary = typeof ctx.args.summary === 'string' ? ctx.args.summary.trim() : '';
      const raw = ctx.args.evidence;
      const evidence = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
        .map(e => String(e).trim())
        .filter(Boolean);
      if (!summary) return { success: false, output: '', error: 'summary is required' };
      if (evidence.length === 0) {
        return { success: false, output: '', error: 'evidence is required: list how each requirement was verified' };
      }
      const run = controller.complete(ctx.sessionId, summary, evidence);
      if (!run) {
        return { success: false, output: '', error: 'No goal is running in this conversation; goal_complete only ends a /goal run.' };
      }
      return { success: true, output: 'Goal marked complete. Reply with a short final report for the user; do not start new work.' };
    })
    .build().skill;
}
