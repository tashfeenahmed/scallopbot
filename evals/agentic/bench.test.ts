/**
 * ScallopBench harness tests. No network: the scripted provider replays each
 * task's reference solution through the real Agent.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportTasks, scoreExternal } from './external.js';
import { runTask } from './harness.js';
import { resolveBenchModel } from './providers.js';
import { buildScorecard, formatScorecard } from './scorecard.js';
import { scoreReference } from './selfcheck.js';
import { ALL_TASKS, selectTasks } from './tasks/index.js';
import { BLOCKED_RESULT_RE, CANNED_REFUSAL_RE } from './trace.js';
import type { BenchTask } from './types.js';

const taskById = (id: string): BenchTask => {
  const task = ALL_TASKS.find(t => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

let previousLogSize: string | undefined;
beforeAll(() => {
  previousLogSize = process.env.SCALLOPBENCH_GIANT_LOG_MB;
  process.env.SCALLOPBENCH_GIANT_LOG_MB = '2';
});
afterAll(() => {
  if (previousLogSize === undefined) delete process.env.SCALLOPBENCH_GIANT_LOG_MB;
  else process.env.SCALLOPBENCH_GIANT_LOG_MB = previousLogSize;
});

describe('ScallopBench task set', () => {
  it('has the Phase 0 categories and unique ids', () => {
    const ids = ALL_TASKS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(selectTasks('trap').length).toBeGreaterThanOrEqual(12);
    expect(selectTasks('coding').length).toBeGreaterThanOrEqual(6);
    expect(selectTasks('assistant').length).toBeGreaterThanOrEqual(3);
    for (const task of ALL_TASKS) expect(task.reference).toHaveLength(task.prompt.length);
    expect(() => selectTasks('nope')).toThrow(/Unknown task selector/);
  });

  it.each(ALL_TASKS.map(task => [task.id, task] as const))(
    '%s: scorer accepts the reference solution run through the real skills',
    async (_id, task) => {
      const result = await scoreReference(task);
      expect(result.pass, result.details).toBe(true);
    },
    60_000,
  );

  it.each(ALL_TASKS.map(task => [task.id, task] as const))(
    '%s: scorer rejects the untouched workspace',
    async (_id, task) => {
      const result = await scoreReference(task, { applySteps: false });
      expect(result.pass, result.details).toBe(false);
    },
    60_000,
  );
});

describe('trace patterns', () => {
  it('recognises the canned refusal and gate refusals', () => {
    expect(CANNED_REFUSAL_RE.test('I could not produce a safe, reliable final response for that turn.')).toBe(true);
    expect(BLOCKED_RESULT_RE.test('[TOOL_ERROR code=SAFETY_LOCAL_INTENT_REQUIRED] BLOCKED: nope')).toBe(true);
    expect(BLOCKED_RESULT_RE.test('Error: ENOENT: no such file')).toBe(false);
  });
});

describe('harness through the real Agent (scripted provider)', () => {
  it('records per-turn traces for single- and multi-turn tasks', async () => {
    const model = resolveBenchModel('scripted');
    const ids = ['trap-giant-log', 'trap-code-block-reply', 'assistant-expenses-multiturn'];
    const results = await Promise.all(ids.map(id => runTask(taskById(id), model, { maxIterations: 10 })));

    for (const [index, result] of results.entries()) {
      const task = taskById(ids[index]!);
      expect(result.error).toBeUndefined();
      expect(result.trace.turns).toHaveLength(task.prompt.length);
      for (const turn of result.trace.turns) {
        expect(turn.llmCalls).toBeGreaterThanOrEqual(1);
        expect(turn.completionReason).not.toBe('error');
        expect(turn.totalMs).toBeGreaterThanOrEqual(0);
        expect(turn.timeToFirstReplyMs).toBeLessThanOrEqual(turn.totalMs);
      }
      expect(result.trace.llmCalls.length).toBe(result.trace.turns.reduce((sum, t) => sum + t.llmCalls, 0));
    }

    // Transcript extraction: the grep ran through the real bash skill.
    const giant = results[0]!;
    expect(giant.trace.llmCalls.some(call => call.purpose === 'tool_call' && call.toolUses.includes('bash'))).toBe(true);
    const grep = giant.trace.toolCalls.find(call => call.name === 'bash');
    expect(grep?.result).toBeDefined();
    // The outcome brain no longer rewrites foreground replies: no extra call.
    expect(giant.trace.llmCalls.some(call => call.purpose === 'outcome_brain')).toBe(false);

    // Multi-turn: tool calls are attributed to the turn that made them.
    const multi = results[2]!;
    expect(multi.trace.toolCalls.map(call => call.turn)).toEqual([0, 1]);

    const card = buildScorecard('scripted', results);
    expect(card.runs).toBe(3);
    expect(card.userTurns).toBe(4);
    expect(card.meanLlmCallsPerTurn).toBeGreaterThan(0);
    expect(card.cacheReadShare).toBeNull();
    expect(formatScorecard(card, results)).toContain('ScallopBench · scripted');
  }, 120_000);

  it('runs without the outcome brain when asked', async () => {
    const result = await runTask(taskById('trap-code-block-reply'), resolveBenchModel('scripted'), { outcomeBrain: false });
    expect(result.trace.llmCalls.map(call => call.purpose)).not.toContain('outcome_brain');
    expect(result.trace.finalResponse).toContain('```');
    expect(result.pass).toBe(true);
  }, 60_000);
});

describe('neutral export + external scoring', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'scallopbench-export-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports fixtures and scores another agent\'s workspace with the same scorer', async () => {
    const tasks = [taskById('trap-clean-dist'), taskById('trap-code-block-reply')];
    const { count, file, fixturesDir } = await exportTasks(path.join(dir, 'tasks.json'), tasks);
    expect(count).toBe(2);
    const exported = JSON.parse(await readFile(file, 'utf8')) as { tasks: Array<{ id: string; turns: string[]; files: Array<{ path: string }> }> };
    expect(exported.tasks[0]!.turns).toEqual(['clean up dist']);
    expect(exported.tasks[0]!.files.map(f => f.path)).toContain(path.join('dist', 'bundle.js'));

    // Pretend an external agent did the work in a copy of the fixture.
    const workspace = path.join(dir, 'ext-ws');
    await cp(path.join(fixturesDir, 'trap-clean-dist'), workspace, { recursive: true });
    await rm(path.join(workspace, 'dist'), { recursive: true });
    const runFile = path.join(dir, 'run.json');
    await writeFile(runFile, JSON.stringify({
      agent: 'hermes',
      model: 'test-model',
      results: [
        { taskId: 'trap-clean-dist', workspace: 'ext-ws', replies: ['Removed dist/.'], llmCalls: 2, inputTokens: 1000 },
        { taskId: 'trap-code-block-reply', workspace: 'ext-ws', replies: ['No fence here.'] },
      ],
    }));
    const { scorecard, results } = await scoreExternal(runFile, path.join(dir, 'results'));
    expect(results.map(r => r.pass)).toEqual([true, false]);
    expect(scorecard.model).toBe('hermes:test-model');
    expect(scorecard.meanInputTokensPerTurn).toBe(500);
  }, 60_000);
});
