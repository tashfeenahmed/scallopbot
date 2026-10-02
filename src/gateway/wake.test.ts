import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureWake, wakeSession, type WakeRuntime } from './wake.js';

function runtime(over: Partial<WakeRuntime> = {}): WakeRuntime & { [K in keyof WakeRuntime]: ReturnType<typeof vi.fn> } {
  return {
    resolveSession: vi.fn(async (sessionId: string) => ({ sessionId, userId: 'telegram:1' })),
    isBusy: vi.fn(() => false),
    steer: vi.fn(),
    runTurn: vi.fn(async () => ({ response: 'done' })),
    deliver: vi.fn(async () => true),
    ...over,
  } as never;
}

afterEach(() => configureWake(null));

describe('wakeSession', () => {
  it('is unavailable until the gateway configures it', async () => {
    expect((await wakeSession('s1', 'x', { kind: 'test' })).outcome).toBe('unavailable');
  });

  it('follow_up runs a turn and delivers the reply to the session owner', async () => {
    const rt = runtime();
    configureWake(rt);
    const res = await wakeSession('s1', '[heartbeat: hb_1] check', { kind: 'heartbeat' });
    expect(rt.runTurn).toHaveBeenCalledWith('s1', '[heartbeat: hb_1] check');
    expect(rt.deliver).toHaveBeenCalledWith('telegram:1', 'done');
    expect(res).toMatchObject({ outcome: 'completed', delivered: true, sessionId: 's1' });
  });

  it('follow_up runs a turn even when the session is busy (the session lane serialises it)', async () => {
    const rt = runtime({ isBusy: vi.fn(() => true) });
    configureWake(rt);
    await wakeSession('s1', 'x', { kind: 'heartbeat', mode: 'follow_up' });
    expect(rt.steer).not.toHaveBeenCalled();
    expect(rt.runTurn).toHaveBeenCalled();
  });

  it('steer injects into a running turn', async () => {
    const rt = runtime({ isBusy: vi.fn(() => true) });
    configureWake(rt);
    const res = await wakeSession('s1', 'x', { kind: 'heartbeat', mode: 'steer' });
    expect(rt.steer).toHaveBeenCalledWith('s1', 'x');
    expect(rt.runTurn).not.toHaveBeenCalled();
    expect(res.outcome).toBe('steered');
  });

  it('steer with no running turn behaves like follow_up', async () => {
    const rt = runtime();
    configureWake(rt);
    expect((await wakeSession('s1', 'x', { kind: 'heartbeat', mode: 'steer' })).outcome).toBe('completed');
    expect(rt.runTurn).toHaveBeenCalled();
  });

  it('quiet replies are not delivered', async () => {
    const rt = runtime({ runTurn: vi.fn(async () => ({ response: 'HEARTBEAT_OK' })) });
    configureWake(rt);
    const res = await wakeSession('s1', 'x', { kind: 'heartbeat', isQuiet: r => r === 'HEARTBEAT_OK' });
    expect(rt.deliver).not.toHaveBeenCalled();
    expect(res.delivered).toBe(false);
  });

  it('reports the session it actually used and turn failures', async () => {
    const rt = runtime({
      resolveSession: vi.fn(async () => ({ sessionId: 's2', userId: 'telegram:1' })),
      runTurn: vi.fn(async () => { throw new Error('boom'); }),
    });
    configureWake(rt);
    expect(await wakeSession('s1', 'x', { kind: 'k' })).toMatchObject({ outcome: 'failed', sessionId: 's2', error: 'boom' });
  });

  it('missing sessions are unavailable', async () => {
    configureWake(runtime({ resolveSession: vi.fn(async () => null) }));
    expect((await wakeSession('gone', 'x', { kind: 'k' })).outcome).toBe('unavailable');
  });
});
