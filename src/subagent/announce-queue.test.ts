import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { AnnounceQueue } from './announce-queue.js';

const logger = pino({ level: 'silent' });

describe('AnnounceQueue idempotency', () => {
  it('delivers a run result once even when completion is enqueued repeatedly', () => {
    const queue = new AnnounceQueue({ logger });
    const entry = {
      runId: 'run-1',
      parentSessionId: 'parent-1',
      label: 'worker',
      result: { response: 'done', iterationsUsed: 1, taskComplete: true },
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
      timestamp: 1,
    };

    queue.enqueue(entry);
    queue.enqueue({ ...entry, timestamp: 2 });
    expect(queue.pendingCount('parent-1')).toBe(1);
    expect(queue.drain('parent-1')).toHaveLength(1);

    // The idempotency record survives draining, preventing a late callback
    // from repeating the already-delivered result.
    queue.enqueue({ ...entry, timestamp: 3 });
    expect(queue.pendingCount('parent-1')).toBe(0);
  });
});
