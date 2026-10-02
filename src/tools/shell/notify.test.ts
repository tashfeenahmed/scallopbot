import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createBashDoneRouter, type BashDoneRouterDeps } from './notify.js';
import { BackgroundProcessManager, type BackgroundExitEvent } from './process-manager.js';
import { InterruptQueue } from '../../agent/interrupt-queue.js';
import { enqueueInLane, laneIsBusy } from '../../agent/command-queue.js';

const event = (over: Partial<BackgroundExitEvent> = {}): BackgroundExitEvent => ({
  sessionId: 'sess', userId: 'telegram:1', id: 7, pid: 4242, exitCode: 0,
  command: 'npm run build', tail: 'built in 3s', runtimeMs: 3000, log: '/tmp/x.txt', ...over,
});

function fakes(over: Partial<BashDoneRouterDeps> = {}) {
  const calls: string[] = [];
  const deps: BashDoneRouterDeps = {
    isBusy: () => false,
    enqueueSteering: vi.fn((_s, t) => { calls.push(`steer:${t.split('\n')[0]}`); }),
    waitForIdle: vi.fn(async () => {}),
    takeSteering: vi.fn(() => false),
    runTurn: vi.fn(async (_s, t) => { calls.push(`turn:${t.split('\n')[0]}`); return 'The build passed.'; }),
    deliver: vi.fn(async (u, t) => { calls.push(`deliver:${u}:${t}`); return true; }),
    isSubAgentSession: vi.fn(async () => false),
    ...over,
  };
  return { deps, calls };
}

describe('bash-done routing', () => {
  it('idle session: starts a new turn with the notice and delivers the reply', async () => {
    const { deps, calls } = fakes();
    await createBashDoneRouter(deps)(event());
    expect(calls).toEqual([
      'turn:[bash-done id:7 pid:4242 exit:0] npm run build',
      'deliver:telegram:1:The build passed.',
    ]);
    expect(vi.mocked(deps.runTurn).mock.calls[0][1]).toBe('[bash-done id:7 pid:4242 exit:0] npm run build\nbuilt in 3s');
  });

  it('busy session: queues a steering message the running turn picks up', async () => {
    const { deps, calls } = fakes({ isBusy: () => true, takeSteering: () => false });
    await createBashDoneRouter(deps)(event({ exitCode: 1 }));
    expect(calls).toEqual(['steer:[bash-done id:7 pid:4242 exit:1] npm run build']);
    expect(deps.runTurn).not.toHaveBeenCalled();
  });

  it('busy session whose turn ended without draining: runs it as a new turn', async () => {
    const { deps, calls } = fakes({ isBusy: () => true, takeSteering: () => true });
    await createBashDoneRouter(deps)(event());
    expect(calls[0]).toMatch(/^steer:/);
    expect(calls[1]).toMatch(/^turn:/);
    expect(calls[2]).toMatch(/^deliver:/);
  });

  it('idle sub-agent sessions are not woken', async () => {
    const { deps } = fakes({ isSubAgentSession: async () => true });
    await createBashDoneRouter(deps)(event());
    expect(deps.runTurn).not.toHaveBeenCalled();
  });

  it('empty replies and missing users are not delivered; failures are contained', async () => {
    const empty = fakes({ runTurn: async () => '  ' });
    await createBashDoneRouter(empty.deps)(event());
    expect(empty.deps.deliver).not.toHaveBeenCalled();

    const noUser = fakes();
    await createBashDoneRouter(noUser.deps)(event({ userId: undefined }));
    expect(noUser.deps.deliver).not.toHaveBeenCalled();

    const boom = fakes({ runTurn: async () => { throw new Error('Session not found'); } });
    await expect(createBashDoneRouter(boom.deps)(event())).resolves.toBeUndefined();
  });

  it('end to end with the real lane + InterruptQueue (gateway wiring shape)', async () => {
    const logger = pino({ level: 'silent' });
    const queue = new InterruptQueue({ logger });
    const sessionId = `e2e-${Date.now()}`;
    const lane = `session:${sessionId}`;
    const turns: string[] = [];
    const delivered: string[] = [];
    const deps: BashDoneRouterDeps = {
      isBusy: (s) => laneIsBusy(`session:${s}`),
      enqueueSteering: (s, text) => queue.enqueue({ sessionId: s, text, timestamp: Date.now() }),
      waitForIdle: (s) => enqueueInLane(`session:${s}`, async () => {}),
      takeSteering: (s, text) => {
        const pending = queue.drain(s);
        const i = pending.findIndex(p => p.text === text);
        pending.forEach((p, j) => { if (j !== i) queue.enqueue(p); });
        return i >= 0;
      },
      runTurn: (s, text) => enqueueInLane(`session:${s}`, async () => { turns.push(text); return 'ok'; }),
      deliver: async (_u, text) => { delivered.push(text); },
    };
    const route = createBashDoneRouter(deps);

    // A turn is running and drains the interrupt queue mid-way.
    let release!: () => void;
    const running = enqueueInLane(lane, () => new Promise<void>(r => { release = r; }));
    const manager = new BackgroundProcessManager();
    const done = new Promise<void>(resolve => {
      manager.on('exit', (e: BackgroundExitEvent) => { void route({ ...e, sessionId }).then(resolve); });
    });
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'notify-'));
    manager.start({
      command: 'echo hi', program: 'bash', args: ['-c', 'echo hi'], cwd: dir, env: process.env,
      sessionId, userId: 'telegram:1', logPath: join(dir, 'log.txt'), background: true,
    });
    await new Promise(r => setTimeout(r, 150));
    expect(queue.pendingCount(sessionId)).toBe(1);
    // The running turn drains it (as agent.ts does each iteration) and ends.
    const drained = queue.drain(sessionId);
    expect(drained[0].text).toMatch(/^\[bash-done id:\d+ pid:\d+ exit:0\] echo hi\nhi$/);
    release();
    await running;
    await done;
    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);

    // Idle now: the next notice starts a turn and delivers its reply.
    await route({ ...event(), sessionId });
    expect(turns).toHaveLength(1);
    expect(delivered).toEqual(['ok']);
  });
});
