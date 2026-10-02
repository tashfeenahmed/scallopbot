import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ScallopDatabase } from '../memory/db.js';
import {
  HeartbeatService,
  createHeartbeatSkill,
  heartbeatMessage,
  isHeartbeatQuiet,
  HEARTBEAT_OK,
  MAX_HEARTBEATS_PER_OWNER,
} from './heartbeats.js';
import type { WakeResult } from '../gateway/wake.js';
import type { SkillHandlerContext } from '../skills/types.js';

let dbPath: string;
let db: ScallopDatabase;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `scallopbot-heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new ScallopDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

function service(over: Partial<ConstructorParameters<typeof HeartbeatService>[0]> = {}) {
  let now = 1_000_000;
  const wake = vi.fn(async (sessionId: string): Promise<WakeResult> => ({ outcome: 'completed', sessionId, response: 'ok', delivered: true }));
  const svc = new HeartbeatService({ store: db, wake, now: () => now, ...over });
  return { svc, wake, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('HeartbeatService', () => {
  it('creates, lists and deletes heartbeats scoped to the owner', () => {
    const { svc } = service();
    const hb = svc.create({ sessionId: 's1', userId: 'telegram:1', instruction: 'check the deploy', intervalMinutes: 30 });
    expect(hb).toMatchObject({ sessionId: 's1', userId: 'telegram:1', intervalMinutes: 30, mode: 'follow_up', enabled: true });
    expect(svc.list({ userId: 'telegram:1' }).map(h => h.id)).toEqual([hb.id]);
    expect(svc.list({ sessionId: 's1' }).map(h => h.id)).toEqual([hb.id]);
    expect(svc.list({ userId: 'telegram:2', sessionId: 's9' })).toEqual([]);
    expect(svc.delete(hb.id, { userId: 'telegram:2', sessionId: 's9' })).toBe(false);
    expect(svc.delete(hb.id, { userId: 'telegram:1' })).toBe(true);
    expect(svc.list({ userId: 'telegram:1' })).toEqual([]);
  });

  it('validates input', () => {
    const { svc } = service();
    expect(() => svc.create({ sessionId: 's', instruction: '', intervalMinutes: 30 })).toThrow(/instruction/);
    expect(() => svc.create({ sessionId: 's', instruction: 'x', intervalMinutes: 1 })).toThrow(/interval_minutes/);
    expect(() => svc.create({ sessionId: 's', instruction: 'x', intervalMinutes: Number.NaN })).toThrow(/interval_minutes/);
    for (let i = 0; i < MAX_HEARTBEATS_PER_OWNER; i++) svc.create({ sessionId: 's', userId: 'u', instruction: `x${i}`, intervalMinutes: 10 });
    expect(() => svc.create({ sessionId: 's', userId: 'u', instruction: 'one more', intervalMinutes: 10 })).toThrow(/at most/);
  });

  it('fires only when due, with the [heartbeat: id] header, then reschedules', async () => {
    const { svc, wake, advance } = service();
    const hb = svc.create({ sessionId: 's1', userId: 'telegram:1', instruction: 'check inbox', intervalMinutes: 10, mode: 'steer' });
    expect(await svc.runDue()).toBe(0);
    advance(10 * 60_000);
    expect(await svc.runDue()).toBe(1);
    await svc.settle();
    expect(wake).toHaveBeenCalledWith('s1', heartbeatMessage(hb), expect.objectContaining({ kind: 'heartbeat', mode: 'steer', userId: 'telegram:1' }));
    expect((wake.mock.calls[0] as unknown[])[1]).toMatch(new RegExp(`^\\[heartbeat: ${hb.id}\\] check inbox`));
    expect(await svc.runDue()).toBe(0);
    const row = db.getHeartbeat(hb.id)!;
    expect(row).toMatchObject({ fireCount: 1, lastOutcome: 'delivered' });
    advance(10 * 60_000);
    expect(await svc.runDue()).toBe(1);
  });

  it('skips a beat while the previous one is still running', async () => {
    let release!: () => void;
    const wake = vi.fn(() => new Promise<WakeResult>(r => { release = () => r({ outcome: 'completed', sessionId: 's1', delivered: false }); }));
    const { svc, advance } = service({ wake });
    const hb = svc.create({ sessionId: 's1', instruction: 'x', intervalMinutes: 5 });
    advance(5 * 60_000);
    await svc.runDue();
    advance(5 * 60_000);
    expect(await svc.runDue()).toBe(0);
    expect(db.getHeartbeat(hb.id)!.lastOutcome).toBe('skipped_overlap');
    release();
    await svc.settle();
    expect(db.getHeartbeat(hb.id)!.lastOutcome).toBe('quiet');
  });

  it('skips beats while the budget is exhausted', async () => {
    const { svc, wake, advance } = service({ canSpend: () => ({ allowed: false, reason: 'Daily budget exceeded' }) });
    const hb = svc.create({ sessionId: 's1', instruction: 'x', intervalMinutes: 5 });
    advance(5 * 60_000);
    expect(await svc.runDue()).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(db.getHeartbeat(hb.id)).toMatchObject({ lastOutcome: 'skipped_budget', lastError: 'Daily budget exceeded' });
  });

  it('disables a heartbeat whose session cannot be woken, and follows a moved session', async () => {
    const wake = vi.fn()
      .mockResolvedValueOnce({ outcome: 'completed', sessionId: 's2', delivered: true })
      .mockResolvedValueOnce({ outcome: 'unavailable', error: 'session not found' });
    const { svc, advance } = service({ wake });
    const hb = svc.create({ sessionId: 's1', userId: 'u', instruction: 'x', intervalMinutes: 5 });
    advance(5 * 60_000);
    await svc.runDue();
    await svc.settle();
    expect(db.getHeartbeat(hb.id)!.sessionId).toBe('s2');
    advance(5 * 60_000);
    await svc.runDue();
    await svc.settle();
    expect(db.getHeartbeat(hb.id)).toMatchObject({ enabled: false, lastOutcome: 'unavailable' });
    expect(svc.list({ userId: 'u' })).toEqual([]);
  });

  it('claims are atomic: a second claim at the same instant gets nothing', () => {
    const { svc, advance, at } = service();
    svc.create({ sessionId: 's1', instruction: 'x', intervalMinutes: 5 });
    advance(5 * 60_000);
    expect(db.claimDueHeartbeats(at())).toHaveLength(1);
    expect(db.claimDueHeartbeats(at())).toHaveLength(0);
  });
});

describe('UnifiedScheduler integration', () => {
  it('dispatches heartbeats on its normal tick', async () => {
    const { UnifiedScheduler } = await import('./scheduler.js');
    const pino = (await import('pino')).default;
    const runDue = vi.fn(async () => 0);
    const scheduler = new UnifiedScheduler({
      db,
      logger: pino({ level: 'silent' }),
      onSendMessage: vi.fn(async () => true),
      heartbeats: { runDue },
    });
    await scheduler.evaluate();
    expect(runDue).toHaveBeenCalledTimes(1);
  });
});

describe('isHeartbeatQuiet', () => {
  it('matches the bare token only', () => {
    expect(isHeartbeatQuiet(HEARTBEAT_OK)).toBe(true);
    expect(isHeartbeatQuiet(` ${HEARTBEAT_OK}. `)).toBe(true);
    expect(isHeartbeatQuiet(`<think>nothing new</think>${HEARTBEAT_OK}`)).toBe(true);
    expect(isHeartbeatQuiet(`${HEARTBEAT_OK} but the build failed`)).toBe(false);
  });
});

describe('heartbeat tool', () => {
  const ctx = (args: Record<string, unknown>): SkillHandlerContext => ({ args, workspace: '/tmp', sessionId: 's1', userId: 'telegram:1' });

  it('create / list / delete through the native handler', async () => {
    const { svc } = service();
    const skill = createHeartbeatSkill(svc);
    expect(skill.name).toBe('heartbeat');
    const created = await skill.handler!(ctx({ action: 'create', instruction: 'ping the build', interval_minutes: 15, mode: 'follow_up' }));
    expect(created.success).toBe(true);
    const id = JSON.parse(created.output).created.id as string;
    const listed = await skill.handler!(ctx({ action: 'list' }));
    expect(JSON.parse(listed.output).heartbeats.map((h: { id: string }) => h.id)).toEqual([id]);
    expect((await skill.handler!(ctx({ action: 'delete', id }))).success).toBe(true);
    expect((await skill.handler!(ctx({ action: 'delete', id }))).success).toBe(false);
  });

  it('returns errors as tool failures', async () => {
    const { svc } = service();
    const skill = createHeartbeatSkill(svc);
    const bad = await skill.handler!(ctx({ action: 'create', instruction: 'x', interval_minutes: 1 }));
    expect(bad).toMatchObject({ success: false });
    expect(bad.error).toMatch(/interval_minutes/);
    expect((await skill.handler!(ctx({ action: 'nope' }))).success).toBe(false);
  });
});
