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
  /** Terminal results a running parent turn already consumed via drain(). */
  private drainedRunIds: Map<string, number> = new Map();

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
    // Progress notes are many-per-run; only the terminal entry is idempotent.
    const dedupeKey = entry.kind === 'agent-progress'
      ? `${parentSessionId}:${entry.runId}:progress:${entry.timestamp}:${this.seenRunIds.size}`
      : `${parentSessionId}:${entry.runId}`;
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
      // Progress notes go first; terminal results are only dropped as a last resort.
      const progressIndex = queue.findIndex(item => item.kind === 'agent-progress');
      const dropped = progressIndex >= 0 ? queue.splice(progressIndex, 1)[0] : queue.shift();
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
    for (const entry of entries) {
      if (entry.kind !== 'agent-progress') this.drainedRunIds.set(`${parentSessionId}:${entry.runId}`, Date.now());
    }
    if (this.drainedRunIds.size > this.maxQueueSize * 50) {
      const oldest = [...this.drainedRunIds.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.maxQueueSize * 10);
      for (const [key] of oldest) this.drainedRunIds.delete(key);
    }

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

  /** True when a terminal (result/exited) entry is queued — progress notes don't count. */
  hasTerminalPending(parentSessionId: string): boolean {
    return !!this.queues.get(parentSessionId)?.some(entry => entry.kind !== 'agent-progress');
  }

  /** True once a running parent turn drained this run's terminal result. */
  wasDrained(parentSessionId: string, runId: string): boolean {
    return this.drainedRunIds.has(`${parentSessionId}:${runId}`);
  }

  /** True while this run's terminal result is still queued. */
  isQueued(parentSessionId: string, runId: string): boolean {
    return !!this.queues.get(parentSessionId)?.some(entry => entry.runId === runId && entry.kind !== 'agent-progress');
  }

  /** Drop non-terminal progress entries (used when a wake turn starts). */
  dropProgress(parentSessionId: string): void {
    const queue = this.queues.get(parentSessionId);
    if (!queue) return;
    const kept = queue.filter(entry => entry.kind !== 'agent-progress');
    queue.length = 0;
    queue.push(...kept);
  }

  /** Remove a result after durable push injected the equivalent parent receipt. */
  acknowledge(parentSessionId: string, runId: string): boolean {
    const queue = this.queues.get(parentSessionId);
    if (!queue) return false;
    const index = queue.findIndex(entry => entry.runId === runId && entry.kind !== 'agent-progress');
    if (index < 0) return false;
    queue.splice(index, 1);
    this.drainedRunIds.set(`${parentSessionId}:${runId}`, Date.now());
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
