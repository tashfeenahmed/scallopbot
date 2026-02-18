/**
 * OutboundQueue — Delivery layer for proactive messages.
 *
 * Wraps the raw message-send handler to provide:
 * - LLM-powered message combining when multiple messages pile up
 * - Queue size cap to prevent unbounded growth
 *
 * This is a single-user system. When 2+ messages accumulate while a
 * drain is in progress, the queue uses an LLM to combine them into
 * a single natural Telegram message instead of separate pings.
 *
 * All proactive subsystems (scheduler, gardener, fact-extractor) route
 * through this queue so simultaneous messages get merged.
 */

import type { Logger } from 'pino';
import type { Router } from '../routing/router.js';

// ============ Constants ============

/** Queue drain interval (safety net for stuck messages) */
const DRAIN_INTERVAL_MS = 30 * 1000; // 30 seconds

/** Maximum queue size (prevent unbounded growth) */
const MAX_QUEUE_SIZE = 20;

// ============ LLM Combine Prompt ============

const COMBINE_SYSTEM_PROMPT = `You combine multiple proactive messages into a single natural Telegram message.

Rules:
- Write as if casually texting a friend
- Include EVERY topic from the individual messages — never drop anything
- Group related items naturally (e.g., two reminders together)
- Keep total output concise: 2-5 sentences depending on how many topics
- No emojis, no bullet points, no headers, no structured formatting
- Use natural transitions: "Also", "Oh and", "By the way", etc.
- For unrelated topics, brief jumps are fine — don't force connections
- Preserve any specific times, names, or details from the originals
- Match the casual tone of the originals (e.g., "Hey", "Just a heads up")
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
  }

  /**
   * Enqueue a proactive message for delivery.
   * Returns true if the message was queued, false if it was dropped (queue full).
   */
  enqueue(userId: string, message: string): boolean {
    // Queue size cap
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn(
        { queueSize: this.queue.length, dropped: message.substring(0, 80) },
        'Outbound queue full, dropping message'
      );
      return false;
    }

    this.queue.push({ userId, message, enqueuedAt: Date.now() });
    this.logger.debug(
      { queueSize: this.queue.length, messagePreview: message.substring(0, 80) },
      'Message enqueued'
    );

    return true;
  }

  /**
   * Create a wrapped sendMessage handler that routes through the queue.
   * Drop-in replacement for the raw sendMessage callback.
   */
  createHandler(): (userId: string, message: string) => Promise<boolean> {
    return async (userId: string, message: string): Promise<boolean> => {
      const queued = this.enqueue(userId, message);
      if (queued) {
        await this.drain();
      }
      return queued;
    };
  }

  /**
   * Drain the queue: deliver all pending messages immediately.
   * Combines 2+ messages into one via LLM before sending.
   */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    try {
      // Take ownership of all queued messages
      const messages = this.queue;
      const userId = messages[0].userId;
      this.queue = [];

      // Combine or pass through
      let finalMessage: string;
      if (messages.length === 1) {
        finalMessage = messages[0].message;
      } else {
        finalMessage = await this.combineMessages(messages);
        this.logger.info(
          { messageCount: messages.length },
          'Combined multiple proactive messages via LLM'
        );
      }

      try {
        const sent = await this.sendMessage(userId, finalMessage);
        if (sent) {
          this.logger.debug(
            { combined: messages.length > 1 },
            'Proactive message delivered'
          );
        }
      } catch (err) {
        this.logger.error(
          { error: (err as Error).message },
          'Failed to deliver queued message'
        );
      }
    } finally {
      this.draining = false;
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

      const textBlock = result.response.content.find(b => b.type === 'text');
      const combined = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
      if (combined.length > 0) {
        return combined;
      }

      this.logger.warn('LLM returned empty combined message, using fallback');
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
