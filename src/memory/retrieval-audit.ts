/**
 * Retrieval Audit — diagnostic for deepTick memory utilization.
 *
 * Audits active memories (prominence >= 0.5, is_latest = 1) to identify
 * never-retrieved and stale-retrieved entries. Audit-only: no mutation.
 * candidatesForDecay is consumed by runEnhancedForgetting to apply prominence penalties.
 */

import type { ScallopDatabase } from './db.js';

// ============ Types ============

export interface RetrievalAuditOptions {
  /** Minimum age in days before a memory is eligible for audit (default: 7) */
  minAgeDays?: number;
  /** Days since last access before a memory is considered stale (default: 30) */
  staleThresholdDays?: number;
}

export interface RetrievalAuditResult {
  neverRetrieved: number;
  staleRetrieved: number;
  totalAudited: number;
  candidatesForDecay: string[];
}

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_AGE_DAYS = 7;
const DEFAULT_STALE_THRESHOLD_DAYS = 30;

// ============ Row shape from SQL ============

interface AuditRow {
  id: string;
  access_count: number;
  last_accessed: number | null;
}

// ============ Main Function ============

/**
 * Audit retrieval history of active memories.
 *
 * Only examines memories with prominence >= 0.5 AND is_latest = 1
 * that are older than minAgeDays to avoid false positives on new memories.
 */
export function auditRetrievalHistory(
  db: ScallopDatabase,
  options?: RetrievalAuditOptions,
): RetrievalAuditResult {
  const minAgeDays = options?.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const staleThresholdDays = options?.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

  const now = Date.now();
  const ageCutoff = now - minAgeDays * DAY_MS;
  const staleCutoff = now - staleThresholdDays * DAY_MS;

  // Fetch active memories old enough to audit
  const rows = db.raw<AuditRow>(
    `SELECT id, access_count, last_accessed
     FROM memories
     WHERE prominence >= 0.5
       AND is_latest = 1
       AND document_date < ?`,
    [ageCutoff],
  );

  const totalAudited = rows.length;
  let neverRetrieved = 0;
  let staleRetrieved = 0;
  const candidatesForDecay: string[] = [];

  for (const row of rows) {
    if (row.access_count === 0 || row.last_accessed === null) {
      // Never retrieved
      neverRetrieved++;
      candidatesForDecay.push(row.id);
    } else if (row.last_accessed < staleCutoff) {
      // Retrieved but stale
      staleRetrieved++;
      candidatesForDecay.push(row.id);
    }
  }

  return {
    neverRetrieved,
    staleRetrieved,
    totalAudited,
    candidatesForDecay,
  };
}
