import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { SessionManager } from '../agent/session.js';
import { GoalService } from '../goals/goal-service.js';
import { ScallopDatabase } from '../memory/db.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import {
  buildEvidenceClaimLedger,
  buildEvidenceExecutionContext,
  digestEvidenceProvenance,
} from '../security/evidence-grounding.js';
import {
  calculateNextRecurringOccurrence,
  taskRequiresRuntimeEvidence,
  UnifiedScheduler,
  verifyTaskRuntimeEvidence,
} from './scheduler.js';

const logger = pino({ level: 'silent' });
const schedulers: UnifiedScheduler[] = [];

function authoritativeReceipt(
  toolName: string,
  output: string,
  taskRequest = 'unit-test request',
  accountScope = 'default',
  outputDigest = 'a'.repeat(64),
) {
  return {
    toolName,
    success: true,
    completedAt: Date.now(),
    outputDigest,
    outputBytes: Math.max(1, Buffer.byteLength(output)),
    ...buildEvidenceClaimLedger(output),
    authority: 'authoritative' as const,
    sourceDigest: digestEvidenceProvenance('test-source', toolName),
    toolRequestDigest: digestEvidenceProvenance('test-tool-request', { toolName }),
    ...buildEvidenceExecutionContext(taskRequest, accountScope),
  };
}

function makeSessionManager(db: ScallopDatabase): SessionManager {
  return {
    createSession: vi.fn().mockImplementation(async metadata => {
      const id = `scheduled:${Math.random()}`;
      const row = db.createSession(id, metadata);
      return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt), messages: [] };
    }),
  } as unknown as SessionManager;
}

function makeScheduler(
  db: ScallopDatabase,
  executor: Pick<SubAgentExecutor, 'spawnAndWait' | 'preflightSkills'>,
  send = vi.fn().mockResolvedValue(true),
): UnifiedScheduler {
  const scheduler = new UnifiedScheduler({
    db,
    logger,
    sessionManager: makeSessionManager(db),
    subAgentExecutor: executor as SubAgentExecutor,
    onSendMessage: send,
    getTimezone: () => 'UTC',
    taskRetryDelayMs: 1_000,
    minAgentProactiveGapMs: 0,
  });
  schedulers.push(scheduler);
  return scheduler;
}

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
});

describe('scheduled factual-task evidence', () => {
  it('opens a durable circuit and notifies once when a required capability is absent', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily channel analytics', context: null, triggerAt: Date.now() - 1,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: { goal: 'Report current channel analytics', tools: ['youtube'] },
    });
    const spawnAndWait = vi.fn();
    const preflightSkills = vi.fn().mockReturnValue({
      available: [], missing: ['youtube'], documentationOnly: [],
    });
    const send = vi.fn().mockResolvedValue(true);
    const scheduler = makeScheduler(db, { spawnAndWait, preflightSkills } as any, send);

    await scheduler.evaluate();
    expect(spawnAndWait).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'blocked',
      boardStatus: 'waiting',
      result: { outcome: 'blocked', taskComplete: false, failureCode: 'required_capability_unavailable' },
    });
    expect(db.getScheduledItemsByUser('default').filter(row => row.status === 'pending')).toHaveLength(0);

    await scheduler.evaluate();
    expect(send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('rejects a plausible report without a successful runtime receipt', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Analytics report', context: null, triggerAt: Date.now() - 1,
      recurring: null, sourceMemoryId: null, maxAttempts: 1,
      taskConfig: { goal: 'Report current analytics', tools: ['fetch_metrics'], maxAttempts: 1 },
    });
    const executor = {
      preflightSkills: vi.fn().mockReturnValue({ available: ['fetch_metrics'], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn().mockResolvedValue({
        response: '455 subscribers and 2,350 views', iterationsUsed: 1,
        taskComplete: true, costUsd: 0.001, evidenceReceipts: [],
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    const scheduler = makeScheduler(db, executor as any, send);

    await scheduler.evaluate();
    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'failed',
      boardStatus: 'archived',
      result: { outcome: 'failed', taskComplete: false, failureCode: 'missing_runtime_evidence' },
    });
    db.close();
  });

  it('accepts and persists a real successful receipt without retaining tool output', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Analytics report', context: null, triggerAt: Date.now() - 1,
      recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Report current analytics', tools: ['fetch_metrics'] },
    });
    const receipt = authoritativeReceipt(
      'fetch_metrics',
      'The source API returned 455 subscribers.',
      'Report current analytics\nAnalytics report',
    );
    const executor = {
      preflightSkills: vi.fn().mockReturnValue({ available: ['fetch_metrics'], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn().mockResolvedValue({
        response: 'The verified value is 455 subscribers.', iterationsUsed: 1,
        taskComplete: true, costUsd: 0.001, evidenceReceipts: [receipt],
      }),
    };
    const scheduler = makeScheduler(db, executor as any);

    await scheduler.evaluate();
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'fired',
      boardStatus: 'done',
      result: { outcome: 'succeeded', taskComplete: true, evidenceReceipts: [receipt] },
    });
    expect(JSON.stringify(db.getScheduledItem(item.id)?.result)).not.toContain('The raw API payload');
    db.close();
  });

  it('requires every explicitly named receipt', () => {
    expect(verifyTaskRuntimeEvidence(
      { goal: 'Report metrics', tools: ['a', 'b'], requiredEvidenceTools: ['a', 'b'] },
      [authoritativeReceipt('a', 'ok')],
    )).toMatchObject({ passed: false, reason: expect.stringContaining('b') });
    expect(verifyTaskRuntimeEvidence(
      { goal: 'Report metrics', tools: ['a', 'b'] },
      [authoritativeReceipt('a', 'ok')],
    )).toEqual({ passed: true });
  });

  it('rejects receipts from unconfigured tools and synthetic empty success output', () => {
    const config = { goal: 'Report metrics', tools: ['metrics_api'] };
    expect(verifyTaskRuntimeEvidence(config, [{
      ...authoritativeReceipt('other_tool', 'some data'),
    }])).toMatchObject({ passed: false, reason: expect.stringContaining('metrics_api') });
    expect(verifyTaskRuntimeEvidence(config, [{
      toolName: 'metrics_api', success: true, completedAt: 1,
      outputDigest: 'c'.repeat(64), outputBytes: 0,
    }])).toMatchObject({ passed: false, reason: expect.stringContaining('No successful') });
  });

  it('rejects fabricated figures even when a configured tool produced other evidence', () => {
    const receipt = authoritativeReceipt(
      'metrics_api',
      'The API returned 455 subscribers.',
      'unit-test request',
      'default',
      'd'.repeat(64),
    );
    const config = { goal: 'Report subscriber metrics', tools: ['metrics_api'] };
    expect(verifyTaskRuntimeEvidence(config, [receipt], 'There are 999 subscribers.'))
      .toMatchObject({ passed: false, reason: expect.stringContaining('not grounded') });
    expect(verifyTaskRuntimeEvidence(config, [receipt], 'There are 455 views.'))
      .toMatchObject({ passed: false, reason: expect.stringContaining('not grounded') });
    expect(verifyTaskRuntimeEvidence(config, [receipt], 'There are 455 subscribers.'))
      .toEqual({ passed: true });
  });

  it('never treats bash or memory search as authoritative analytics sources', () => {
    const inventedBash = {
      ...authoritativeReceipt('bash', 'The channel has 76,000 subscribers.'),
      // Even a forged/configured authoritative flag cannot promote a generic
      // shell boundary into a data source.
      authority: 'authoritative' as const,
    };
    expect(verifyTaskRuntimeEvidence(
      { goal: 'Report current subscriber analytics', tools: ['bash'] },
      [inventedBash],
      'The channel has 76,000 subscribers.',
    )).toMatchObject({
      passed: false,
      reason: expect.stringContaining('No authoritative runtime receipt'),
    });

    const recalledOpinion = {
      ...authoritativeReceipt('memory_search', 'An old note guessed that YouTube Search was important.'),
      authority: 'untrusted' as const,
    };
    expect(verifyTaskRuntimeEvidence(
      { goal: 'Find the top traffic source', tools: ['memory_search'] },
      [recalledOpinion],
      'The top traffic source is YouTube Search.',
    )).toMatchObject({ passed: false });
  });

  it('binds categorical claims to authoritative output and request/account provenance', () => {
    const expected = buildEvidenceExecutionContext('Top-source report', 'account-a');
    const receipt = authoritativeReceipt(
      'analytics_api',
      '{"top_traffic_source":"Direct"}',
      'Top-source report',
      'account-a',
    );
    const config = { goal: 'Report the top traffic source', tools: ['analytics_api'] };

    expect(verifyTaskRuntimeEvidence(config, [receipt], 'The top traffic source is Direct.', expected))
      .toEqual({ passed: true });
    expect(verifyTaskRuntimeEvidence(config, [receipt], 'The top traffic source is YouTube Search.', expected))
      .toMatchObject({ passed: false, reason: expect.stringContaining('not grounded') });
    expect(verifyTaskRuntimeEvidence(
      config,
      [receipt],
      'The top traffic source is Direct.',
      buildEvidenceExecutionContext('Top-source report', 'account-b'),
    )).toMatchObject({ passed: false, reason: expect.stringContaining('No authoritative') });
  });

  it('does not allow evidencePolicy=none to exempt factual analytics', () => {
    expect(taskRequiresRuntimeEvidence({
      goal: 'Generate subscriber analytics', tools: [], evidencePolicy: 'none',
    })).toBe(true);
    expect(taskRequiresRuntimeEvidence({
      goal: 'Format the release note', tools: [], evidencePolicy: 'none',
    })).toBe(false);
  });

  it('losslessly quarantines legacy evidence-free results and reopens their goal task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-quarantine-'));
    const path = join(dir, 'memory.db');
    let db = new ScallopDatabase(path);
    const goals = new GoalService({ db, logger });
    const goal = await goals.createGoal('default', { title: 'Verified analytics', status: 'active' });
    const milestone = await goals.createMilestone(goal.id, { title: 'Collect data' });
    const task = await goals.createTask(milestone.id, { title: 'Fetch analytics' });
    await goals.complete(task.id);
    const item = db.getScheduledItemsByUser('default').find(row => row.goalId === task.id)!;
    db.close();

    const sqlite = new Database(path);
    sqlite.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done',
          task_config = ?, result = ?, fired_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ goal: 'Fetch real analytics', tools: ['analytics'] }),
      JSON.stringify({ response: 'Approximately 455 subscribers', completedAt: Date.now() }),
      Date.now(),
      item.id,
    );
    sqlite.close();

    db = new ScallopDatabase(path);
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'failed', boardStatus: 'archived',
      result: { outcome: 'failed', taskComplete: false, failureCode: 'missing_runtime_evidence' },
    });
    expect(db.getMemory(task.id)?.metadata).toMatchObject({ status: 'active' });
    expect(db.raw<{ item_id: string }>('SELECT item_id FROM scheduled_task_evidence_quarantine')).toEqual([
      { item_id: item.id },
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('quarantines no-tool factual analytics but only audits ambiguous legacy tool work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-classification-'));
    const path = join(dir, 'memory.db');
    let db = new ScallopDatabase(path);
    const factual = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Channel analytics report', context: null, triggerAt: Date.now(),
      recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Summarize channel analytics', tools: [] },
    });
    const ambiguous = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Prepare release notes', context: null, triggerAt: Date.now(),
      recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Format the release notes', tools: ['formatter'] },
    });
    db.close();

    const sqlite = new Database(path);
    sqlite.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done', result = ?, fired_at = ?
      WHERE id IN (?, ?)
    `).run(
      JSON.stringify({ response: 'Completed', completedAt: Date.now(), taskComplete: true, outcome: 'succeeded' }),
      Date.now(),
      factual.id,
      ambiguous.id,
    );
    sqlite.close();

    db = new ScallopDatabase(path);
    expect(db.getScheduledItem(factual.id)).toMatchObject({
      status: 'failed', result: { failureCode: 'missing_runtime_evidence' },
    });
    expect(db.getScheduledItem(ambiguous.id)).toMatchObject({
      status: 'fired', boardStatus: 'done', result: { outcome: 'succeeded' },
    });
    expect(db.raw<{ item_id: string; classification: string; decision: string }>(`
      SELECT item_id, classification, decision
      FROM scheduled_task_evidence_audit ORDER BY item_id
    `)).toEqual(expect.arrayContaining([
      { item_id: factual.id, classification: 'factual_task', decision: 'quarantined' },
      { item_id: ambiguous.id, classification: 'ambiguous_tool_task', decision: 'audit_only' },
    ]));
    expect(db.raw<{ item_id: string }>(
      'SELECT item_id FROM scheduled_task_evidence_quarantine WHERE item_id = ?', [ambiguous.id],
    )).toHaveLength(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('quarantines a legacy receipt whose source claims contradict the delivered figure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-claim-migration-'));
    const path = join(dir, 'memory.db');
    let db = new ScallopDatabase(path);
    const mismatch = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Subscriber analytics', context: null, triggerAt: Date.now(), recurring: null,
      sourceMemoryId: null, taskConfig: { goal: 'Fetch subscriber metrics', tools: ['metrics_api'] },
    });
    const matching = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Subscriber analytics', context: null, triggerAt: Date.now(), recurring: null,
      sourceMemoryId: null, taskConfig: { goal: 'Fetch subscriber metrics', tools: ['metrics_api'] },
    });
    db.close();
    const receipt = authoritativeReceipt(
      'metrics_api',
      '455 subscribers',
      'legacy migration request',
      'default',
      'e'.repeat(64),
    );
    const sqlite = new Database(path);
    const complete = sqlite.prepare(`
      UPDATE scheduled_items SET status = 'fired', board_status = 'done', result = ?, fired_at = ? WHERE id = ?
    `);
    complete.run(JSON.stringify({
      response: 'There are 999 subscribers.', completedAt: Date.now(), taskComplete: true,
      outcome: 'succeeded', evidenceReceipts: [receipt],
    }), Date.now(), mismatch.id);
    complete.run(JSON.stringify({
      response: 'There are 455 subscribers.', completedAt: Date.now(), taskComplete: true,
      outcome: 'succeeded', evidenceReceipts: [receipt],
    }), Date.now(), matching.id);
    sqlite.close();

    db = new ScallopDatabase(path);
    expect(db.getScheduledItem(mismatch.id)).toMatchObject({
      status: 'failed', result: { failureCode: 'missing_runtime_evidence' },
    });
    expect(db.getScheduledItem(matching.id)).toMatchObject({ status: 'fired' });
    expect(db.raw<{ item_id: string }>(
      'SELECT item_id FROM scheduled_task_evidence_quarantine WHERE item_id = ?', [mismatch.id],
    )).toEqual([{ item_id: mismatch.id }]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a runtime failure circuit across restart, pauses the series, and notifies once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-circuit-'));
    const path = join(dir, 'memory.db');
    let db = new ScallopDatabase(path);
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily maintenance', context: null, triggerAt: Date.now() - 1,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      maxAttempts: 3,
      taskConfig: { goal: 'Perform maintenance', tools: [], evidencePolicy: 'none', maxAttempts: 3 },
    });
    const send = vi.fn().mockResolvedValue(true);
    const failingExecutor = {
      preflightSkills: vi.fn().mockReturnValue({ available: [], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn().mockRejectedValue(new Error('provider temporarily unavailable request 1234')),
    };
    const first = makeScheduler(db, failingExecutor as any, send);
    await first.evaluate();
    expect(db.getScheduledItem(item.id)).toMatchObject({ status: 'pending', attemptCount: 1 });
    expect(db.raw<{ failure_count: number }>('SELECT failure_count FROM recurring_task_failure_circuits'))
      .toEqual([{ failure_count: 1 }]);
    first.stop();
    db.close();

    db = new ScallopDatabase(path);
    db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
    const second = makeScheduler(db, failingExecutor as any, send);
    await second.evaluate();
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'blocked', boardStatus: 'waiting',
      result: { outcome: 'blocked', failureCode: 'recurring_runtime_circuit_open' },
    });
    expect(db.raw<{ failure_count: number; opened_at: number; notification_reserved_at: number }>(`
      SELECT failure_count, opened_at, notification_reserved_at
      FROM recurring_task_failure_circuits
    `)).toEqual([{
      failure_count: 2,
      opened_at: expect.any(Number),
      notification_reserved_at: expect.any(Number),
    }]);
    expect(send).toHaveBeenCalledTimes(1);
    await second.evaluate();
    expect(send).toHaveBeenCalledTimes(1);

    const lateSuccessor = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily maintenance successor', context: null, triggerAt: Date.now() - 1,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: { goal: 'Perform maintenance', tools: [], evidencePolicy: 'none' },
    });
    await second.evaluate();
    expect(db.getScheduledItem(lateSuccessor.id)).toMatchObject({
      status: 'blocked', result: { failureCode: 'recurring_runtime_circuit_open' },
    });
    expect(failingExecutor.spawnAndWait).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    second.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears a pre-open failure streak after a verified retry succeeds', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily maintenance', context: null, triggerAt: Date.now() - 1,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      maxAttempts: 3,
      taskConfig: { goal: 'Perform maintenance', tools: [], evidencePolicy: 'none', maxAttempts: 3 },
    });
    const executor = {
      preflightSkills: vi.fn().mockReturnValue({ available: [], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValueOnce({
        response: 'Maintenance completed.', iterationsUsed: 1, taskComplete: true, costUsd: 0,
        evidenceReceipts: [],
      }),
    };
    const scheduler = makeScheduler(db, executor as any);
    await scheduler.evaluate();
    expect(db.raw<{ failure_count: number }>('SELECT failure_count FROM recurring_task_failure_circuits'))
      .toEqual([{ failure_count: 1 }]);
    db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
    await scheduler.evaluate();
    expect(db.getScheduledItem(item.id)).toMatchObject({ status: 'fired', result: { outcome: 'succeeded' } });
    expect(db.raw('SELECT * FROM recurring_task_failure_circuits')).toHaveLength(0);
    db.close();
  });
});

describe('recurrence and stale-run semantics', () => {
  it('supports true monthly calendar recurrence and clamps the 31st losslessly', () => {
    expect(new Date(calculateNextRecurringOccurrence(
      { type: 'monthly', dayOfMonth: 31, hour: 9, minute: 30 },
      'UTC', Date.parse('2027-01-31T09:30:00Z'),
    )!).toISOString()).toBe('2027-02-28T09:30:00.000Z');
    expect(new Date(calculateNextRecurringOccurrence(
      { type: 'monthly', dayOfMonth: 31, hour: 9, minute: 30 },
      'UTC', Date.parse('2028-01-31T09:30:00Z'),
    )!).toISOString()).toBe('2028-02-29T09:30:00.000Z');
  });

  it('expires a stale occurrence without executing it and schedules exactly one future run', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily maintenance task', context: null,
      triggerAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: { goal: 'Perform maintenance', tools: [], evidencePolicy: 'none' },
    });
    const executor = {
      preflightSkills: vi.fn().mockReturnValue({ available: [], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn(),
    };
    const scheduler = makeScheduler(db, executor as any);

    await scheduler.evaluate();
    expect(executor.spawnAndWait).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'expired', result: { failureCode: 'stale_occurrence_expired' },
    });
    const successors = db.getScheduledItemsByUser('default')
      .filter(row => row.id !== item.id && row.status === 'pending');
    expect(successors).toHaveLength(1);
    expect(successors[0].triggerAt).toBeGreaterThan(Date.now());
    db.close();
  });

  it('runs one deliberately catch-up occurrence when stalePolicy is run_once', async () => {
    const db = new ScallopDatabase(':memory:');
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Daily catch-up maintenance', context: null,
      triggerAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      recurring: { type: 'daily', hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: {
        goal: 'Perform catch-up maintenance', tools: [], evidencePolicy: 'none',
        stalePolicy: 'run_once',
      },
    });
    const executor = {
      preflightSkills: vi.fn().mockReturnValue({ available: [], missing: [], documentationOnly: [] }),
      spawnAndWait: vi.fn().mockResolvedValue({
        response: 'Catch-up maintenance completed.', iterationsUsed: 1,
        taskComplete: true, costUsd: 0, evidenceReceipts: [], completionSource: 'explicit_done',
      }),
    };
    const scheduler = makeScheduler(db, executor as any);

    await scheduler.evaluate();

    expect(executor.spawnAndWait).toHaveBeenCalledOnce();
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'fired', result: { outcome: 'succeeded' },
    });
    expect(db.getScheduledItemsByUser('default').filter(row => (
      row.id !== item.id && row.status === 'pending' && row.triggerAt > Date.now()
    ))).toHaveLength(1);
    db.close();
  });

  it('rejects new label/cadence mismatches and quarantines a legacy mismatch on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadence-integrity-'));
    const path = join(dir, 'memory.db');
    let db = new ScallopDatabase(path);
    expect(() => db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Monthly channel review', context: null, triggerAt: Date.now() + 1_000,
      recurring: { type: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: { goal: 'Review channel', evidencePolicy: 'none' },
    })).toThrow(/title says monthly/i);
    const legacy = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'event_prep',
      message: 'Weekly channel review', context: null, triggerAt: Date.now() + 1_000,
      recurring: { type: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 }, sourceMemoryId: null,
      taskConfig: { goal: 'Review channel', evidencePolicy: 'none' },
    });
    db.close();
    const sqlite = new Database(path);
    sqlite.prepare("UPDATE scheduled_items SET message = 'Monthly channel review' WHERE id = ?").run(legacy.id);
    sqlite.close();

    db = new ScallopDatabase(path);
    expect(db.getScheduledItem(legacy.id)).toMatchObject({
      status: 'blocked', boardStatus: 'waiting',
      result: { failureCode: 'schedule_cadence_mismatch' },
    });
    expect(db.raw<{ item_id: string }>('SELECT item_id FROM scheduled_cadence_quarantine')).toEqual([
      { item_id: legacy.id },
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
