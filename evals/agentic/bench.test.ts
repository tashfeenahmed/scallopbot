/**
 * ScallopBench harness tests. No network: the scripted provider replays each
 * task's reference solution through the real Agent.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARELESS_SOLUTIONS } from './careless.js';
import { exportTasks, scoreExternal } from './external.js';
import { runTask } from './harness.js';
import { resolveBenchModel } from './providers.js';
import { buildScorecard, formatScorecard } from './scorecard.js';
import { scoreReference } from './selfcheck.js';
import { ALL_TASKS, HARD_TASKS, selectTasks } from './tasks/index.js';
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
    expect(selectTasks('hard').length).toBeGreaterThanOrEqual(15);
    for (const task of ALL_TASKS) expect(task.reference).toHaveLength(task.prompt.length);
    for (const task of HARD_TASKS) expect(task.timeoutMs, task.id).toBeGreaterThan(0);
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

  it.each(ALL_TASKS.map(task => [task.id, task] as const))(
    '%s: cross-agent scorer accepts the reference and rejects the untouched workspace',
    async (_id, task) => {
      const good = await scoreReference(task, { crossAgent: true });
      expect(good.pass, good.details).toBe(true);
      const untouched = await scoreReference(task, { applySteps: false, crossAgent: true });
      expect(untouched.pass, untouched.details).toBe(false);
    },
    60_000,
  );

  it('every hard task has at least one careless solution', () => {
    for (const task of HARD_TASKS) expect(CARELESS_SOLUTIONS.some(c => c.taskId === task.id), task.id).toBe(true);
  });

  it.each(CARELESS_SOLUTIONS.map(c => [`${c.taskId}: ${c.why}`, c] as const))(
    'hard scorer rejects a careless solution — %s',
    async (_label, careless) => {
      const result = await scoreReference({ ...taskById(careless.taskId), reference: careless.reference }, { crossAgent: true });
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

  it('replays every hard task through the real Agent in cross-agent mode', async () => {
    const model = resolveBenchModel('scripted');
    const results = await Promise.all(HARD_TASKS.map(task => runTask(task, model, { maxIterations: 20, crossAgent: true })));
    for (const result of results) {
      expect(result.error, result.taskId).toBeUndefined();
      expect(result.pass, `${result.taskId}: ${result.details}`).toBe(true);
      expect(result.efficiency?.llmCalls, result.taskId).toBeGreaterThan(0);
    }
    const facts = results.find(r => r.taskId === 'hard-config-facts')!;
    expect(facts.efficiency?.toolRounds).toBeGreaterThan(0);
    const card = buildScorecard('scripted', results, 'cross-agent');
    expect(card.byCategory.hard?.passed).toBe(HARD_TASKS.length);
    expect(formatScorecard(card, results)).toContain('cross-agent (outcome-only) scoring');
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

  it('cross-agent mode judges tool-trap tasks by outcome, not tool names', async () => {
    const out = path.join(dir, 'xagent', 'tasks.json');
    const { fixturesDir } = await exportTasks(out, [taskById('trap-rerun-tests'), taskById('trap-write-400-lines')]);
    // An agent with only `ipython` (Prime-style) does the work its own way.
    const rerun = path.join(dir, 'xagent', 'ws-rerun');
    await cp(path.join(fixturesDir, 'trap-rerun-tests'), rerun, { recursive: true });
    const sh = (command: string) => { try { execFileSync('bash', ['-c', command], { cwd: rerun, stdio: 'ignore' }); } catch { /* failing run */ } };
    sh('npm test > out.txt 2>&1');
    await writeFile(path.join(rerun, 'src/parity.js'), 'export const isEven = (n) => n % 2 === 0;\n');
    sh('npm test > out.txt 2>&1');
    const constants = path.join(dir, 'xagent', 'ws-constants');
    await cp(path.join(fixturesDir, 'trap-write-400-lines'), constants, { recursive: true });
    await writeFile(path.join(constants, 'constants.ts'), `${Array.from({ length: 400 }, (_, i) => `export const VALUE_${i + 1} = ${(i + 1) * 7};`).join('\n')}\n`);
    const runFile = path.join(dir, 'xagent', 'prime-run.json');
    await writeFile(runFile, JSON.stringify({
      agent: 'prime',
      model: 'test-model',
      results: [
        { taskId: 'trap-rerun-tests', workspace: 'ws-rerun', replies: ['Fixed isEven; out.txt shows the passing run.'], toolCalls: [{ name: 'ipython', input: { code: '!npm test > out.txt 2>&1' } }, { name: 'edit' }, { name: 'ipython' }] },
        { taskId: 'trap-write-400-lines', workspace: 'ws-constants', replies: ['Wrote constants.ts.'], toolCalls: [{ name: 'edit', input: { path: 'constants.ts' } }] },
      ],
    }));
    const strict = await scoreExternal(runFile, path.join(dir, 'results'));
    expect(strict.results.map(r => r.pass)).toEqual([false, false]);
    const fair = await scoreExternal(runFile, path.join(dir, 'results'), { crossAgent: true });
    expect(fair.results.map(r => r.pass), fair.results.map(r => r.details).join(' | ')).toEqual([true, true]);
    expect(fair.scorecard.scoring).toBe('cross-agent');
    expect(fair.results[0]!.efficiency).toMatchObject({ toolCalls: 3 });
  }, 60_000);

  it('exports hard tasks (git repo included) and scores them in cross-agent mode', async () => {
    const out = path.join(dir, 'hard', 'tasks.json');
    const { fixturesDir, file } = await exportTasks(out, [taskById('hard-git-branch'), taskById('hard-two-turn-correction')]);
    const exported = JSON.parse(await readFile(file, 'utf8')) as { tasks: Array<{ id: string; turns: string[]; git?: boolean; files: Array<{ path: string }> }> };
    const gitTask = exported.tasks.find(t => t.id === 'hard-git-branch')!;
    expect(gitTask.git).toBe(true);
    expect(gitTask.files.some(f => f.path.startsWith('.git/'))).toBe(false);
    expect(gitTask.files.map(f => f.path)).toContain('.gitignore');
    expect(existsSync(path.join(fixturesDir, 'hard-git-branch', '.git', 'HEAD'))).toBe(true);
    expect(exported.tasks.find(t => t.id === 'hard-two-turn-correction')!.turns).toHaveLength(2);

    const gitWs = path.join(dir, 'hard', 'ws-git');
    await cp(path.join(fixturesDir, 'hard-git-branch'), gitWs, { recursive: true });
    execFileSync('bash', ['-c', [
      'git checkout -q -b fix/rate-limit',
      "perl -pi -e 's/RATE_LIMIT = 100/RATE_LIMIT = 250/' src/config.js",
      "perl -0pi -e 's/## Unreleased\\n\\n/## Unreleased\\n\\n- Raise default rate limit to 250\\n/' CHANGELOG.md",
      'git add src/config.js CHANGELOG.md',
      "git commit -q -m 'Raise default rate limit to 250'",
    ].join(' && ')], { cwd: gitWs, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const turnsWs = path.join(dir, 'hard', 'ws-turns');
    await cp(path.join(fixturesDir, 'hard-two-turn-correction'), turnsWs, { recursive: true });
    await writeFile(path.join(turnsWs, 'totals.txt'), 'player\ttotal\nfatima\t73\ndara\t65\nbjorn\t60\nchen\t57\neli\t57\namara\t51\ngoran\t42\n');
    const runFile = path.join(dir, 'hard', 'openclaw-run.json');
    await writeFile(runFile, JSON.stringify({
      agent: 'openclaw',
      model: 'test-model',
      results: [
        { taskId: 'hard-git-branch', workspace: 'ws-git', replies: ['Committed on fix/rate-limit.'] },
        { taskId: 'hard-two-turn-correction', workspace: 'ws-turns', replies: ['Wrote totals.txt.', 'Switched to tabs, sorted by total.'] },
      ],
    }));
    const { results, scorecard } = await scoreExternal(runFile, path.join(dir, 'results'), { crossAgent: true });
    expect(results.map(r => r.pass), results.map(r => r.details).join(' | ')).toEqual([true, true]);
    expect(scorecard.byCategory.hard?.passed).toBe(2);
    expect(results[1]!.trace.turns).toHaveLength(2);
  }, 60_000);
});
