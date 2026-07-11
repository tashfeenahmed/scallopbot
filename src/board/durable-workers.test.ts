import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import { BoardService } from './board-service.js';

const logger = pino({ level: 'silent' });

describe('durable board task workers', () => {
  let db: ScallopDatabase;
  let board: BoardService;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
    board = new BoardService(db, logger);
  });

  afterEach(() => db.close());

  it('leases dependency-ready work exactly once and rejects stale completion tokens', () => {
    const prerequisite = board.createItem('default', {
      title: 'Prepare data',
      kind: 'task',
      boardStatus: 'backlog',
      maxAttempts: 3,
    });
    const dependent = board.createItem('default', {
      title: 'Analyze data',
      kind: 'task',
      boardStatus: 'backlog',
      dependsOn: [prerequisite.id],
    });

    const first = board.claimNextTask('default', 'worker-a', 5_000, 1_000);
    expect(first?.item.id).toBe(prerequisite.id);
    expect(first?.item.attemptCount).toBe(1);

    // A second worker cannot claim the live lease, and the dependent is blocked.
    expect(board.claimNextTask('default', 'worker-b', 5_000, 1_001)).toBeNull();
    expect(board.heartbeatTask(prerequisite.id, 'wrong-token', 5_000, 1_100)).toBe(false);
    expect(board.heartbeatTask(prerequisite.id, first!.leaseToken, 5_000, 1_100)).toBe(true);

    const completed = board.completeLeasedTask(prerequisite.id, first!.leaseToken, {
      response: 'data ready',
      completedAt: 1_200,
      taskComplete: true,
      outcome: 'succeeded',
      completionSource: 'worker',
    }, 1_200);
    expect(completed?.boardStatus).toBe('done');
    expect(board.completeLeasedTask(prerequisite.id, first!.leaseToken, {
      response: 'duplicate', completedAt: 1_300, taskComplete: true, outcome: 'succeeded',
    }, 1_300)).toBeNull();

    const second = board.claimNextTask('default', 'worker-b', 5_000, 1_301);
    expect(second?.item.id).toBe(dependent.id);
  });

  it('reclaims an expired lease once, then archives it when retries are exhausted', () => {
    const task = board.createItem('default', {
      title: 'Flaky work',
      kind: 'task',
      boardStatus: 'backlog',
      maxAttempts: 2,
    });

    const first = board.claimNextTask('default', 'worker-a', 1_000, 10_000);
    expect(first?.item.id).toBe(task.id);
    expect(board.reclaimExpiredLeases(11_001)).toBe(1);
    expect(board.getItem(task.id)).toMatchObject({ boardStatus: 'waiting', attemptCount: 1 });

    const second = board.claimNextTask('default', 'worker-b', 1_000, 11_002);
    expect(second?.item.attemptCount).toBe(2);
    expect(board.reclaimExpiredLeases(12_003)).toBe(1);

    const exhausted = board.getItem(task.id)!;
    expect(exhausted.boardStatus).toBe('archived');
    expect(exhausted.lastError).toContain('retry budget exhausted');
    expect(board.claimNextTask('default', 'worker-c', 1_000, 12_004)).toBeNull();
  });

  it('supports named handoff and bounded retry with a persistent audit trail', () => {
    const task = board.createItem('default', {
      title: 'Specialist task',
      kind: 'task',
      boardStatus: 'backlog',
      maxAttempts: 3,
    });

    const original = board.claimNextTask('default', 'generalist', 5_000, 20_000)!;
    expect(board.handoffTask(task.id, original.leaseToken, 'specialist', 'Needs domain expertise', 20_100)).toBe(true);
    expect(board.claimNextTask('default', 'generalist', 5_000, 20_101)).toBeNull();

    const specialist = board.claimNextTask('default', 'specialist', 5_000, 20_102)!;
    expect(specialist.item.handedOffFrom).toBe('generalist');
    expect(specialist.item.attemptCount).toBe(2);
    expect(board.failLeasedTask(task.id, specialist.leaseToken, 'Transient API failure', {
      retryAt: 21_000,
    }, 20_200)).toBe('retry_scheduled');

    expect(board.claimNextTask('default', 'specialist', 5_000, 20_999)).toBeNull();
    const finalAttempt = board.claimNextTask('default', 'specialist', 5_000, 21_000)!;
    expect(finalAttempt.item.attemptCount).toBe(3);
    expect(board.failLeasedTask(task.id, finalAttempt.leaseToken, 'Still failing', {}, 21_100)).toBe('exhausted');
    expect(board.getItem(task.id)).toMatchObject({
      boardStatus: 'archived',
      attemptCount: 3,
      lastError: 'Still failing',
      handedOffFrom: 'generalist',
    });
  });
});
