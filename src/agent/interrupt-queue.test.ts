import { describe, it, expect, beforeEach } from 'vitest';
import { InterruptQueue } from './interrupt-queue.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('InterruptQueue', () => {
  let queue: InterruptQueue;

  beforeEach(() => {
    queue = new InterruptQueue({ logger });
  });

  it('enqueue + drain basic FIFO', () => {
    queue.enqueue({ sessionId: 's1', text: 'first', timestamp: 1 });
    queue.enqueue({ sessionId: 's1', text: 'second', timestamp: 2 });

    const entries = queue.drain('s1');
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('first');
    expect(entries[1].text).toBe('second');
  });

  it('hasPending returns true when entries exist', () => {
    expect(queue.hasPending('s1')).toBe(false);
    queue.enqueue({ sessionId: 's1', text: 'msg', timestamp: 1 });
    expect(queue.hasPending('s1')).toBe(true);
  });

  it('pendingCount returns correct count', () => {
    expect(queue.pendingCount('s1')).toBe(0);
    queue.enqueue({ sessionId: 's1', text: 'a', timestamp: 1 });
    queue.enqueue({ sessionId: 's1', text: 'b', timestamp: 2 });
    expect(queue.pendingCount('s1')).toBe(2);
  });

  it('drain clears queue', () => {
    queue.enqueue({ sessionId: 's1', text: 'msg', timestamp: 1 });
    queue.drain('s1');
    expect(queue.hasPending('s1')).toBe(false);
    expect(queue.pendingCount('s1')).toBe(0);
    expect(queue.drain('s1')).toHaveLength(0);
  });

  it('drain returns empty array for unknown session', () => {
    expect(queue.drain('nonexistent')).toHaveLength(0);
  });

  it('overflow drops oldest', () => {
    const small = new InterruptQueue({ maxQueueSize: 3, logger });

    small.enqueue({ sessionId: 's1', text: 'a', timestamp: 1 });
    small.enqueue({ sessionId: 's1', text: 'b', timestamp: 2 });
    small.enqueue({ sessionId: 's1', text: 'c', timestamp: 3 });
    // Queue is full — next enqueue drops 'a'
    small.enqueue({ sessionId: 's1', text: 'd', timestamp: 4 });

    const entries = small.drain('s1');
    expect(entries).toHaveLength(3);
    expect(entries[0].text).toBe('b');
    expect(entries[1].text).toBe('c');
    expect(entries[2].text).toBe('d');
  });

  it('clear removes all entries for sessionId', () => {
    queue.enqueue({ sessionId: 's1', text: 'a', timestamp: 1 });
    queue.enqueue({ sessionId: 's1', text: 'b', timestamp: 2 });
    queue.clear('s1');
    expect(queue.hasPending('s1')).toBe(false);
    expect(queue.drain('s1')).toHaveLength(0);
  });

  it('independent queues per sessionId', () => {
    queue.enqueue({ sessionId: 's1', text: 'for-s1', timestamp: 1 });
    queue.enqueue({ sessionId: 's2', text: 'for-s2', timestamp: 2 });

    expect(queue.pendingCount('s1')).toBe(1);
    expect(queue.pendingCount('s2')).toBe(1);

    const s1 = queue.drain('s1');
    expect(s1).toHaveLength(1);
    expect(s1[0].text).toBe('for-s1');

    // s2 is unaffected
    expect(queue.hasPending('s2')).toBe(true);
    const s2 = queue.drain('s2');
    expect(s2).toHaveLength(1);
    expect(s2[0].text).toBe('for-s2');
  });

  it('clear only affects target session', () => {
    queue.enqueue({ sessionId: 's1', text: 'a', timestamp: 1 });
    queue.enqueue({ sessionId: 's2', text: 'b', timestamp: 2 });
    queue.clear('s1');

    expect(queue.hasPending('s1')).toBe(false);
    expect(queue.hasPending('s2')).toBe(true);
  });
});
