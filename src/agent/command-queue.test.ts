/**
 * Tests for Session Lane Serialization (Command Queue).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueInLane,
  clearLane,
  resetAllLanes,
  laneHasPending,
  laneQueueSize,
  setQueueLogger,
} from './command-queue.js';

beforeEach(() => {
  resetAllLanes();
});

describe('enqueueInLane', () => {
  it('executes a single task and returns its result', async () => {
    const result = await enqueueInLane('lane-a', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes tasks in the same lane', async () => {
    const order: number[] = [];

    const p1 = enqueueInLane('lane-a', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
      return 1;
    });

    const p2 = enqueueInLane('lane-a', async () => {
      order.push(2);
      return 2;
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('runs tasks in different lanes concurrently', async () => {
    const startTimes: Record<string, number> = {};

    const p1 = enqueueInLane('lane-a', async () => {
      startTimes.a = Date.now();
      await new Promise(r => setTimeout(r, 50));
    });

    const p2 = enqueueInLane('lane-b', async () => {
      startTimes.b = Date.now();
      await new Promise(r => setTimeout(r, 50));
    });

    await Promise.all([p1, p2]);
    // Both should have started nearly at the same time
    expect(Math.abs(startTimes.a - startTimes.b)).toBeLessThan(30);
  });

  it('propagates task errors', async () => {
    await expect(
      enqueueInLane('lane-a', async () => { throw new Error('task failed'); })
    ).rejects.toThrow('task failed');
  });

  it('continues draining after a failed task', async () => {
    const p1 = enqueueInLane('lane-a', async () => {
      throw new Error('first fails');
    }).catch(() => 'caught');

    const p2 = enqueueInLane('lane-a', async () => 'second ok');

    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(['caught', 'second ok']);
  });
});

describe('clearLane', () => {
  it('rejects pending tasks', async () => {
    // Start a slow task
    const p1 = enqueueInLane('lane-a', async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'done';
    });

    // Enqueue a second task
    const p2 = enqueueInLane('lane-a', async () => 'should not run');

    // Clear the lane
    clearLane('lane-a');

    // p2 should be rejected
    await expect(p2).rejects.toThrow('cleared');

    // p1 should still complete (already running)
    await expect(p1).resolves.toBe('done');
  });

  it('is a no-op for non-existent lanes', () => {
    expect(() => clearLane('nonexistent')).not.toThrow();
  });
});

describe('laneHasPending / laneQueueSize', () => {
  it('returns false/0 for empty lanes', () => {
    expect(laneHasPending('empty')).toBe(false);
    expect(laneQueueSize('empty')).toBe(0);
  });

  it('reflects queued tasks', async () => {
    // Start a blocking task
    let unblock: () => void;
    const blocker = new Promise<void>(r => { unblock = r; });

    const p1 = enqueueInLane('lane-a', () => blocker);
    enqueueInLane('lane-a', async () => 'queued').catch(() => {});

    // Give drain a tick
    await new Promise(r => setTimeout(r, 5));

    expect(laneHasPending('lane-a')).toBe(true);
    expect(laneQueueSize('lane-a')).toBe(1);

    // Unblock and clean up
    unblock!();
    clearLane('lane-a');
    await p1;
  });
});

describe('resetAllLanes', () => {
  it('rejects all pending tasks across all lanes', async () => {
    const p1 = enqueueInLane('lane-a', async () => {
      await new Promise(r => setTimeout(r, 100));
    });
    const p2 = enqueueInLane('lane-a', async () => 'pending').catch(e => e.message);
    const p3 = enqueueInLane('lane-b', async () => {
      await new Promise(r => setTimeout(r, 100));
    });
    const p4 = enqueueInLane('lane-b', async () => 'pending').catch(e => e.message);

    resetAllLanes();

    const results = await Promise.allSettled([p2, p4]);
    // Pending tasks should be rejected
    for (const r of results) {
      if (r.status === 'fulfilled' && typeof r.value === 'string') {
        expect(r.value).toContain('reset');
      }
    }
  });
});

describe('warnAfterMs logging', () => {
  it('logs warning when task waits too long', async () => {
    const warnings: string[] = [];
    setQueueLogger(msg => warnings.push(msg));

    // Block the lane
    let unblock: () => void;
    const blocker = new Promise<void>(r => { unblock = r; });
    const p1 = enqueueInLane('lane-a', () => blocker);

    // Enqueue with very short warn threshold
    const p2 = enqueueInLane('lane-a', async () => 'done', { warnAfterMs: 5 });

    // Wait a bit, then unblock
    await new Promise(r => setTimeout(r, 20));
    unblock!();

    await p1;
    await p2;

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain('waited');

    setQueueLogger(() => {}); // cleanup
  });
});
