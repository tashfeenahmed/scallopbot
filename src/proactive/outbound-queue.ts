/**
 * OutboundQueue — Delivery-layer rate limiter for proactive messages.
 *
 * Wraps the raw message-send handler to enforce:
 * - Minimum gap between deliveries (default: 5 minutes)
 * - Per-hour cap (default: 6 messages/hour)
 * - Word-overlap deduplication within a time window
 *
 * All proactive subsystems (scheduler, gardener, fact-extractor) route
 * through this queue, ensuring a unified delivery cadence regardless
 * of how many subsystems are generating messages simultaneously.
 */

import type { Logger } from 'pino';

// ============ Constants ============

/** Minimum gap between consecutive proactive deliveries */
const DEFAULT_MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum deliveries per hour */
const DEFAULT_MAX_PER_HOUR = 6;

/** Word overlap threshold for deduplication */
const DEDUP_OVERLAP_THRESHOLD = 0.5;

/** Deduplication window: ignore duplicates within this period */
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Queue drain interval */
const DRAIN_INTERVAL_MS = 30 * 1000; // 30 seconds

/** Maximum queue size (prevent unbounded growth) */
const MAX_QUEUE_SIZE = 20;

// ============ Types ============

export interface OutboundQueueOptions {
  /** The underlying message-send handler */
  sendMessage: (userId: string, message: string) => Promise<boolean>;
  /** Logger instance */
  logger: Logger;
  /** Minimum gap between deliveries in ms (default: 5 min) */
  minGapMs?: number;
  /** Maximum messages per hour (default: 6) */
  maxPerHour?: number;
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
  private minGapMs: number;
  private maxPerHour: number;

  private queue: QueuedMessage[] = [];
  private deliveryTimestamps: number[] = [];
  private recentMessages: Array<{ message: string; deliveredAt: number }> = [];
  private lastDeliveryAt = 0;
  private drainHandle: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(options: OutboundQueueOptions) {
    this.sendMessage = options.sendMessage;
    this.logger = options.logger.child({ component: 'outbound-queue' });
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.maxPerHour = options.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
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
   * Returns true if the message was queued, false if it was dropped (duplicate or queue full).
   */
  enqueue(userId: string, message: string): boolean {
    // Dedup: check recent deliveries for similar content
    if (this.isDuplicate(message)) {
      this.logger.debug(
        { messagePreview: message.substring(0, 80) },
        'Dropped duplicate proactive message'
      );
      return false;
    }

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
        // Try an immediate drain if the gap has elapsed
        await this.drain();
      }
      return queued;
    };
  }

  /**
   * Drain the queue: deliver messages respecting rate limits
   */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    try {
      const now = Date.now();

      // Prune old delivery timestamps (keep only last hour)
      this.deliveryTimestamps = this.deliveryTimestamps.filter(
        ts => now - ts < 60 * 60 * 1000
      );

      // Prune old recent messages (for dedup)
      this.recentMessages = this.recentMessages.filter(
        m => now - m.deliveredAt < DEDUP_WINDOW_MS
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

      // Deliver the next message
      const item = this.queue.shift();
      if (!item) return;

      // Final dedup check (may have been queued a while ago)
      if (this.isDuplicate(item.message)) {
        this.logger.debug('Skipping stale duplicate from queue');
        return;
      }

      try {
        const sent = await this.sendMessage(item.userId, item.message);
        if (sent) {
          this.lastDeliveryAt = now;
          this.deliveryTimestamps.push(now);
          this.recentMessages.push({ message: item.message, deliveredAt: now });
          this.logger.debug(
            { queueRemaining: this.queue.length },
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
   * Check if a message is a duplicate of a recently delivered message
   */
  private isDuplicate(message: string): boolean {
    const newWords = normalizeWords(message);
    if (newWords.size === 0) return false;

    for (const recent of this.recentMessages) {
      const existingWords = normalizeWords(recent.message);
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) overlap++;
      }

      const similarity = overlap / Math.min(newWords.size, existingWords.size);
      if (similarity >= DEDUP_OVERLAP_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get current queue depth (for monitoring)
   */
  getQueueDepth(): number {
    return this.queue.length;
  }
}

// ============ Helpers ============

function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}
