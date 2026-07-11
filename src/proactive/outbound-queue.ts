/**
 * OutboundQueue — Delivery layer for proactive messages.
 *
 * Wraps the raw message-send handler to provide:
 * - LLM-powered message combining when multiple messages pile up
 * - Queue size cap to prevent unbounded growth
 *
 * When 2+ messages for the same user accumulate while a drain is in progress,
 * the queue uses an LLM to combine them into a single natural message instead
 * of separate pings. Different users are always delivered independently.
 *
 * All proactive subsystems (scheduler, gardener, fact-extractor) route
 * through this queue so simultaneous messages get merged.
 */

import type { Logger } from 'pino';
import type { Router } from '../routing/router.js';

import { DRAIN_INTERVAL_MS, MAX_QUEUE_SIZE } from './proactive-config.js';
import { sanitizeProactiveMessage } from './message-safety.js';
import { extractResponseText } from './proactive-utils.js';

// ============ LLM Combine Prompt ============

const COMBINE_SYSTEM_PROMPT = `You combine multiple proactive messages into one concise message from an AI assistant.

Rules:
- Sound natural and respectful without pretending to be a human friend
- Preserve time-sensitive reminders and concrete new information
- Merge duplicates and omit redundant generic check-ins
- Prefer one coherent focus; include a second topic only when it is genuinely useful now
- Keep total output concise: normally 1-3 sentences
- No emojis, no bullet points, no headers, no structured formatting
- Preserve any specific times, names, or details from the originals
- Ask at most one question and avoid canned greetings/check-in language
- Output ONLY the combined message, nothing else`;

// ============ Types ============

export interface OutboundQueueOptions {
  /** The underlying message-send handler */
  sendMessage: (userId: string, message: string) => Promise<boolean>;
  /** Logger instance */
  logger: Logger;
  /** LLM router for message combining (optional — falls back to join if missing) */
  router?: Router;
}

interface QueuedMessage {
  userId: string;
  message: string;
  enqueuedAt: number;
  resolve?: (sent: boolean) => void;
}

// ============ Class ============

export class OutboundQueue {
  private sendMessage: (userId: string, message: string) => Promise<boolean>;
  private logger: Logger;
  private router: Router | undefined;

  private queue: QueuedMessage[] = [];
  private drainHandle: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(options: OutboundQueueOptions) {
    this.sendMessage = options.sendMessage;
    this.logger = options.logger.child({ component: 'outbound-queue' });
    this.router = options.router;
  }

  /**
   * Start the queue drain loop (safety net for messages that arrive
   * while a drain is already in progress).
   */
  start(): void {
    if (this.drainHandle) return;
    this.drainHandle = setInterval(() => {
      this.drain().catch(err => {
        this.logger.error({ error: (err as Error).message }, 'Queue drain failed');
      });
    }, DRAIN_INTERVAL_MS);
    this.logger.debug('Outbound queue started');
  }

  /**
   * Stop the queue drain loop
   */
  stop(): void {
    if (this.drainHandle) {
      clearInterval(this.drainHandle);
      this.drainHandle = null;
    }
    for (const item of this.queue) item.resolve?.(false);
    this.queue = [];
  }

  /**
   * Enqueue a proactive message for delivery.
   * Returns true if the message was queued, false if it was dropped (queue full).
   */
  enqueue(userId: string, message: string): boolean {
    return this.enqueueInternal({ userId, message, enqueuedAt: Date.now() });
  }

  private enqueueInternal(item: QueuedMessage): boolean {
    // Queue size cap
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn(
        { queueSize: this.queue.length, dropped: item.message.substring(0, 80) },
        'Outbound queue full, dropping message'
      );
      return false;
    }

    this.queue.push(item);
    this.logger.debug(
      { queueSize: this.queue.length, messagePreview: item.message.substring(0, 80) },
      'Message enqueued'
    );

    return true;
  }

  /**
   * Create a wrapped sendMessage handler that routes through the queue.
   * Drop-in replacement for the raw sendMessage callback.
   */
  createHandler(): (userId: string, message: string) => Promise<boolean> {
    return (userId: string, message: string): Promise<boolean> => new Promise((resolve) => {
      const queued = this.enqueueInternal({ userId, message, enqueuedAt: Date.now(), resolve });
      if (!queued) {
        resolve(false);
        return;
      }
      void this.drain().catch(err => {
        this.logger.error({ error: (err as Error).message }, 'Queue drain failed');
        resolve(false);
      });
    });
  }

  /**
   * Drain the queue: deliver all pending messages immediately.
   * Combines 2+ messages into one via LLM before sending.
   */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    try {
      // Keep draining until messages that arrived during an in-flight send have
      // also been handled. Receipt promises must never wait for the interval.
      while (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];

        const byUser = new Map<string, QueuedMessage[]>();
        for (const item of batch) {
          const messages = byUser.get(item.userId) ?? [];
          messages.push(item);
          byUser.set(item.userId, messages);
        }

        for (const [userId, messages] of byUser) {
          await this.deliverUserBatch(userId, messages);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliverUserBatch(userId: string, messages: QueuedMessage[]): Promise<void> {
    let sent = false;
    try {
      const finalMessage = messages.length === 1
        ? messages[0].message
        : await this.combineMessages(messages);

      if (messages.length > 1) {
        this.logger.info({ userId, messageCount: messages.length }, 'Combined multiple proactive messages via LLM');
      }

      sent = await this.sendMessage(userId, finalMessage);
      if (sent) {
        this.logger.debug({ userId, combined: messages.length > 1 }, 'Proactive message delivered');
      } else {
        this.logger.warn({ userId, combined: messages.length > 1 }, 'Proactive message delivery returned false');
      }
    } catch (err) {
      this.logger.error({ userId, error: (err as Error).message }, 'Failed to deliver queued message');
    } finally {
      for (const item of messages) item.resolve?.(sent);
    }
  }

  /**
   * Use LLM to combine multiple messages into one natural Telegram text.
   * Falls back to newline-joined messages if LLM is unavailable or fails.
   */
  private async combineMessages(messages: QueuedMessage[]): Promise<string> {
    if (!this.router) {
      return this.fallbackJoin(messages);
    }

    const numbered = messages
      .map((m, i) => `${i + 1}. "${m.message}"`)
      .join('\n');

    try {
      const result = await this.router.executeWithFallback(
        {
          messages: [
            { role: 'user', content: `Combine these ${messages.length} messages into one:\n\n${numbered}` },
          ],
          system: COMBINE_SYSTEM_PROMPT,
          maxTokens: 300,
          temperature: 0.7,
        },
        'fast'
      );

      const combined = extractResponseText(result.response.content);
      const safeCombined = sanitizeProactiveMessage(combined);
      if (safeCombined) {
        return safeCombined;
      }

      this.logger.warn('LLM returned empty or unsafe combined message, using fallback');
      return this.fallbackJoin(messages);
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'LLM combine failed, using fallback join'
      );
      return this.fallbackJoin(messages);
    }
  }

  /**
   * Fallback: join messages with double newlines when LLM is unavailable.
   */
  private fallbackJoin(messages: QueuedMessage[]): string {
    return messages.map(m => m.message).join('\n\n');
  }

  /**
   * Get current queue depth (for monitoring)
   */
  getQueueDepth(): number {
    return this.queue.length;
  }
}
