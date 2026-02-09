/**
 * Memory System
 * Background gardener for ScallopMemory (SQLite)
 */

import type { Logger } from 'pino';

// Re-export types from legacy-types (needed by migrate.ts)
export type { MemoryType, MemoryEntry, PartialMemoryEntry } from './legacy-types.js';

// Re-export from bm25
export { calculateBM25Score, buildDocFreqMap, type BM25Options } from './bm25.js';

import type { ScallopMemoryStore } from './scallop-store.js';

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
  private tickCount = 0;
  /** Run pruning every ~60 ticks (once per hour at default 60s interval) */
  private static readonly PRUNE_EVERY = 60;

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

    // Periodic pruning: old sessions + archived memories
    this.tickCount++;
    if (this.tickCount >= BackgroundGardener.PRUNE_EVERY) {
      this.tickCount = 0;
      try {
        const db = this.scallopStore.getDatabase();
        const sessionsDeleted = db.pruneOldSessions(30);
        const memoriesDeleted = db.pruneArchivedMemories(0.01);
        if (sessionsDeleted > 0 || memoriesDeleted > 0) {
          this.logger.info(
            { sessionsDeleted, memoriesDeleted },
            'Periodic pruning complete'
          );
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Pruning failed');
      }
    }
  }
}
