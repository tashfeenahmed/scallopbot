/**
 * Heartbeats the agent can create.
 *
 * A heartbeat is a recurring instruction bound to a session: "every 30
 * minutes, check the deploy and tell me if it failed". The UnifiedScheduler
 * calls `runDue()` on its normal tick (no separate timer). Each due beat
 * wakes the session through `wakeSession()`:
 *
 * - mode `follow_up`: a new agent turn with `[heartbeat: <id>] <instruction>`.
 * - mode `steer`: injected into the running turn if there is one, otherwise
 *   the same as follow_up.
 *
 * A reply of exactly HEARTBEAT_OK means "nothing to report" and is not sent
 * to the user. Beats are skipped while the budget is exhausted or while the
 * previous beat of the same heartbeat is still running.
 */

import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import type { HeartbeatRow, ScallopDatabase } from '../memory/db.js';
import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import { wakeSession, type WakeOptions, type WakeResult } from '../gateway/heartbeat-wake.js';

export const HEARTBEAT_OK = 'HEARTBEAT_OK';
export const MIN_HEARTBEAT_INTERVAL_MINUTES = 5;
export const MAX_HEARTBEAT_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_HEARTBEATS_PER_OWNER = 10;
const MAX_INSTRUCTION_CHARS = 2_000;

export type HeartbeatMode = 'steer' | 'follow_up';

export type HeartbeatStore = Pick<
  ScallopDatabase,
  'createHeartbeat' | 'getHeartbeat' | 'listHeartbeats' | 'deleteHeartbeat' | 'claimDueHeartbeats' | 'recordHeartbeatOutcome'
>;

export interface HeartbeatServiceOptions {
  store: HeartbeatStore;
  /** Defaults to the gateway's wakeSession(). */
  wake?: (sessionId: string, message: string, options: WakeOptions) => Promise<WakeResult>;
  /** Budget check (CostTracker.canMakeRequest). Beats are skipped when not allowed. */
  canSpend?: () => { allowed: boolean; reason?: string };
  logger?: Pick<Logger, 'info' | 'warn' | 'debug'>;
  now?: () => number;
}

export interface CreateHeartbeatInput {
  sessionId: string;
  userId?: string | null;
  instruction: string;
  intervalMinutes: number;
  mode?: HeartbeatMode;
}

export class HeartbeatError extends Error {}

/** Message injected into the session when a heartbeat fires. */
export function heartbeatMessage(hb: Pick<HeartbeatRow, 'id' | 'instruction'>): string {
  return `[heartbeat: ${hb.id}] ${hb.instruction}\n(If there is nothing worth telling the user right now, reply with just ${HEARTBEAT_OK}.)`;
}

export function isHeartbeatQuiet(response: string): boolean {
  return response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/[.!]+$/, '') === HEARTBEAT_OK;
}

export class HeartbeatService {
  private store: HeartbeatStore;
  private wake: NonNullable<HeartbeatServiceOptions['wake']>;
  private canSpend?: HeartbeatServiceOptions['canSpend'];
  private logger?: HeartbeatServiceOptions['logger'];
  private now: () => number;
  private inFlight = new Map<string, Promise<void>>();

  constructor(options: HeartbeatServiceOptions) {
    this.store = options.store;
    this.wake = options.wake ?? wakeSession;
    this.canSpend = options.canSpend;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  create(input: CreateHeartbeatInput): HeartbeatRow {
    const instruction = input.instruction?.trim() ?? '';
    if (!instruction) throw new HeartbeatError('instruction is required');
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      throw new HeartbeatError(`instruction is too long (max ${MAX_INSTRUCTION_CHARS} characters)`);
    }
    const interval = Number(input.intervalMinutes);
    if (!Number.isFinite(interval) || interval < MIN_HEARTBEAT_INTERVAL_MINUTES || interval > MAX_HEARTBEAT_INTERVAL_MINUTES) {
      throw new HeartbeatError(
        `interval_minutes must be between ${MIN_HEARTBEAT_INTERVAL_MINUTES} and ${MAX_HEARTBEAT_INTERVAL_MINUTES}`,
      );
    }
    const mode: HeartbeatMode = input.mode === 'steer' ? 'steer' : 'follow_up';
    const owned = this.list({ sessionId: input.sessionId, userId: input.userId ?? undefined });
    if (owned.length >= MAX_HEARTBEATS_PER_OWNER) {
      throw new HeartbeatError(`at most ${MAX_HEARTBEATS_PER_OWNER} heartbeats; delete one first`);
    }
    const intervalMinutes = Math.round(interval);
    return this.store.createHeartbeat({
      id: `hb_${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      instruction,
      intervalMinutes,
      mode,
      nextFireAt: this.now() + intervalMinutes * 60_000,
    });
  }

  /** Heartbeats owned by this user, or bound to this session. */
  list(owner: { sessionId?: string; userId?: string }): HeartbeatRow[] {
    if (!owner.sessionId && !owner.userId) return [];
    return this.store.listHeartbeats({
      ...(owner.userId ? { userIds: [owner.userId] } : {}),
      ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
    });
  }

  delete(id: string, owner: { sessionId?: string; userId?: string }): boolean {
    const hb = this.store.getHeartbeat(id);
    if (!hb) return false;
    const mine = (owner.userId && hb.userId === owner.userId) || (owner.sessionId && hb.sessionId === owner.sessionId);
    if (!mine) return false;
    return this.store.deleteHeartbeat(id);
  }

  /**
   * Fire every due heartbeat. Turns run in the background so a slow beat does
   * not hold up the scheduler tick; returns how many beats were started.
   */
  async runDue(now: number = this.now()): Promise<number> {
    const due = this.store.claimDueHeartbeats(now);
    let started = 0;
    for (const hb of due) {
      if (this.inFlight.has(hb.id)) {
        this.store.recordHeartbeatOutcome(hb.id, { outcome: 'skipped_overlap' });
        continue;
      }
      const budget = this.canSpend?.();
      if (budget && !budget.allowed) {
        this.store.recordHeartbeatOutcome(hb.id, { outcome: 'skipped_budget', error: budget.reason ?? null });
        this.logger?.info({ heartbeatId: hb.id, reason: budget.reason }, 'Heartbeat skipped: budget exhausted');
        continue;
      }
      const run = this.fire(hb).finally(() => this.inFlight.delete(hb.id));
      this.inFlight.set(hb.id, run);
      started++;
    }
    return started;
  }

  /** Test/shutdown hook: wait for beats that are still running. */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }

  private async fire(hb: HeartbeatRow): Promise<void> {
    try {
      const result = await this.wake(hb.sessionId, heartbeatMessage(hb), {
        kind: 'heartbeat',
        mode: hb.mode,
        ...(hb.userId ? { userId: hb.userId } : {}),
        isQuiet: isHeartbeatQuiet,
      });
      const movedSession = result.sessionId && result.sessionId !== hb.sessionId ? result.sessionId : undefined;
      if (result.outcome === 'unavailable') {
        // The session is gone and the owner has no current one: stop beating.
        this.store.recordHeartbeatOutcome(hb.id, { outcome: 'unavailable', error: result.error ?? null, disable: true });
        this.logger?.warn({ heartbeatId: hb.id, error: result.error }, 'Heartbeat disabled: no session to wake');
        return;
      }
      const outcome = result.outcome === 'completed'
        ? (result.delivered ? 'delivered' : 'quiet')
        : result.outcome;
      this.store.recordHeartbeatOutcome(hb.id, {
        outcome,
        error: result.error ?? null,
        ...(movedSession ? { sessionId: movedSession } : {}),
      });
      this.logger?.debug({ heartbeatId: hb.id, outcome }, 'Heartbeat fired');
    } catch (error) {
      this.store.recordHeartbeatOutcome(hb.id, { outcome: 'failed', error: (error as Error).message });
      this.logger?.warn({ heartbeatId: hb.id, error: (error as Error).message }, 'Heartbeat failed');
    }
  }
}

function describe(hb: HeartbeatRow): Record<string, unknown> {
  return {
    id: hb.id,
    instruction: hb.instruction,
    interval_minutes: hb.intervalMinutes,
    mode: hb.mode,
    next_fire_at: new Date(hb.nextFireAt).toISOString(),
    ...(hb.lastFiredAt ? { last_fired_at: new Date(hb.lastFiredAt).toISOString(), last_outcome: hb.lastOutcome } : {}),
  };
}

/** Native `heartbeat` tool: create, list or delete heartbeats for this session's user. */
export function createHeartbeatSkill(service: HeartbeatService): Skill {
  return defineSkill(
    'heartbeat',
    'Create, list or delete recurring heartbeats: an instruction you run again every N minutes in this conversation '
      + '(e.g. check a deploy, watch an inbox). mode follow_up starts a new turn; steer joins a turn already running. '
      + `Reply ${HEARTBEAT_OK} on a beat with nothing to report.`,
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'What to do' },
        instruction: { type: 'string', description: 'create: what to do on each beat, written as an instruction to yourself' },
        interval_minutes: {
          type: 'number',
          description: `create: minutes between beats (${MIN_HEARTBEAT_INTERVAL_MINUTES}-${MAX_HEARTBEAT_INTERVAL_MINUTES})`,
        },
        mode: { type: 'string', enum: ['steer', 'follow_up'], description: 'create: default follow_up' },
        id: { type: 'string', description: 'delete: the heartbeat id' },
      },
      required: ['action'],
    })
    .onNativeExecute(async (ctx) => {
      const action = String(ctx.args.action ?? '');
      const owner = { sessionId: ctx.sessionId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
      try {
        if (action === 'create') {
          const hb = service.create({
            sessionId: ctx.sessionId,
            userId: ctx.userId ?? null,
            instruction: String(ctx.args.instruction ?? ''),
            intervalMinutes: Number(ctx.args.interval_minutes),
            mode: ctx.args.mode === 'steer' ? 'steer' : 'follow_up',
          });
          return { success: true, output: JSON.stringify({ created: describe(hb) }) };
        }
        if (action === 'list') {
          const rows = service.list(owner);
          return { success: true, output: JSON.stringify({ heartbeats: rows.map(describe) }) };
        }
        if (action === 'delete') {
          const id = String(ctx.args.id ?? '').trim();
          if (!id) return { success: false, output: '', error: 'id is required for delete' };
          const deleted = service.delete(id, owner);
          return deleted
            ? { success: true, output: JSON.stringify({ deleted: id }) }
            : { success: false, output: '', error: `No heartbeat ${id} owned by this conversation` };
        }
        return { success: false, output: '', error: 'action must be create, list or delete' };
      } catch (error) {
        if (error instanceof HeartbeatError) return { success: false, output: '', error: error.message };
        throw error;
      }
    })
    .build().skill;
}
