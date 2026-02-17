/**
 * InterruptQueue — FIFO queue per session for mid-loop user message injection.
 *
 * When the agent is processing a message (running its while-loop with LLM calls
 * and tool execution), new user messages are pushed here by channels. The agent
 * loop drains them at each iteration and adds them as user messages to the session,
 * so the LLM sees corrections/new instructions without waiting for the current
 * processMessage() call to complete.
 *
 * Follows the same pattern as AnnounceQueue (sub-agent results).
 */

import type { Logger } from 'pino';

export interface InterruptEntry {
  sessionId: string;
  text: string;
  timestamp: number;
}

export interface InterruptQueueOptions {
  maxQueueSize?: number;
  logger: Logger;
}

export class InterruptQueue {
  private queues: Map<string, InterruptEntry[]> = new Map();
  private maxQueueSize: number;
  private logger: Logger;

  constructor(options: InterruptQueueOptions) {
    this.maxQueueSize = options.maxQueueSize ?? 10;
    this.logger = options.logger.child({ module: 'interrupt-queue' });
  }

  /**
   * Enqueue a user message for mid-loop injection.
   * Drops oldest entry on overflow.
   */
  enqueue(entry: InterruptEntry): void {
    const { sessionId } = entry;
    if (!this.queues.has(sessionId)) {
      this.queues.set(sessionId, []);
    }

    const queue = this.queues.get(sessionId)!;

    // Drop oldest on overflow
    if (queue.length >= this.maxQueueSize) {
      const dropped = queue.shift();
      this.logger.warn(
        { sessionId, droppedText: dropped?.text.substring(0, 50), queueSize: queue.length },
        'Interrupt queue overflow — dropped oldest entry'
      );
    }

    queue.push(entry);
    this.logger.debug(
      { sessionId, textPreview: entry.text.substring(0, 80), queueSize: queue.length },
      'User interrupt enqueued'
    );
  }

  /**
   * Drain all pending entries for a session. Returns entries and clears the queue.
   */
  drain(sessionId: string): InterruptEntry[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return [];

    const entries = [...queue];
    queue.length = 0;

    this.logger.debug(
      { sessionId, drained: entries.length },
      'Interrupt queue drained'
    );
    return entries;
  }

  /**
   * Check if there are pending entries for a session
   */
  hasPending(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return !!queue && queue.length > 0;
  }

  /**
   * Get pending entry count for a session
   */
  pendingCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /**
   * Clear all entries for a session
   */
  clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}
