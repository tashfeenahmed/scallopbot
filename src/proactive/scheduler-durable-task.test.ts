import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BoardService } from '../board/board-service.js';
import { ScallopDatabase } from '../memory/db.js';
import type { SessionManager } from '../agent/session.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import type { Router } from '../routing/router.js';
import { UnifiedScheduler } from './scheduler.js';

const logger = pino({ level: 'silent' });

function middayTimezone(): string {
  const offset = 12 - new Date().getUTCHours();
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function sessionManager(id: string): SessionManager {
  return {
    createSession: vi.fn().mockResolvedValue({ id }),
  } as unknown as SessionManager;
}

function addDueTask(db: ScallopDatabase, overrides: { userId?: string; sessionId?: string | null; triggerAt?: number; message?: string } = {}) {
  return db.addScheduledItem({
    userId: overrides.userId ?? 'default',
    sessionId: overrides.sessionId ?? null,
    source: 'user',
    kind: 'task',
    type: 'event_prep',
    message: overrides.message ?? 'Prepare the durable report',
    context: null,
    triggerAt: overrides.triggerAt ?? Date.now() - 1_000,
    recurring: null,
    sourceMemoryId: null,
    taskConfig: { goal: 'Prepare the durable report from real data', tools: [] },
    maxAttempts: 3,
  });
}

describe('UnifiedScheduler durable task execution', () => {
  let db: ScallopDatabase;
  const schedulers: UnifiedScheduler[] = [];

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    db.close();
  });

  function makeScheduler(
    workerId: string,
    spawnAndWait: ReturnType<typeof vi.fn>,
    send: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(true),
    router?: Pick<Router, 'executeWithFallback'>,
  ): UnifiedScheduler {
    const scheduler = new UnifiedScheduler({
      db,
      logger,
      workerId,
      taskLeaseMs: 2_000,
      taskHeartbeatMs: 250,
      taskRetryDelayMs: 1_000,
      sessionManager: sessionManager(`session:${workerId}`),
      subAgentExecutor: { spawnAndWait } as unknown as SubAgentExecutor,
      router,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
      minAgentProactiveGapMs: 0,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  it('allows only one of two live schedulers to execute and complete a task', async () => {
    const item = addDueTask(db);
    let resolveWorker!: (value: {
      response: string;
      iterationsUsed: number;
      taskComplete: boolean;
      costUsd: number;
    }) => void;
    const workerResult = new Promise<{
      response: string;
      iterationsUsed: number;
      taskComplete: boolean;
      costUsd: number;
    }>(resolve => { resolveWorker = resolve; });
    const spawnAndWait = vi.fn().mockReturnValue(workerResult);
    const send = vi.fn().mockResolvedValue(true);
    const heartbeat = vi.spyOn(db, 'heartbeatBoardTask');
    const first = makeScheduler('worker-a', spawnAndWait, send);
    const second = makeScheduler('worker-b', spawnAndWait, send);

    const firstEvaluation = first.evaluate();
    await vi.waitFor(() => expect(spawnAndWait).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled(), { timeout: 1_000 });
    const secondEvaluation = second.evaluate();
    await secondEvaluation;
    resolveWorker({
      response: 'The durable report is ready.',
      iterationsUsed: 2,
      taskComplete: true,
      costUsd: 0.0042,
    });
    await firstEvaluation;

    const stored = db.getScheduledItem(item.id);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      status: 'fired',
      boardStatus: 'done',
      attemptCount: 1,
      workerId: null,
      leaseToken: null,
    });
    expect(stored?.result).toMatchObject({ taskComplete: true, costUsd: 0.0042 });
  });

  it('reclaims a crashed lease and succeeds on the next durable attempt', async () => {
    const oldNow = Date.now() - 10_000;
    const item = addDueTask(db, { triggerAt: oldNow - 1_000 });
    const board = new BoardService(db, logger);
    const abandoned = board.claimNextTask('default', 'crashed-worker', 1_000, oldNow);
    expect(abandoned).not.toBeNull();
    expect(db.getScheduledItem(item.id)?.status).toBe('processing');

    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'Recovered report complete.',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.002,
    });
    const scheduler = makeScheduler('recovery-worker', spawnAndWait);

    await scheduler.evaluate();

    const stored = db.getScheduledItem(item.id);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({ status: 'fired', boardStatus: 'done', attemptCount: 2 });
    expect(stored?.lastError).toBeNull();
  });

  it('migrates an unleased legacy processing task into durable execution', async () => {
    const item = addDueTask(db);
    const legacyClaim = db.claimDueScheduledItems(Date.now(), 'task');
    expect(legacyClaim).toHaveLength(1);
    expect(db.getScheduledItem(item.id)).toMatchObject({ status: 'processing', leaseToken: null });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'Legacy task recovered.',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.001,
    });
    const scheduler = makeScheduler('migration-worker', spawnAndWait);

    await scheduler.evaluate();

    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'fired', boardStatus: 'done', attemptCount: 1, leaseToken: null,
    });
  });

  it('retries a failed worker through the lease API without leaking the task title', async () => {
    const item = addDueTask(db);
    const spawnAndWait = vi.fn()
      .mockRejectedValueOnce(new Error('provider temporarily offline'))
      .mockResolvedValueOnce({
        response: 'Report recovered on retry.',
        iterationsUsed: 1,
        taskComplete: true,
        costUsd: 0.003,
      });
    const send = vi.fn().mockResolvedValue(true);
    const scheduler = makeScheduler('retry-worker', spawnAndWait, send);

    await scheduler.evaluate();
    const waiting = db.getScheduledItem(item.id);
    expect(waiting).toMatchObject({ status: 'pending', boardStatus: 'waiting', attemptCount: 1 });
    expect(waiting?.lastError).toContain('provider temporarily offline');
    expect(send).not.toHaveBeenCalled();

    db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
    await scheduler.evaluate();

    expect(spawnAndWait).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'fired', boardStatus: 'done', attemptCount: 2, lastError: null,
    });
  });

  it('runs tasks before nudges so companion messages remain deduplicated', async () => {
    const item = addDueTask(db, { message: 'Prepare flight EK204 status' });
    db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Prepare flight EK204 status',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'Flight EK204 is on time.',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.001,
    });
    const send = vi.fn().mockResolvedValue(true);
    const scheduler = makeScheduler('ordering-worker', spawnAndWait, send);

    await scheduler.evaluate();

    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('default', expect.stringContaining('EK204'));
  });

  it('preserves the originating session so channel tool policy is re-applied', async () => {
    addDueTask(db, { sessionId: 'telegram-parent-session' });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'Policy-scoped result.',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.001,
    });
    const scheduler = makeScheduler('policy-worker', spawnAndWait);

    await scheduler.evaluate();

    expect(spawnAndWait).toHaveBeenCalledWith(
      'telegram-parent-session',
      expect.any(Object),
    );
  });

  it('rewrites a scheduled worker internal plan before user delivery', async () => {
    addDueTask(db);
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'We should send the user a friendly update about the finished report.',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.001,
    });
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{ type: 'text', text: 'Your report is ready—want me to walk you through it?' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'rewrite',
        },
        provider: 'rewrite',
        attemptedProviders: ['rewrite'],
      }),
    };
    const scheduler = makeScheduler('rewrite-worker', spawnAndWait, send, router as any);

    await scheduler.evaluate();

    expect(router.executeWithFallback).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'default',
      expect.stringContaining('Your report is ready'),
    );
    expect(send.mock.calls[0][1]).not.toContain('We should send the user');
  });
});
