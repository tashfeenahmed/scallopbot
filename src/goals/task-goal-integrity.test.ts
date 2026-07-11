import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { BoardService } from '../board/board-service.js';
import { ScallopDatabase } from '../memory/db.js';
import { GoalService } from './goal-service.js';

const logger = pino({ level: 'silent' });

describe('task outcomes and durable goals', () => {
  let db: ScallopDatabase;
  let goals: GoalService;
  let board: BoardService;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
    goals = new GoalService({ db, logger });
    board = new BoardService(db, logger);
  });

  afterEach(() => db.close());

  it('stores active goal hierarchy as non-decaying state and self-heals supersession', async () => {
    const goal = await goals.createGoal('default', { title: 'Durable objective', status: 'active' });
    expect(db.getMemory(goal.id)).toMatchObject({
      isLatest: true,
      memoryType: 'static_profile',
      prominence: 1,
    });

    // Simulate an old generic-memory supersession path. The database guard
    // immediately repairs application-state fields.
    db.updateMemory(goal.id, {
      isLatest: false,
      memoryType: 'superseded',
      prominence: 0.01,
    });
    expect(db.getMemory(goal.id)).toMatchObject({
      isLatest: true,
      memoryType: 'static_profile',
      prominence: 1,
    });
    expect((await goals.getActiveGoals('default')).map(item => item.id)).toContain(goal.id);
  });

  it('never records a failed worker as done or completes its linked goal task', async () => {
    const goal = await goals.createGoal('default', { title: 'Publish report', status: 'active' });
    const milestone = await goals.createMilestone(goal.id, { title: 'Prepare report' });
    const task = await goals.createTask(milestone.id, { title: 'Fetch verified analytics' });
    const boardItem = Object.values(board.getBoard('default').columns)
      .flat()
      .find(item => item.goalId === task.id)!;
    const claim = board.claimNextTask('default', 'worker', 10_000, 1_000)!;
    expect(claim.item.id).toBe(boardItem.id);

    expect(board.completeLeasedTask(boardItem.id, claim.leaseToken, {
      response: 'Could not access analytics',
      completedAt: 1_100,
      taskComplete: false,
      outcome: 'failed',
      failureCode: 'missing_runtime_evidence',
    }, 1_100)).toBeNull();
    expect((await goals.getGoal(task.id))?.metadata.status).not.toBe('completed');

    expect(board.failLeasedTask(
      boardItem.id,
      claim.leaseToken,
      'Missing evidence',
      {
        retryable: false,
        result: {
          response: 'Missing evidence',
          completedAt: 1_200,
          taskComplete: false,
          outcome: 'failed',
          failureCode: 'missing_runtime_evidence',
        },
      },
      1_200,
    )).toBe('exhausted');
    expect(db.getScheduledItem(boardItem.id)).toMatchObject({
      status: 'failed',
      boardStatus: 'archived',
    });
    expect((await goals.getGoal(task.id))?.metadata.status).not.toBe('completed');
    expect((await goals.getGoal(goal.id))?.metadata.status).toBe('active');
  });

  it('only bridges a verified board completion to a task, never a top-level goal', async () => {
    const topGoal = await goals.createGoal('default', { title: 'Top-level goal', status: 'active' });
    const item = board.createItem('default', {
      title: 'Loose board item',
      kind: 'task',
      goalId: topGoal.id,
      boardStatus: 'backlog',
    });
    board.markDone(item.id, 'User confirmed this board item is complete');

    expect(db.getScheduledItem(item.id)?.result).toMatchObject({
      outcome: 'succeeded',
      taskComplete: true,
      completionSource: 'user',
    });
    expect((await goals.getGoal(topGoal.id))?.metadata.status).toBe('active');
  });

  it('unlinks board history before an explicitly deleted goal task', async () => {
    const goal = await goals.createGoal('default', { title: 'Disposable hierarchy' });
    const milestone = await goals.createMilestone(goal.id, { title: 'Milestone' });
    const task = await goals.createTask(milestone.id, { title: 'Task' });
    const linked = db.getScheduledItemsByUser('default').find(item => item.goalId === task.id)!;

    expect(await goals.delete(task.id)).toBe(true);
    expect(db.getScheduledItem(linked.id)).toMatchObject({ goalId: null, sourceMemoryId: null });
  });
});
