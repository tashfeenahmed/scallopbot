/**
 * Health Ping — lightweight sync diagnostic for lightTick.
 *
 * Returns WAL size, memory count, process memory, and timestamp.
 * Pure function: no async, no network calls.
 */

import type { ScallopDatabase } from './db.js';

// ============ Types ============

export interface HealthPingResult {
  walSizeBytes: number;
  memoryCount: number;
  processMemoryMB: number;
  timestamp: number;
}

// ============ Main Function ============

/** Bytes per SQLite page (default) */
const SQLITE_PAGE_SIZE = 4096;

/**
 * Perform a synchronous health ping against the database.
 *
 * Queries WAL checkpoint size, active memory count, and process heap usage.
 * Fully synchronous — safe for lightTick.
 */
export function performHealthPing(db: ScallopDatabase): HealthPingResult {
  // WAL size via PRAGMA wal_checkpoint(PASSIVE)
  // Returns: busy, log (total pages in WAL), checkpointed (pages moved back)
  const walRows = db.raw<{ busy: number; log: number; checkpointed: number }>(
    'PRAGMA wal_checkpoint(PASSIVE)'
  );
  const walPages = walRows.length > 0 ? Math.max(0, walRows[0].log) : 0;
  const walSizeBytes = walPages * SQLITE_PAGE_SIZE;

  // Active memory count (is_latest = 1)
  const countRows = db.raw<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM memories WHERE is_latest = 1'
  );
  const memoryCount = countRows.length > 0 ? countRows[0].cnt : 0;

  // Process heap memory in MB
  const processMemoryMB = process.memoryUsage().heapUsed / 1_048_576;

  return {
    walSizeBytes,
    memoryCount,
    processMemoryMB,
    timestamp: Date.now(),
  };
}
