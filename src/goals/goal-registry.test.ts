import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board/board-service.js';
import { ScallopDatabase } from '../memory/db.js';
import { GoalService } from './goal-service.js';

const logger = pino({ level: 'silent' });
const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scallop-goal-registry-'));
  tempDirs.push(dir);
  return join(dir, 'memories.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable goal registry', () => {
  it('does not inject an abandoned overdue goal unless the request names it', async () => {
    const dbPath = tempDatabasePath();
    const db = new ScallopDatabase(dbPath);
    const service = new GoalService({ db, logger });
    const old = Date.now() - 60 * 24 * 60 * 60 * 1_000;
    const goal = await service.createGoal('owner', {
      title: 'Old YouTube metrics campaign',
      status: 'active',
      dueDate: old + 7 * 24 * 60 * 60 * 1_000,
    });
    const raw = new Database(dbPath);
    raw.prepare('UPDATE memories SET created_at = ?, document_date = ?, last_accessed = ? WHERE id = ?')
      .run(old, old, old, goal.id);
    raw.close();

    expect(await service.getGoalContext('owner', 'What is on my plate today?')).toBe('');
    expect(await service.getGoalContext('owner', 'What happened to the YouTube metrics campaign?'))
      .toContain('Old YouTube metrics campaign');
    db.close();
  });

  it('backfills a missing board-referenced identity without changing its ID or link', async () => {
    const dbPath = tempDatabasePath();
    new ScallopDatabase(dbPath).close();

    // Model a public database written before registry enforcement: the board
    // reference survives, but its old goal memory no longer does.
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TRIGGER IF EXISTS trg_scheduled_goal_reference_insert;
      DROP TRIGGER IF EXISTS trg_scheduled_goal_reference_update;
    `);
    const now = Date.now();
    legacy.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, kind, type, message,
        message_provenance, context, trigger_at, recurring, status,
        source_memory_id, board_status, priority, goal_id, created_at, updated_at
      ) VALUES (
        'legacy-board', 'owner', NULL, 'user', 'task', 'reminder',
        'Recover the missing launch goal', 'user_literal', NULL, 0, NULL,
        'pending', NULL, 'backlog', 'medium', 'missing-goal-id', ?, ?
      )
    `).run(now, now);
    legacy.close();

    const db = new ScallopDatabase(dbPath);
    const registry = db.getGoalRegistryEntry('missing-goal-id');
    expect(registry).toMatchObject({
      id: 'missing-goal-id',
      userId: 'owner',
      title: 'Recover the missing launch goal',
      goalType: 'task',
      isPlaceholder: true,
      origin: 'scheduled_reference',
      deletedAt: null,
    });
    expect(db.getScheduledItem('legacy-board')?.goalId).toBe('missing-goal-id');

    // The durable record can rebuild a searchable projection, so a missing
    // memory no longer makes the referenced goal disappear from GoalService.
    const service = new GoalService({ db, logger });
    expect(await service.getGoal('missing-goal-id')).toMatchObject({
      id: 'missing-goal-id',
      content: 'Recover the missing launch goal',
      metadata: { goalType: 'task', status: 'backlog' },
    });
    db.close();
  });

  it('self-heals accidental projection deletion but never resurrects an explicit delete', async () => {
    const dbPath = tempDatabasePath();
    let db = new ScallopDatabase(dbPath);
    let service = new GoalService({ db, logger });
    const goal = await service.createGoal('owner', { title: 'Ship durable goals', status: 'active' });

    // Even an over-broad supersession that overwrites goal metadata cannot
    // erase the dedicated identity/status record.
    db.updateMemory(goal.id, {
      metadata: { supersededByGenericMemoryPipeline: true },
      isLatest: false,
      memoryType: 'superseded',
      prominence: 0.01,
    });
    expect(await service.getGoal(goal.id)).toMatchObject({
      id: goal.id,
      content: 'Ship durable goals',
      metadata: { goalType: 'goal', status: 'active' },
    });

    // Simulate an unsafe generic-memory cleanup path. Registry is independent,
    // and a later lookup restores the exact identity/status.
    expect(db.deleteMemory(goal.id)).toBe(true);
    expect(db.getMemory(goal.id)).toBeNull();
    expect(await service.getGoal(goal.id)).toMatchObject({
      id: goal.id,
      content: 'Ship durable goals',
      metadata: { status: 'active' },
    });

    expect(await service.delete(goal.id)).toBe(true);
    expect(await service.getGoal(goal.id)).toBeNull();
    expect(db.getGoalRegistryEntry(goal.id)).toMatchObject({
      id: goal.id,
      title: 'Ship durable goals',
      status: 'active',
    });
    expect(db.getGoalRegistryEntry(goal.id)?.deletedAt).not.toBeNull();
    db.close();

    db = new ScallopDatabase(dbPath);
    service = new GoalService({ db, logger });
    expect(await service.getGoal(goal.id)).toBeNull();
    expect(db.getGoalRegistryEntry(goal.id)?.deletedAt).not.toBeNull();
    db.close();
  });

  it('keeps completed identity/status durable across reopen and restores it losslessly', async () => {
    const dbPath = tempDatabasePath();
    let db = new ScallopDatabase(dbPath);
    let service = new GoalService({ db, logger });
    const goal = await service.createGoal('owner', { title: 'Close the loop', status: 'active' });
    await service.complete(goal.id);
    const completedAt = (await service.getGoal(goal.id))?.metadata.completedAt;
    expect(completedAt).toEqual(expect.any(Number));
    db.close();

    // Registry is the source of durable identity even if the memory projection
    // disappears between processes.
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM memories WHERE id = ?').run(goal.id);
    raw.close();

    db = new ScallopDatabase(dbPath);
    service = new GoalService({ db, logger });
    const restored = await service.getGoal(goal.id);
    expect(restored).toMatchObject({
      id: goal.id,
      content: 'Close the loop',
      metadata: { status: 'completed', completedAt },
    });
    expect(db.getGoalRegistryEntry(goal.id)).toMatchObject({
      status: 'completed',
      completedAt,
      deletedAt: null,
    });

    await service.reopen(goal.id);
    expect(db.getGoalRegistryEntry(goal.id)).toMatchObject({
      status: 'active',
      completedAt: null,
    });
    db.close();
  });

  it('rejects raw dangling, deleted, and cross-owner scheduled goal links', async () => {
    const dbPath = tempDatabasePath();
    const db = new ScallopDatabase(dbPath);
    const service = new GoalService({ db, logger });
    const live = await service.createGoal('owner', { title: 'Owned goal' });
    const deleted = await service.createGoal('owner', { title: 'Deleted goal' });
    await service.delete(deleted.id);
    db.close();

    const raw = new Database(dbPath);
    const insert = raw.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, source, kind, type, message, message_provenance,
        trigger_at, status, board_status, priority, goal_id, created_at, updated_at
      ) VALUES (?, ?, 'user', 'task', 'reminder', 'test', 'user_literal',
        0, 'pending', 'backlog', 'medium', ?, ?, ?)
    `);
    const now = Date.now();
    expect(() => insert.run('dangling', 'owner', 'does-not-exist', now, now)).toThrow(/live same-owner goal/);
    expect(() => insert.run('deleted', 'owner', deleted.id, now, now)).toThrow(/live same-owner goal/);
    expect(() => insert.run('cross-owner', 'intruder', live.id, now, now)).toThrow(/live same-owner goal/);
    expect(() => insert.run('valid', 'owner', live.id, now, now)).not.toThrow();
    raw.close();
  });

  it('completes a linked task through the registry when its memory projection vanished', async () => {
    const db = new ScallopDatabase(':memory:');
    const service = new GoalService({ db, logger });
    const board = new BoardService(db, logger);
    const goal = await service.createGoal('owner', { title: 'Publish', status: 'active' });
    const milestone = await service.createMilestone(goal.id, { title: 'Prepare' });
    const task = await service.createTask(milestone.id, { title: 'Verify release' });
    const linked = db.getScheduledItemsByUser('owner').find(item => item.goalId === task.id)!;

    db.deleteMemory(task.id);
    expect(db.getMemory(task.id)).toBeNull();
    board.markDone(linked.id, 'User verified release');

    expect(await service.getGoal(task.id)).toMatchObject({
      id: task.id,
      metadata: { status: 'completed' },
    });
    expect(db.getGoalRegistryEntry(task.id)).toMatchObject({ status: 'completed' });
    db.close();
  });
});
