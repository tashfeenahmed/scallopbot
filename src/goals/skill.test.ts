import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import { GoalService } from './goal-service.js';
import { createVerifiedGoalSkill } from './skill.js';

const logger = pino({ level: 'silent' });

describe('execute_goal native skill', () => {
  let db: ScallopDatabase;
  let service: GoalService;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
    service = new GoalService({ db, logger });
  });

  afterEach(() => db.close());

  it('is runtime-executable and delegates bounded turns until evidence passes', async () => {
    const goal = await service.createGoal('default', { title: 'Build an artifact', status: 'active' });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'artifact ready [EVIDENCE:file]',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.025,
    });
    const skill = createVerifiedGoalSkill(service, { spawnAndWait } as unknown as SubAgentExecutor);

    const result = await skill.handler!({
      args: {
        action: 'run',
        goal_id: goal.id,
        acceptance_criteria: JSON.stringify([
          { id: 'text', description: 'Output is ready', kind: 'contains', expected: 'artifact ready' },
        ]),
        max_turns: 3,
        turn_slice: 2,
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).state).toBe('completed');
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.output).costUsedUsd).toBeCloseTo(0.025);
    expect((await service.getGoal(goal.id))?.metadata.status).toBe('completed');
  });

  it('does not accept a worker-authored manual evidence marker', async () => {
    const goal = await service.createGoal('default', { title: 'Verify an external artifact', status: 'active' });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'Trust me, it exists. [EVIDENCE:file]',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.01,
    });
    const skill = createVerifiedGoalSkill(service, { spawnAndWait } as unknown as SubAgentExecutor);

    const result = await skill.handler!({
      args: {
        action: 'run',
        goal_id: goal.id,
        acceptance_criteria: JSON.stringify([
          { id: 'file', description: 'Artifact exists', kind: 'manual' },
        ]),
        max_turns: 1,
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    expect(result.success).toBe(false);
    expect(JSON.parse(result.output).state).toBe('budget_exhausted');
    expect((await service.getGoal(goal.id))?.metadata.status).not.toBe('completed');
  });

  it('does not let the model-facing verify action self-assert manual evidence', async () => {
    const goal = await service.createGoal('default', {
      title: 'Verify an external artifact',
      status: 'active',
      contract: {
        acceptanceCriteria: [
          { id: 'file', description: 'Artifact exists', kind: 'manual' },
        ],
      },
    });
    const skill = createVerifiedGoalSkill(service, {} as SubAgentExecutor);
    const result = await skill.handler!({
      args: {
        action: 'verify',
        goal_id: goal.id,
        output: 'The artifact exists.',
        evidence: JSON.stringify({ file: true }),
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    expect(result.success).toBe(false);
    expect(JSON.parse(result.output).criteria[0]).toMatchObject({
      id: 'file',
      passed: false,
    });
    expect((await service.getGoal(goal.id))?.metadata.status).not.toBe('completed');
  });

  it('enforces the configured dollar budget from live sub-agent cost', async () => {
    const goal = await service.createGoal('default', { title: 'Cost-bounded work', status: 'active' });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'done',
      iterationsUsed: 1,
      taskComplete: true,
      costUsd: 0.031,
    });
    const skill = createVerifiedGoalSkill(service, { spawnAndWait } as unknown as SubAgentExecutor);

    const result = await skill.handler!({
      args: {
        action: 'run',
        goal_id: goal.id,
        acceptance_criteria: JSON.stringify([
          { id: 'done', description: 'Done', kind: 'equals', expected: 'done' },
        ]),
        max_turns: 3,
        max_cost_usd: 0.02,
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    const output = JSON.parse(result.output);
    expect(result.success).toBe(false);
    expect(output.state).toBe('budget_exhausted');
    expect(output.costUsedUsd).toBeCloseTo(0.031);
    expect((await service.getGoal(goal.id))?.metadata.status).not.toBe('completed');
  });

  it('uses the remaining turn budget when no invocation slice is requested', async () => {
    const goal = await service.createGoal('default', { title: 'Needs four attempts', status: 'active' });
    const spawnAndWait = vi.fn()
      .mockResolvedValueOnce({ response: 'not yet', iterationsUsed: 1, taskComplete: true, costUsd: 0.001 })
      .mockResolvedValueOnce({ response: 'still working', iterationsUsed: 1, taskComplete: true, costUsd: 0.001 })
      .mockResolvedValueOnce({ response: 'almost', iterationsUsed: 1, taskComplete: true, costUsd: 0.001 })
      .mockResolvedValueOnce({ response: 'done', iterationsUsed: 1, taskComplete: true, costUsd: 0.001 });
    const skill = createVerifiedGoalSkill(service, { spawnAndWait } as unknown as SubAgentExecutor);

    const result = await skill.handler!({
      args: {
        action: 'run',
        goal_id: goal.id,
        acceptance_criteria: JSON.stringify([
          { id: 'done', description: 'Done', kind: 'equals', expected: 'done' },
        ]),
        max_turns: 5,
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    expect(JSON.parse(result.output).state).toBe('completed');
    expect(spawnAndWait).toHaveBeenCalledTimes(4);
  });

  it('fails closed when the independent runtime judge rejects apparent completion', async () => {
    const goal = await service.createGoal('default', { title: 'Produce real proof', status: 'active' });
    const spawnAndWait = vi.fn().mockResolvedValue({
      response: 'done', iterationsUsed: 1, taskComplete: true, costUsd: 0.01,
    });
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{ type: 'text', text: '{"passed":false,"reason":"No concrete proof"}' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'judge',
        },
        provider: 'judge',
        attemptedProviders: ['judge'],
      }),
    };
    const skill = createVerifiedGoalSkill(
      service,
      { spawnAndWait } as unknown as SubAgentExecutor,
      router as any,
    );

    const result = await skill.handler!({
      args: {
        action: 'run',
        goal_id: goal.id,
        acceptance_criteria: JSON.stringify([
          { id: 'done', description: 'Done', kind: 'equals', expected: 'done' },
        ]),
        max_turns: 1,
      },
      workspace: '/tmp',
      sessionId: 'parent-session',
      userId: 'default',
    });

    expect(result.success).toBe(false);
    expect(router.executeWithFallback).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.output).verification.judgeReason).toBe('No concrete proof');
  });
});
