import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import { GoalService } from './goal-service.js';

const logger = pino({ level: 'silent' });

describe('verified persistent goal execution', () => {
  let db: ScallopDatabase;
  let service: GoalService;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
    service = new GoalService({ db, logger });
  });

  afterEach(() => db.close());

  it('keeps working until deterministic acceptance criteria pass', async () => {
    const goal = await service.createGoal('default', {
      title: 'Ship the verified artifact',
      status: 'active',
      contract: {
        acceptanceCriteria: [
          { id: 'tests', description: 'Tests pass', kind: 'contains', expected: '12 tests passed' },
          { id: 'artifact', description: 'Artifact exists', kind: 'manual' },
        ],
      },
      budget: { maxTurns: 4, maxCostUsd: 1 },
    });

    const runner = vi.fn()
      .mockResolvedValueOnce({ output: 'Implementation drafted', costUsd: 0.1 })
      .mockResolvedValueOnce({
        output: '12 tests passed',
        evidence: { artifact: true },
        costUsd: 0.2,
      });

    const result = await service.runUntilVerified(goal.id, runner);

    expect(result.state).toBe('completed');
    expect(result.turnsThisRun).toBe(2);
    expect(result.verification?.passed).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.goal.metadata.status).toBe('completed');
    expect(result.goal.metadata.execution).toMatchObject({
      state: 'completed',
      turnsUsed: 2,
    });
    expect(result.goal.metadata.execution?.costUsedUsd).toBeCloseTo(0.3);
  });

  it('stops at a hard turn budget instead of claiming success', async () => {
    const goal = await service.createGoal('default', {
      title: 'Find a result',
      status: 'active',
      contract: {
        acceptanceCriteria: [
          { id: 'answer', description: 'Answer is present', kind: 'contains', expected: 'verified answer' },
        ],
      },
      budget: { maxTurns: 2 },
    });

    const runner = vi.fn().mockResolvedValue({ output: 'not yet' });
    const result = await service.runUntilVerified(goal.id, runner);

    expect(result.state).toBe('budget_exhausted');
    expect(result.reason).toContain('2/2');
    expect(result.goal.metadata.status).toBe('active');
    expect(result.verification?.passed).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit turn slice runnable instead of silently parking it', async () => {
    const goal = await service.createGoal('default', {
      title: 'Continue across bounded invocations',
      contract: {
        acceptanceCriteria: [
          { id: 'answer', description: 'Verified answer', kind: 'equals', expected: 'done' },
        ],
      },
      budget: { maxTurns: 3 },
    });

    const first = await service.runUntilVerified(
      goal.id,
      async () => ({ output: 'not yet' }),
      { maxTurnsThisRun: 1 },
    );
    expect(first.state).toBe('running');
    expect(first.goal.metadata.execution?.parkReason).toBeUndefined();

    const resumed = await service.runUntilVerified(goal.id, async () => ({ output: 'done' }));
    expect(resumed.state).toBe('completed');
    expect(resumed.goal.metadata.execution?.turnsUsed).toBe(2);
  });

  it('persists a parked goal and resumes without resetting counters', async () => {
    const goal = await service.createGoal('default', {
      title: 'Wait for build',
      status: 'active',
      contract: {
        acceptanceCriteria: [
          { id: 'build', description: 'Build passed', kind: 'equals', expected: 'build passed' },
        ],
      },
      budget: { maxTurns: 3 },
    });

    const resumeAt = Date.now() + 60_000;
    const parked = await service.runUntilVerified(goal.id, async () => ({
      output: 'build is still running',
      parkUntil: resumeAt,
      parkReason: 'Waiting for CI',
    }));
    expect(parked.state).toBe('waiting');
    expect(parked.goal.metadata.execution?.turnsUsed).toBe(1);

    // A fresh service instance proves state is durable rather than process-local.
    const afterRestart = new GoalService({ db, logger });
    const stillParked = await afterRestart.runUntilVerified(goal.id, vi.fn());
    expect(stillParked.state).toBe('waiting');
    expect(stillParked.turnsThisRun).toBe(0);

    await afterRestart.resumeExecution(goal.id);
    const completed = await afterRestart.runUntilVerified(goal.id, async () => ({ output: 'build passed' }));
    expect(completed.state).toBe('completed');
    expect(completed.goal.metadata.execution?.turnsUsed).toBe(2);
  });

  it('fails closed when an optional qualitative judge is unavailable', async () => {
    const goal = await service.createGoal('default', {
      title: 'Produce a high-quality answer',
      contract: {
        acceptanceCriteria: [
          { id: 'answer', description: 'Answer marker', kind: 'contains', expected: 'answer ready' },
        ],
      },
      budget: { maxTurns: 1 },
    });

    const result = await service.runUntilVerified(
      goal.id,
      async () => ({ output: 'answer ready' }),
      { judge: async () => { throw new Error('provider offline'); } },
    );

    expect(result.state).toBe('budget_exhausted');
    expect(result.verification?.passed).toBe(false);
    expect(result.verification?.judgeReason).toContain('failed closed');
  });

  it('requires an explicit resume for indefinite parks and enforces cost overrun', async () => {
    const goal = await service.createGoal('default', {
      title: 'Cost-bounded external job',
      contract: {
        acceptanceCriteria: [
          { id: 'done', description: 'Done', kind: 'equals', expected: 'done' },
        ],
      },
      budget: { maxTurns: 3, maxCostUsd: 0.1 },
    });

    await service.parkExecution(goal.id, 'Waiting for approval');
    const runner = vi.fn();
    const parked = await service.runUntilVerified(goal.id, runner);
    expect(parked.state).toBe('waiting');
    expect(runner).not.toHaveBeenCalled();

    await service.resumeExecution(goal.id);
    const overBudget = await service.runUntilVerified(goal.id, async () => ({
      output: 'done',
      costUsd: 0.11,
    }));
    expect(overBudget.state).toBe('budget_exhausted');
    expect(overBudget.goal.metadata.status).not.toBe('completed');
    expect(overBudget.reason).toContain('Cost budget exceeded');
  });

  it('rejects invalid and potentially catastrophic acceptance contracts', async () => {
    await expect(service.createGoal('default', {
      title: 'Unsafe criterion kind',
      contract: {
        acceptanceCriteria: [
          { id: 'bad', description: 'Invalid kind', kind: 'unknown' as any, expected: 'x' },
        ],
      },
    })).rejects.toThrow(/invalid kind/);

    await expect(service.createGoal('default', {
      title: 'Unsafe regular expression',
      contract: {
        acceptanceCriteria: [
          { id: 'regex', description: 'Must match safely', kind: 'regex', expected: '(a+)+$' },
        ],
      },
    })).rejects.toThrow(/potentially unsafe regular expression/);
  });
});
