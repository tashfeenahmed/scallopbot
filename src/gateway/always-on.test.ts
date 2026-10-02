import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { setupAlwaysOn, shutdownAlwaysOn, type AlwaysOnDeps } from './always-on.js';
import { wakeSession } from './wake.js';
import { enqueueInLane, resetAllLanes } from '../agent/command-queue.js';
import type { Skill } from '../skills/types.js';

afterEach(() => {
  shutdownAlwaysOn();
  resetAllLanes();
});

function deps(over: Partial<AlwaysOnDeps> = {}) {
  const sessions: Record<string, { metadata: { userId: string } }> = { s1: { metadata: { userId: 'telegram:1' } } };
  const base = {
    agent: { processMessage: vi.fn(async () => ({ response: 'beat reply', completionReason: 'natural_end' })) },
    sessionManager: { getSession: vi.fn(async (id: string) => sessions[id]) },
    db: {
      getSessionMessages: vi.fn(() => []),
      findSessionByUserId: vi.fn(() => ({ id: 's-current' })),
      createHeartbeat: vi.fn(),
      getHeartbeat: vi.fn(),
      listHeartbeats: vi.fn(() => []),
      deleteHeartbeat: vi.fn(),
      claimDueHeartbeats: vi.fn(() => []),
      recordHeartbeatOutcome: vi.fn(),
    },
    interruptQueue: { enqueue: vi.fn() },
    costTracker: { canMakeRequest: vi.fn(() => ({ allowed: true })) },
    boardService: null,
    deliver: vi.fn(async () => true),
    goalMaxTurns: 7,
    logger: pino({ level: 'silent' }),
    ...over,
  };
  return base as unknown as AlwaysOnDeps & typeof base;
}

describe('setupAlwaysOn', () => {
  it('registers goal_complete and heartbeat once and applies GOAL_MAX_TURNS', async () => {
    const registered: Skill[] = [];
    const d = deps({ costTracker: { canMakeRequest: () => ({ allowed: false }) } as never });
    const { goalMode } = setupAlwaysOn({ registerSkill: (s: Skill) => { registered.push(s); } }, d);
    expect(registered.map(s => s.name)).toEqual(['goal_complete', 'heartbeat']);
    const run = await goalMode.run('s1', 'x');
    expect(run.maxTurns).toBe(7);
  });

  it('installs the wake runtime: follow_up runs a turn and delivers to the session owner', async () => {
    const d = deps();
    setupAlwaysOn({ registerSkill: vi.fn() }, d);
    const res = await wakeSession('s1', '[heartbeat: hb_1] check', { kind: 'heartbeat' });
    expect(d.agent.processMessage).toHaveBeenCalledWith('s1', '[heartbeat: hb_1] check');
    expect(d.deliver).toHaveBeenCalledWith('telegram:1', 'beat reply');
    expect(res.outcome).toBe('completed');
  });

  it('steer goes into the interrupt queue while a turn holds the session lane', async () => {
    const d = deps();
    setupAlwaysOn({ registerSkill: vi.fn() }, d);
    let release!: () => void;
    const busy = enqueueInLane('session:s1', () => new Promise<void>(r => { release = r; }));
    const res = await wakeSession('s1', 'steer me', { kind: 'heartbeat', mode: 'steer' });
    expect(res.outcome).toBe('steered');
    expect(d.interruptQueue!.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', text: 'steer me' }));
    release();
    await busy;
  });

  it('follows the owner to their current session after /new', async () => {
    const d = deps();
    setupAlwaysOn({ registerSkill: vi.fn() }, d);
    const res = await wakeSession('closed', 'x', { kind: 'heartbeat', userId: 'telegram:1' });
    expect(res.sessionId).toBe('s-current');
    expect(d.db.findSessionByUserId).toHaveBeenCalledWith('telegram:1');
  });

  it('goal runs stop on budget exhaustion via CostTracker', async () => {
    const d = deps({ costTracker: { canMakeRequest: () => ({ allowed: false, reason: 'Daily budget exceeded' }) } as never });
    const { goalMode } = setupAlwaysOn({ registerSkill: vi.fn() }, d);
    const run = await goalMode.run('s1', 'x');
    expect(run).toMatchObject({ status: 'budget_exhausted', turns: 0 });
  });
});
