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

  /**
   * Clear all entries for a parent session
   */
  clear(parentSessionId: string): void {
    this.queues.delete(parentSessionId);
  }
}
