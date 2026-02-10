/**
 * Retrieval Audit — diagnostic for deepTick memory utilization.
 *
 * Audits active memories (prominence >= 0.5, is_latest = 1) to identify
 * never-retrieved and stale-retrieved entries. Audit-only: no mutation.
 * Phase 29 will consume candidatesForDecay.
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

// ============ Main Function ============

/**
 * Audit retrieval history of active memories.
 *
 * Only examines memories with prominence >= 0.5 AND is_latest = 1
 * that are older than minAgeDays to avoid false positives on new memories.
 */
export function auditRetrievalHistory(
  _db: ScallopDatabase,
  _options?: RetrievalAuditOptions,
): RetrievalAuditResult {
  throw new Error('Not implemented');
}
