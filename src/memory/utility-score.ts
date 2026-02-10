/**
 * Utility Score — enhanced forgetting metric (Phase 29).
 *
 * Replaces simple prominence-threshold pruning with access-history-weighted
 * utility scoring per Hu et al.
 *
 * Formula: utilityScore = prominence × log(1 + accessCount)
 *
 * Memories with high prominence but zero access get low utility;
 * frequently-accessed memories get boosted. This is a SEPARATE metric
 * from prominence — prominence drives decay/ranking, utility score
 * drives deletion decisions.
 */

import type { ScallopDatabase, ScallopMemoryType, MemoryCategory } from './db.js';

// ============ Types ============

export interface LowUtilityMemory {
  id: string;
  content: string;
  prominence: number;
  accessCount: number;
  utilityScore: number;
  category: MemoryCategory;
  ageDays: number;
}

export interface FindLowUtilityOptions {
  /** Utility score threshold — memories below this are candidates (default: 0.1) */
  utilityThreshold?: number;
  /** Minimum age in days before eligible (default: 14) */
  minAgeDays?: number;
  /** Maximum results to return (default: 100) */
  maxResults?: number;
  /** Memory types to exclude from results */
  excludeTypes?: ScallopMemoryType[];
}

// ============ Row shape from SQL ============

interface UtilityRow {
  id: string;
  prominence: number;
  access_count: number;
  category: string;
  memory_type: string;
  document_date: number;
  content: string;
}

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;

// ============ Core Function ============

/**
 * Compute utility score for a memory.
 *
 * Formula: prominence × ln(1 + accessCount)
 *
 * - prominence=0, any access → 0 (zero prominence = zero utility)
 * - any prominence, accessCount=0 → 0 (never accessed = zero utility)
 * - Higher access count logarithmically boosts utility
 */
export function computeUtilityScore(prominence: number, accessCount: number): number {
  return prominence * Math.log(1 + accessCount);
}

// ============ Query Function ============

/**
 * Find memories with low utility scores — candidates for forgetting.
 *
 * Queries active memories (is_latest=1, prominence > 0) older than minAgeDays,
 * computes utility for each, and returns those below utilityThreshold sorted
 * by utility ascending (lowest utility first).
 *
 * Always excludes static_profile type.
 */
export function findLowUtilityMemories(
  db: ScallopDatabase,
  options?: FindLowUtilityOptions,
): LowUtilityMemory[] {
  const utilityThreshold = options?.utilityThreshold ?? 0.1;
  const minAgeDays = options?.minAgeDays ?? 14;
  const maxResults = options?.maxResults ?? 100;
  const excludeTypes = options?.excludeTypes ?? [];

  const now = Date.now();
  const ageCutoff = now - minAgeDays * DAY_MS;

  const rows = db.raw<UtilityRow>(
    `SELECT id, prominence, access_count, category, memory_type, document_date, content
     FROM memories
     WHERE is_latest = 1
       AND memory_type != 'static_profile'
       AND prominence > 0
       AND document_date < ?`,
    [ageCutoff],
  );

  const results: LowUtilityMemory[] = [];

  for (const row of rows) {
    if (excludeTypes.includes(row.memory_type as ScallopMemoryType)) {
      continue;
    }

    const utility = computeUtilityScore(row.prominence, row.access_count);

    if (utility < utilityThreshold) {
      const ageDays = Math.floor((now - row.document_date) / DAY_MS);
      const content =
        row.content.length > 80 ? row.content.slice(0, 80) + '...' : row.content;

      results.push({
        id: row.id,
        content,
        prominence: row.prominence,
        accessCount: row.access_count,
        utilityScore: utility,
        category: row.category as MemoryCategory,
        ageDays,
      });
    }
  }

  // Sort by utility ascending (lowest first)
  results.sort((a, b) => a.utilityScore - b.utilityScore);

  return results.slice(0, maxResults);
}
