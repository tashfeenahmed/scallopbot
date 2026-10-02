import { describe, it, expect, vi } from 'vitest';
import {
  GoalModeController,
  GoalAlreadyRunningError,
  GOAL_CONTINUATION_MESSAGE,
  goalStartMessage,
  createGoalCompleteSkill,
  createSessionProgressProbe,
  boardGoalLink,
  formatGoalOutcome,
  formatGoalStatus,
  parseGoalCommand,
  throttledGoalProgress,
  type GoalProgressProbe,
  type GoalTurnResult,
} from './goal-mode.js';
import type { SessionMessageRow } from '../memory/db.js';

/** Probe driven by a per-turn script of successful tool-call counts. */
function scriptedProbe(perTurn: number[]): GoalProgressProbe {
  let turn = 0;
  return {
    snapshot: () => turn,
    measure: () => ({ successfulToolCalls: perTurn[turn++] ?? 0 }),
  };
}

function controller(opts: {
  turns?: (msg: string, i: number, ctl: GoalModeController) => GoalTurnResult | Promise<GoalTurnResult>;
  progress?: number[];
  maxTurns?: number;
  canSpend?: () => { allowed: boolean; reason?: string };
}) {
  const messages: string[] = [];
  const sleeps: number[] = [];
  // eslint-disable-next-line prefer-const
  let ctl: GoalModeController;
  const runTurn = vi.fn(async (_s: string, message: string) => {
    messages.push(message);
    return opts.turns ? opts.turns(message, messages.length - 1, ctl) : { response: `turn ${messages.length}` };
  });
  ctl = new GoalModeController({
    runTurn,
    probe: scriptedProbe(opts.progress ?? Array(100).fill(1)),
    canSpend: opts.canSpend,
    maxTurns: opts.maxTurns,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { ctl, runTurn, messages, sleeps };
}

describe('GoalModeController', () => {
  it('starts with [goal: start] and continues with the continuation prompt until goal_complete', async () => {
    const { ctl, messages } = controller({
      turns: (_m, i, c) => {
        if (i === 2) c.complete('s1', 'All done', ['tests pass']);
        return { response: `r${i}` };
      },
    });
    const run = await ctl.run('s1', 'ship the feature');
    expect(messages[0]).toBe(goalStartMessage('ship the feature'));
    expect(messages.slice(1)).toEqual([GOAL_CONTINUATION_MESSAGE, GOAL_CONTINUATION_MESSAGE]);
    expect(run).toMatchObject({ status: 'completed', turns: 3, summary: 'All done', evidence: ['tests pass'] });
    expect(ctl.isRunning('s1')).toBe(false);
    expect(ctl.status('s1')?.status).toBe('completed');
  });

  it('the continuation text demands an audit and forbids budget-driven completion', () => {
    expect(GOAL_CONTINUATION_MESSAGE).toMatch(/^\[goal: continuation\]/);
    expect(GOAL_CONTINUATION_MESSAGE).toContain('Audit every requirement before completing');
    expect(GOAL_CONTINUATION_MESSAGE).toContain('never complete because the budget is low');
    expect(GOAL_CONTINUATION_MESSAGE).toContain('goal_complete');
  });

  it('stops after 3 no-progress turns in a row, backing off exponentially', async () => {
    const { ctl, sleeps } = controller({ progress: [1, 0, 0, 0, 1] });
    const run = await ctl.run('s1', 'x');
    expect(run).toMatchObject({ status: 'no_progress', turns: 4 });
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it('progress resets the streak', async () => {
    const { ctl } = controller({ progress: [0, 0, 1, 0, 0, 1, 0, 0, 0], maxTurns: 30 });
    const run = await ctl.run('s1', 'x');
    expect(run).toMatchObject({ status: 'no_progress', turns: 9 });
  });

  it('stops at the max-turns cap', async () => {
    const { ctl, runTurn } = controller({ maxTurns: 4 });
    const run = await ctl.run('s1', 'x');
    expect(run).toMatchObject({ status: 'max_turns', turns: 4 });
    expect(runTurn).toHaveBeenCalledTimes(4);
  });

  it('stops when the budget is exhausted, before spending more', async () => {
    let calls = 0;
    const { ctl, runTurn } = controller({ canSpend: () => ({ allowed: ++calls <= 2, reason: 'Daily budget exceeded' }) });
    const run = await ctl.run('s1', 'x');
    expect(run).toMatchObject({ status: 'budget_exhausted', turns: 2, stopReason: 'Daily budget exceeded' });
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it('/goal stop ends the run and the turn sees shouldStop', async () => {
    let seenStop = false;
    const runTurn = vi.fn(async (_s: string, _m: string, shouldStop: () => boolean) => {
      ctl.stop('s1');
      seenStop = shouldStop();
      return { response: 'partial', completionReason: 'stopped' };
    });
    const ctl = new GoalModeController({ runTurn, probe: scriptedProbe([1]), sleep: async () => {} });
    const run = await ctl.run('s1', 'x');
    expect(seenStop).toBe(true);
    expect(run).toMatchObject({ status: 'stopped', turns: 1 });
  });

  it("the channel's /stop flag stops the run", async () => {
    let stop = false;
    const { ctl } = controller({ turns: (_m, i) => { if (i === 1) stop = true; return { response: 'r' }; } });
    const run = await ctl.run('s1', 'x', { shouldStop: () => stop });
    expect(run).toMatchObject({ status: 'stopped', turns: 2 });
  });

  it('refuses a second concurrent goal on the same session', async () => {
    let release!: () => void;
    const runTurn = vi.fn(() => new Promise<GoalTurnResult>(r => { release = () => r({ response: 'r' }); }));
    const ctl = new GoalModeController({ runTurn, probe: scriptedProbe([1]), maxTurns: 1, sleep: async () => {} });
    const first = ctl.run('s1', 'a');
    await Promise.resolve();
    await expect(ctl.run('s1', 'b')).rejects.toBeInstanceOf(GoalAlreadyRunningError);
    expect(formatGoalStatus(ctl.status('s1'))).toMatch(/Goal running: a/);
    release();
    await first;
  });

  it('turn errors end the run as failed', async () => {
    const { ctl } = controller({ turns: () => { throw new Error('provider down'); } });
    expect(await ctl.run('s1', 'x')).toMatchObject({ status: 'failed', stopReason: 'provider down', turns: 0 });
  });

  it('calls onTurn for intermediate turns only', async () => {
    const onTurn = vi.fn();
    const { ctl } = controller({ turns: (_m, i, c) => { if (i === 1) c.complete('s1', 'ok', ['e']); return { response: `r${i}` }; } });
    await ctl.run('s1', 'x', { onTurn });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn.mock.calls[0][1]).toBe('r0');
  });

  it('records the run on the board', async () => {
    const board = { createItem: vi.fn(() => ({ id: 'item1' })), markDone: vi.fn(), moveItem: vi.fn() };
    const link = boardGoalLink(board as never);

    const unfinished = new GoalModeController({ runTurn: vi.fn(async () => ({ response: 'r' })), probe: scriptedProbe([1]), board: link, maxTurns: 1, sleep: async () => {} });
    const run = await unfinished.run('s1', 'objective', { userId: 'telegram:1' });
    expect(board.createItem).toHaveBeenCalledWith('telegram:1', expect.objectContaining({ title: 'Goal: objective', boardStatus: 'in_progress', labels: ['goal'], source: 'agent' }));
    expect(run).toMatchObject({ status: 'max_turns', boardItemId: 'item1' });
    expect(board.moveItem).toHaveBeenCalledWith('item1', 'waiting');

    const finished: GoalModeController = new GoalModeController({
      runTurn: vi.fn(async () => { finished.complete('s2', 'did it', ['ok']); return { response: 'r' }; }),
      probe: scriptedProbe([1]),
      board: link,
      sleep: async () => {},
    });
    await finished.run('s2', 'objective 2');
    expect(board.markDone).toHaveBeenCalledWith('item1', 'did it');
  });
});

describe('goal_complete tool', () => {
  const ctx = (args: Record<string, unknown>) => ({ args, workspace: '/tmp', sessionId: 's1' });

  it('fails when no goal is running', async () => {
    const skill = createGoalCompleteSkill(new GoalModeController({ runTurn: vi.fn(), probe: scriptedProbe([]) }));
    const res = await skill.handler!(ctx({ summary: 'x', evidence: ['y'] }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No goal is running/);
  });

  it('requires a summary and evidence, then completes the run', async () => {
    const complete = vi.fn(() => ({ id: 'g' }) as never);
    const skill = createGoalCompleteSkill({ complete });
    expect(skill.name).toBe('goal_complete');
    expect((await skill.handler!(ctx({ summary: '', evidence: ['y'] }))).success).toBe(false);
    expect((await skill.handler!(ctx({ summary: 'x', evidence: [] }))).success).toBe(false);
    const ok = await skill.handler!(ctx({ summary: 'done', evidence: 'ran the tests' }));
    expect(ok.success).toBe(true);
    expect(complete).toHaveBeenCalledWith('s1', 'done', ['ran the tests']);
  });
});

describe('createSessionProgressProbe', () => {
  const row = (id: number, content: unknown): SessionMessageRow => ({
    id,
    sessionId: 's1',
    role: 'user',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    messageKind: 'tool_result',
    createdAt: id,
  });

  it('counts non-error tool results written after the snapshot', () => {
    const rows: SessionMessageRow[] = [row(1, 'hello')];
    const probe = createSessionProgressProbe({ getSessionMessages: () => rows });
    const snap = probe.snapshot('s1');
    expect(snap).toBe(1);
    rows.push(
      row(2, [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'tool_result', tool_use_id: 'b', content: 'boom', is_error: true }]),
      row(3, [{ type: 'tool_result', tool_use_id: 'c', content: '[TOOL_ERROR code=X] nope' }]),
      row(4, [{ type: 'tool_result', tool_use_id: 'd', content: 'written' }]),
    );
    expect(probe.measure('s1', snap)).toEqual({ successfulToolCalls: 2 });
    expect(probe.measure('s1', 4)).toEqual({ successfulToolCalls: 0 });
  });
});

describe('formatting and parsing', () => {
  it('parseGoalCommand', () => {
    expect(parseGoalCommand('')).toEqual({ action: 'help' });
    expect(parseGoalCommand('status')).toEqual({ action: 'status' });
    expect(parseGoalCommand(' STOP ')).toEqual({ action: 'stop' });
    expect(parseGoalCommand('fix the flaky test')).toEqual({ action: 'start', objective: 'fix the flaky test' });
  });

  it('formatGoalOutcome is honest about unfinished runs', () => {
    const base = { id: 'g', sessionId: 's', objective: 'ship it', turns: 3, maxTurns: 30, noProgressStreak: 0, startedAt: 0 };
    expect(formatGoalOutcome({ ...base, status: 'completed', summary: 'Shipped', evidence: ['CI green'] })).toBe(
      'Goal complete after 3 turns: ship it\n\nShipped\n\nEvidence:\n- CI green',
    );
    const stopped = formatGoalOutcome({ ...base, status: 'no_progress', stopReason: '3 turns in a row without progress', lastResponse: 'stuck on auth' });
    expect(stopped).toContain('It is not marked complete');
    expect(stopped).toContain('stuck on auth');
  });

  it('throttledGoalProgress sends the first reply, then at most one per interval', async () => {
    let t = 0;
    const send = vi.fn(async () => {});
    const progress = throttledGoalProgress(send, 1000, () => t);
    const run = (turns: number) => ({ id: 'g', sessionId: 's', objective: 'o', status: 'running' as const, turns, maxTurns: 30, noProgressStreak: 0, startedAt: 0 });
    await progress(run(1), 'plan');
    t = 500; await progress(run(2), 'two');
    t = 1200; await progress(run(3), 'three');
    expect(send.mock.calls.map(c => (c as unknown[])[0])).toEqual(['plan', 'Goal progress (turn 3/30):\nthree']);
  });
});
