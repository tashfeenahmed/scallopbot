/**
 * Memory System
 * Hot collector and background gardener for ScallopMemory (SQLite)
 */

import type { Logger } from 'pino';
import { nanoid } from 'nanoid';

// Re-export types from legacy-types (needed by migrate.ts)
export type { MemoryType, MemoryEntry, PartialMemoryEntry } from './legacy-types.js';
import type { MemoryEntry } from './legacy-types.js';

// Re-export from extract-facts
export { extractFacts, summarizeMemories, type ExtractedFact } from './extract-facts.js';

// Re-export from bm25
export { calculateBM25Score, buildDocFreqMap, type BM25Options } from './bm25.js';

import type { ScallopMemoryStore } from './scallop-store.js';

export interface CollectOptions {
  content: string;
  sessionId: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface HotCollectorOptions {
  scallopStore: ScallopMemoryStore;
  maxBuffer?: number;
}

/**
 * Hot Collector - buffers messages during conversation and flushes to ScallopStore
 */
export class HotCollector {
  private scallopStore: ScallopMemoryStore;
  private buffers: Map<string, MemoryEntry[]> = new Map();
  private maxBuffer: number;

  constructor(options: HotCollectorOptions) {
    this.scallopStore = options.scallopStore;
    this.maxBuffer = options.maxBuffer ?? 100;
  }

  collect(options: CollectOptions): MemoryEntry {
    const entry: MemoryEntry = {
      id: nanoid(),
      content: options.content,
      type: 'raw',
      timestamp: new Date(),
      sessionId: options.sessionId,
      tags: options.tags,
      metadata: {
        ...options.metadata,
        source: options.source,
      },
    };

    let buffer = this.buffers.get(options.sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(options.sessionId, buffer);
    }

    buffer.push(entry);

    // Trim buffer if over limit
    if (buffer.length > this.maxBuffer) {
      buffer.shift();
    }

    return entry;
  }

  getBuffer(sessionId: string): MemoryEntry[] {
    return this.buffers.get(sessionId) || [];
  }

  flush(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || buffer.length === 0) return;

    for (const entry of buffer) {
      this.scallopStore.add({
        userId: sessionId,
        content: entry.content,
        category: 'event',
        importance: 3,
        confidence: 1.0,
        metadata: {
          ...entry.metadata,
          type: entry.type,
          tags: entry.tags,
        },
      }).catch((err) => {
        console.error('HotCollector: failed to flush to ScallopStore:', err);
      });
    }

    this.buffers.set(sessionId, []);
  }

  clear(sessionId: string): void {
    this.buffers.set(sessionId, []);
  }

  flushAll(): void {
    for (const sessionId of this.buffers.keys()) {
      this.flush(sessionId);
    }
  }
}

export interface BackgroundGardenerOptions {
  scallopStore: ScallopMemoryStore;
  logger: Logger;
  interval?: number;
}

/**
 * Background Gardener - runs periodic decay processing on memories
 */
export class BackgroundGardener {
  private scallopStore: ScallopMemoryStore;
  private logger: Logger;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: BackgroundGardenerOptions) {
    this.scallopStore = options.scallopStore;
    this.logger = options.logger.child({ component: 'gardener' });
    this.interval = options.interval ?? 60000;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      this.processMemories();
    }, this.interval);

    this.logger.info('Background gardener started');
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Background gardener stopped');
  }

  processMemories(): void {
    this.logger.debug('Processing memories');

    const decayResult = this.scallopStore.processDecay();
    if (decayResult.updated > 0 || decayResult.archived > 0) {
      this.logger.debug(
        { updated: decayResult.updated, archived: decayResult.archived },
        'ScallopMemory decay processed'
      );
    }
  }
}
