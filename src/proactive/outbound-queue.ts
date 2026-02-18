/**
 * OutboundQueue — Delivery-layer rate limiter for proactive messages.
 *
 * Wraps the raw message-send handler to enforce:
 * - Minimum gap between deliveries (default: 5 minutes)
 * - Per-hour cap (default: 6 messages/hour)
 * - LLM-powered message combining when multiple messages pile up
 *
 * When 2+ messages accumulate for the same user within the batch window,
 * the queue uses an LLM to combine them into a single natural message
 * instead of sending them as separate Telegram pings.
 *
 * All proactive subsystems (scheduler, gardener, fact-extractor) route
 * through this queue, ensuring a unified delivery cadence regardless
 * of how many subsystems are generating messages simultaneously.
 */

import type { Logger } from 'pino';
import type { Router } from '../routing/router.js';

// ============ Constants ============

/** Minimum gap between consecutive proactive deliveries */
const DEFAULT_MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum deliveries per hour */
const DEFAULT_MAX_PER_HOUR = 6;

/** Queue drain interval */
const DRAIN_INTERVAL_MS = 30 * 1000; // 30 seconds

/** Maximum queue size (prevent unbounded growth) */
const MAX_QUEUE_SIZE = 20;

/**
 * Batch collection delay — after the first enqueue into an empty queue,
 * wait this long before draining so messages from different subsystems
 * have time to arrive and get combined.
 */
const BATCH_DELAY_MS = 2 * 60 * 1000; // 2 minutes

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
  /** Minimum gap between deliveries in ms (default: 5 min) */
  minGapMs?: number;
  /** Maximum messages per hour (default: 6) */
  maxPerHour?: number;
  /** Batch collection delay in ms (default: 2 min) */
  batchDelayMs?: number;
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
  private minGapMs: number;
  private maxPerHour: number;
  private batchDelayMs: number;

  private queue: QueuedMessage[] = [];
  private deliveryTimestamps: number[] = [];
  private lastDeliveryAt = 0;
  /** Timestamp of first enqueue into an empty queue (for batch delay) */
  private firstEnqueueAt: number | null = null;
  private drainHandle: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(options: OutboundQueueOptions) {
    this.sendMessage = options.sendMessage;
    this.logger = options.logger.child({ component: 'outbound-queue' });
    this.router = options.router;
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.maxPerHour = options.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
    this.batchDelayMs = options.batchDelayMs ?? BATCH_DELAY_MS;
  }

  /**
   * Start the queue drain loop
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
   * Enqueue a proactive message for rate-limited delivery.
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

    // Track when collection started (for batch delay)
    if (this.queue.length === 0) {
      this.firstEnqueueAt = Date.now();
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
        // Try an immediate drain (will respect batch delay + min gap)
        await this.drain();
      }
      return queued;
    };
  }

  /**
   * Drain the queue: deliver messages respecting rate limits.
   * Groups messages by user and combines when 2+ exist for the same user.
   */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    try {
      const now = Date.now();

      // Batch delay: wait for messages to accumulate before draining
      if (this.firstEnqueueAt && now - this.firstEnqueueAt < this.batchDelayMs) {
        return;
      }

      // Prune old delivery timestamps (keep only last hour)
      this.deliveryTimestamps = this.deliveryTimestamps.filter(
        ts => now - ts < 60 * 60 * 1000
      );

      // Check per-hour cap
      if (this.deliveryTimestamps.length >= this.maxPerHour) {
        this.logger.debug(
          { deliveredThisHour: this.deliveryTimestamps.length, max: this.maxPerHour },
          'Per-hour cap reached, deferring delivery'
        );
        return;
      }

      // Check minimum gap
      if (now - this.lastDeliveryAt < this.minGapMs) {
        return;
      }

      // Group all queued messages by userId
      const byUser = new Map<string, QueuedMessage[]>();
      for (const msg of this.queue) {
        const group = byUser.get(msg.userId) || [];
        group.push(msg);
        byUser.set(msg.userId, group);
      }

      // Pick the user whose oldest message came first
      let earliestUser: string | null = null;
      let earliestTime = Infinity;
      for (const [userId, messages] of byUser) {
        const oldest = messages[0].enqueuedAt;
        if (oldest < earliestTime) {
          earliestTime = oldest;
          earliestUser = userId;
        }
      }

      if (!earliestUser) return;

      const userMessages = byUser.get(earliestUser)!;

      // Remove these messages from the queue
      this.queue = this.queue.filter(m => m.userId !== earliestUser);

      // Reset batch delay tracking
      if (this.queue.length === 0) {
        this.firstEnqueueAt = null;
      } else {
        // Reset to oldest remaining message
        this.firstEnqueueAt = Math.min(...this.queue.map(m => m.enqueuedAt));
      }

      // Combine or pass through
      let finalMessage: string;
      if (userMessages.length === 1) {
        finalMessage = userMessages[0].message;
      } else {
        finalMessage = await this.combineMessages(userMessages);
        this.logger.info(
          { userId: earliestUser, messageCount: userMessages.length },
          'Combined multiple proactive messages via LLM'
        );
      }

      try {
        const sent = await this.sendMessage(earliestUser, finalMessage);
        if (sent) {
          this.lastDeliveryAt = now;
          this.deliveryTimestamps.push(now);
          this.logger.debug(
            { queueRemaining: this.queue.length, combined: userMessages.length > 1 },
            'Proactive message delivered via queue'
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
