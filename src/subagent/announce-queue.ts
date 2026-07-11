/**
 * AnnounceQueue — FIFO queue per parent session for sub-agent results.
 *
 * Drained at the start of each parent iteration to inject completed
 * sub-agent results into the parent conversation.
 */

import type { Logger } from 'pino';
import type { AnnounceEntry } from './types.js';

export interface AnnounceQueueOptions {
  maxQueueSize?: number;
  logger: Logger;
}

export class AnnounceQueue {
  private queues: Map<string, AnnounceEntry[]> = new Map();
  private maxQueueSize: number;
  private logger: Logger;
  /** Idempotency guard: a run result is announced at most once per process. */
  private seenRunIds: Map<string, number> = new Map();

  constructor(options: AnnounceQueueOptions) {
    this.maxQueueSize = options.maxQueueSize ?? 20;
    this.logger = options.logger.child({ module: 'announce-queue' });
  }

  /**
   * Enqueue a completed sub-agent result for the parent session.
   * Drops oldest entry on overflow.
   */
  enqueue(entry: AnnounceEntry): void {
    const { parentSessionId } = entry;
    const dedupeKey = `${parentSessionId}:${entry.runId}`;
    if (this.seenRunIds.has(dedupeKey)) {
      this.logger.debug({ parentSessionId, runId: entry.runId }, 'Duplicate sub-agent announcement suppressed');
      return;
    }
    this.seenRunIds.set(dedupeKey, entry.timestamp);
    // Bound the idempotency journal independently of queue size.
    if (this.seenRunIds.size > this.maxQueueSize * 50) {
      const oldest = [...this.seenRunIds.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, this.maxQueueSize * 10);
      for (const [key] of oldest) this.seenRunIds.delete(key);
    }

    if (!this.queues.has(parentSessionId)) {
      this.queues.set(parentSessionId, []);
    }

    const queue = this.queues.get(parentSessionId)!;

    // Drop oldest on overflow
    if (queue.length >= this.maxQueueSize) {
      const dropped = queue.shift();
      this.logger.warn(
        { parentSessionId, droppedRunId: dropped?.runId, queueSize: queue.length },
        'Announce queue overflow — dropped oldest entry'
      );
    }

    queue.push(entry);
    this.logger.debug(
      { parentSessionId, runId: entry.runId, label: entry.label, queueSize: queue.length },
      'Sub-agent result enqueued'
    );
  }

  /**
   * Drain all pending entries for a parent session. Returns entries and clears the queue.
   */
  drain(parentSessionId: string): AnnounceEntry[] {
    const queue = this.queues.get(parentSessionId);
    if (!queue || queue.length === 0) return [];

    const entries = [...queue];
    queue.length = 0;

    this.logger.debug(
      { parentSessionId, drained: entries.length },
      'Announce queue drained'
    );
    return entries;
  }

  /**
   * Check if there are pending entries for a parent session
   */
  hasPending(parentSessionId: string): boolean {
    const queue = this.queues.get(parentSessionId);
    return !!queue && queue.length > 0;
  }

  /**
   * Get pending entry count for a parent session
   */
  pendingCount(parentSessionId: string): number {
    return this.queues.get(parentSessionId)?.length ?? 0;
  }

  /** Remove a result after durable push injected the equivalent parent receipt. */
  acknowledge(parentSessionId: string, runId: string): boolean {
    const queue = this.queues.get(parentSessionId);
    if (!queue) return false;
    const index = queue.findIndex(entry => entry.runId === runId);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  /**
   * Clear all entries for a parent session
   */
  clear(parentSessionId: string): void {
    this.queues.delete(parentSessionId);
    const prefix = `${parentSessionId}:`;
    for (const key of this.seenRunIds.keys()) {
      if (key.startsWith(prefix)) this.seenRunIds.delete(key);
    }
  }
}
