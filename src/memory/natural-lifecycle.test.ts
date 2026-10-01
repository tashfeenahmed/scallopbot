import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { BoardService } from '../board/board-service.js';
import { nremClusterFailureBackoffMs, ScallopDatabase, type ScheduledItem } from './db.js';

const DB_PATH = '/tmp/scallop-natural-lifecycle-test.db';
const DAY = 24 * 60 * 60 * 1000;

function clean(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_PATH + suffix);
    } catch {
      /* absent */
    }
  }
}

function addTask(
  db: ScallopDatabase,
  input: {
    title: string;
    triggerAt: number;
    source?: 'user' | 'agent';
    recurring?: ScheduledItem['recurring'];
    boardStatus?: ScheduledItem['boardStatus'];
  }
): ScheduledItem {
  return db.addScheduledItem({
    userId: 'default',
    sessionId: null,
    source: input.source ?? 'user',
    kind: 'task',
    type: 'event_prep',
    message: input.title,
    context: null,
    triggerAt: input.triggerAt,
    recurring: input.recurring ?? null,
    sourceMemoryId: null,
    sourceItemId: null,
    taskConfig: { goal: input.title, tools: [] },
    boardStatus: input.boardStatus ?? 'scheduled'
  });
}

function blockTask(db: ScallopDatabase, item: ScheduledItem, now: number): void {
  const board = new BoardService(db);
  const claim = board.claimNextTask('default', 'test-worker', 60_000, now);
  expect(claim?.item.id).toBe(item.id);
  expect(
    board.blockLeasedTask(
      item.id,
      claim!.leaseToken,
      'Capability unavailable',
      {
        response: 'Capability unavailable',
        completedAt: now,
        taskComplete: false,
        outcome: 'blocked',
        failureCode: 'capability_unavailable'
      },
      now
    )
  ).not.toBeNull();
}

describe('natural lifecycle reconciliation', () => {
  beforeEach(clean);
  afterEach(clean);

  it('corrects emoji-prefixed cadence, unschedules absurd inbox dates, and expires stale blocks losslessly', () => {
    const now = Date.UTC(2026, 6, 16, 8, 0, 0);
    let db = new ScallopDatabase(DB_PATH, { runRetentionMaintenance: false });
    const monthly = addTask(db, {
      title: '🎯 Monthly Channel Health Review',
      triggerAt: now - 4 * DAY,
      recurring: { type: 'monthly', dayOfMonth: 12, hour: 11, minute: 0 }
    });
    const staleBlocked = addTask(db, {
      title: 'Time to put the bin out',
      triggerAt: now - 3 * DAY
    });
    const recentBlocked = addTask(db, {
      title: 'Recent unavailable task',
      triggerAt: now - 60 * 60 * 1000
    });
    const farFuture = addTask(db, {
      title: 'Research the project and produce a report',
      triggerAt: now + 900 * DAY,
      source: 'agent',
      boardStatus: 'inbox'
    });
    blockTask(db, monthly, now);
    blockTask(db, staleBlocked, now);
    blockTask(db, recentBlocked, now);
    db.close();

    // Reproduce a legacy row that predates recurrence validation.
    const raw = new Database(DB_PATH);
    raw
      .prepare('UPDATE scheduled_items SET recurring = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'weekly', dayOfWeek: 0, hour: 11, minute: 0 }), monthly.id);
    raw.close();

    db = new ScallopDatabase(DB_PATH, { runRetentionMaintenance: false });
    const result = db.reconcileNaturalLifecycle('default', now);

    expect(result).toEqual({
      cadenceCorrected: 1,
      farFutureTasksUnscheduled: 1,
      staleBlockedExpired: 2,
      overdueGoalsMovedToBacklog: 0
    });
    expect(db.getScheduledItem(monthly.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
      recurring: { type: 'monthly', dayOfMonth: 12, hour: 11, minute: 0 }
    });
    expect(db.getScheduledItem(staleBlocked.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived'
    });
    expect(db.getScheduledItem(recentBlocked.id)).toMatchObject({
      status: 'blocked',
      boardStatus: 'waiting'
    });
    expect(db.getScheduledItem(farFuture.id)).toMatchObject({
      status: 'pending',
      boardStatus: 'inbox',
      triggerAt: 0
    });
    expect(
      db.raw<{ action: string }>('SELECT action FROM scheduled_lifecycle_reconciliation_audit ORDER BY action')
    ).toHaveLength(4);

    expect(db.reconcileNaturalLifecycle('default', now)).toEqual({
      cadenceCorrected: 0,
      farFutureTasksUnscheduled: 0,
      staleBlockedExpired: 0,
      overdueGoalsMovedToBacklog: 0
    });
    db.close();
  });

  it('moves a zero-progress goal over 30 days past due to backlog without deleting it', () => {
    const now = Date.UTC(2026, 6, 16, 8, 0, 0);
    const db = new ScallopDatabase(DB_PATH, { runRetentionMaintenance: false });
    const goal = db.addMemory({
      userId: 'default',
      content: 'Daily analytics tracking',
      category: 'insight',
      memoryType: 'static_profile',
      importance: 8,
      confidence: 1,
      isLatest: true,
      source: 'user',
      documentDate: now - 100 * DAY,
      eventDate: now - 40 * DAY,
      prominence: 1,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: {
        goalType: 'goal',
        status: 'active',
        dueDate: now - 40 * DAY,
        progress: 0,
        checkinFrequency: 'daily'
      },
      learnedFrom: 'conversation',
      timesConfirmed: 1,
      contradictionIds: null
    });

    const result = db.reconcileNaturalLifecycle('default', now);

    expect(result.overdueGoalsMovedToBacklog).toBe(1);
    expect(db.getMemory(goal.id)?.metadata).toMatchObject({
      status: 'backlog',
      dormantAt: now,
      dormantReason: 'overdue_without_progress'
    });
    expect(db.getGoalRegistryEntry(goal.id)).toMatchObject({
      status: 'backlog',
      deletedAt: null
    });
    expect(
      db.raw<{ reason: string }>('SELECT reason FROM goal_lifecycle_reconciliation_audit WHERE goal_id = ?', [goal.id])
    ).toEqual([
      {
        reason: 'Active goal was over 30 days past due with no recorded progress'
      }
    ]);
    db.close();
  });

  it('backs off failed NREM source sets and clears the ledger after success', () => {
    const now = Date.UTC(2026, 6, 16, 8, 0, 0);
    const db = new ScallopDatabase(DB_PATH, { runRetentionMaintenance: false });
    const sourceIds = ['memory-c', 'memory-a', 'memory-b'];

    const first = db.recordNremClusterFailure('default', sourceIds, 'summary_not_shorter', now);
    expect(first.failureCount).toBe(1);
    expect(first.nextRetryAt).toBe(now + nremClusterFailureBackoffMs(1));
    expect(db.getNremClusterFingerprintsInBackoff('default', now + DAY)).toContain(first.fingerprint);
    expect(db.getNremClusterFingerprintsInBackoff('default', first.nextRetryAt)).not.toContain(first.fingerprint);

    const second = db.recordNremClusterFailure('default', sourceIds, 'summary_not_shorter', first.nextRetryAt);
    expect(second.failureCount).toBe(2);
    expect(second.nextRetryAt - second.lastFailureAt).toBe(6 * DAY);
    expect(db.clearNremClusterFailure('default', sourceIds)).toBe(true);
    expect(db.getNremClusterFailureStates('default')).toEqual([]);
    db.close();
  });

  it('returns only child sessions whose transcript has not already been purged', () => {
    const now = Date.UTC(2026, 6, 16, 8, 0, 0);
    const db = new ScallopDatabase(DB_PATH, { runRetentionMaintenance: false });
    db.createSession('parent', { userId: 'default' });
    db.createSession('child', { userId: 'default', isSubAgent: true });
    db.addSessionMessage('child', 'user', 'internal worker request', 'worker_internal');
    db.insertSubAgentRun({
      id: 'run-1',
      parentSessionId: 'parent',
      childSessionId: 'child',
      task: 'internal task',
      label: 'worker',
      status: 'completed',
      allowedSkills: null,
      modelTier: 'standard',
      timeoutMs: 60_000,
      resultResponse: 'done',
      resultIterations: 1,
      resultTaskComplete: true,
      error: null,
      inputTokens: 1,
      outputTokens: 1,
      createdAt: now - DAY,
      startedAt: now - DAY,
      completedAt: now - DAY,
      updatedAt: now - DAY
    });

    expect(db.getSubAgentChildSessionIds(60_000)).toEqual(['child']);
    expect(db.deleteSession('child', 'subagent_cleanup', 'gardener')).toBe(true);
    expect(db.getSubAgentChildSessionIds(60_000)).toEqual([]);
    db.close();
  });
});
