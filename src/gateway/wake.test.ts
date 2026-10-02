import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionWaker, setSessionWaker, wakeSession, type WakeTurnRequest } from './wake.js';
import { enqueueInLane, laneIsBusy } from '../agent/command-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => setSessionWaker(null));

describe('SessionWaker', () => {
  it('starts a turn immediately when the session is idle', async () => {
    const turns: WakeTurnRequest[] = [];
    const waker = new SessionWaker({ isBusy: () => false, runTurn: async r => { turns.push(r); }, pollMs: 10 });
    expect(waker.wake('s1', '[agent-result: a] (self-report — verify before relying on it)\nok', { kind: 'agent-result' })).toBe('started');
    await waker.idle('s1');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ sessionId: 's1', kinds: ['agent-result'] });
    expect(turns[0].message).toContain('[agent-result: a]');
  });

  it('queues while the session is busy and wakes once it goes idle', async () => {
    let busy = true;
    const turns: WakeTurnRequest[] = [];
    const waker = new SessionWaker({ isBusy: () => busy, runTurn: async r => { turns.push(r); }, pollMs: 10 });
    expect(waker.wake('s2', 'm1', { kind: 'agent-result' })).toBe('queued');
    await new Promise(r => setTimeout(r, 40));
    expect(turns).toHaveLength(0);
    busy = false;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].message).toBe('m1');
  });

  it('drops a message the running turn already consumed (no duplicate wake)', async () => {
    let busy = true;
    let consumed = false;
    const runTurn = vi.fn(async () => undefined);
    const waker = new SessionWaker({ isBusy: () => busy, runTurn, pollMs: 10 });
    waker.wake('s3', 'm1', { kind: 'agent-result', isPending: () => !consumed });
    consumed = true; // agent.ts drained the announce queue mid-turn
    busy = false;
    await new Promise(r => setTimeout(r, 50));
    expect(runTurn).not.toHaveBeenCalled();
    expect(waker.pendingCount('s3')).toBe(0);
  });

  it('never runs two wake turns at once; completions during a turn are batched into the next one', async () => {
    const gate = deferred();
    let concurrent = 0;
    let maxConcurrent = 0;
    const turns: WakeTurnRequest[] = [];
    const claims: string[] = [];
    const waker = new SessionWaker({
      isBusy: () => false,
      pollMs: 10,
      runTurn: async r => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        turns.push(r);
        if (turns.length === 1) await gate.promise;
        concurrent--;
      },
    });
    expect(waker.wake('s4', 'first', { kind: 'agent-result', claim: () => claims.push('first') })).toBe('started');
    expect(waker.wake('s4', 'second', { kind: 'agent-exited', claim: () => claims.push('second') })).toBe('queued');
    expect(waker.wake('s4', 'third', { kind: 'bash-done', claim: () => claims.push('third') })).toBe('queued');
    gate.resolve();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    await waker.idle('s4');
    expect(maxConcurrent).toBe(1);
    expect(turns[1].message).toBe('second\n\nthird');
    expect(turns[1].kinds).toEqual(['agent-exited', 'bash-done']);
    expect(claims).toEqual(['first', 'second', 'third']);
  });

  it('keeps going after a failed wake turn', async () => {
    const turns: string[] = [];
    const waker = new SessionWaker({
      isBusy: () => false,
      pollMs: 10,
      runTurn: async r => { turns.push(r.message); if (r.message === 'boom') throw new Error('provider down'); },
    });
    waker.wake('s5', 'boom', { kind: 'agent-result' });
    await waker.idle('s5');
    waker.wake('s5', 'next', { kind: 'agent-result' });
    await waker.idle('s5');
    expect(turns).toEqual(['boom', 'next']);
  });

  it('treats a running session lane as busy (user turn in progress)', async () => {
    const userTurn = deferred();
    const lane = 'session:s6';
    const inFlight = enqueueInLane(lane, () => userTurn.promise);
    const turns: string[] = [];
    const waker = new SessionWaker({ isBusy: id => laneIsBusy(`session:${id}`), runTurn: async r => { turns.push(r.message); }, pollMs: 10 });
    expect(waker.wake('s6', 'result', { kind: 'agent-result' })).toBe('queued');
    await new Promise(r => setTimeout(r, 30));
    expect(turns).toEqual([]);
    userTurn.resolve();
    await inFlight;
    await vi.waitFor(() => expect(turns).toEqual(['result']));
  });

  it('module-level wakeSession forwards to the installed waker', async () => {
    expect(wakeSession('s7', 'x', { kind: 'bash-done' })).toBe('unavailable');
    const runTurn = vi.fn(async () => undefined);
    setSessionWaker(new SessionWaker({ isBusy: () => false, runTurn }));
    expect(wakeSession('s7', '[bash-done 42 exit=0]', { kind: 'bash-done' })).toBe('started');
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledWith({ sessionId: 's7', message: '[bash-done 42 exit=0]', kinds: ['bash-done'] }));
  });
});
