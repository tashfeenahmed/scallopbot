/**
 * Metric Collection & Scoring
 *
 * Collects per-day metrics across memory health, retrieval quality,
 * lifecycle activity, and cognitive indicators. Used by the eval runner
 * to build comparison data across the four memory architectures.
 */

import type { ScallopDatabase } from '../memory/db.js';
import type { ScallopMemoryStore, ScallopSearchResult } from '../memory/scallop-store.js';
import type { EmotionLabel } from '../memory/affect.js';
import type { GroundTruthQuery } from './scenarios.js';
import type { CognitiveCallLogEntry } from './mock-cognitive.js';
import type { ModeSearchFn } from './modes.js';
import { PROMINENCE_THRESHOLDS } from '../memory/decay.js';

// ============ Types ============

export interface DayMetrics {
  day: number;

  // Memory health
  totalMemories: number;
  activeCount: number;       // prominence > 0.5
  dormantCount: number;      // 0.1 < prominence <= 0.5
  archivedCount: number;     // prominence <= 0.1

  // Retrieval quality (averaged across all applicable ground-truth queries)
  precision5: number;        // relevant results in top-5 / 5
  recall: number;            // unique expected substrings found / total expected
  mrr: number;               // mean reciprocal rank of first relevant result

  // Lifecycle activity (cumulative)
  fusionCount: number;
  remDiscoveries: number;
  relationsCount: number;    // total relations in graph

  // Cognitive indicators
  soulWords: number;         // 0 if no reflection
  gapSignals: number;
  trustScore: number;        // 0 if no trust computation

  // Cost proxy
  llmCalls: number;

  // Affect classification
  detectedEmotion: EmotionLabel;
  expectedEmotion: EmotionLabel;
}

// ============ Retrieval Scoring ============

/**
 * Score a single search result set against a ground-truth query.
 */
function scoreQuery(
  results: ScallopSearchResult[],
  query: GroundTruthQuery,
): { precision5: number; recall: number; mrr: number } {
  const expected = query.expectedSubstrings;
  const top5 = results.slice(0, 5);

  // Check which results contain any expected substring (case-insensitive)
  const matches = top5.map(r => {
    const content = r.memory.content.toLowerCase();
    return expected.some(sub => content.includes(sub.toLowerCase()));
  });

  // Precision@5: how many of top-5 are relevant
  const precision5 = matches.filter(Boolean).length / 5;

  // Recall: how many unique expected substrings were found across all results
  const foundSubstrings = new Set<string>();
  for (const r of top5) {
    const content = r.memory.content.toLowerCase();
    for (const sub of expected) {
      if (content.includes(sub.toLowerCase())) {
        foundSubstrings.add(sub.toLowerCase());
      }
    }
  }
  const recall = foundSubstrings.size / expected.length;

  // MRR: reciprocal rank of first relevant result
  const firstRelevantIdx = matches.indexOf(true);
  const mrr = firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0;

  return { precision5, recall, mrr };
}

// ============ Metric Collection ============

/**
 * Collect all metrics for a given day.
 */
export async function collectDayMetrics(
  db: ScallopDatabase,
  store: ScallopMemoryStore,
  searchFn: ModeSearchFn,
  queries: GroundTruthQuery[],
  callLog: CognitiveCallLogEntry[],
  callCount: number,
  day: number,
  soulContent: string | null,
  detectedEmotion: EmotionLabel,
  expectedEmotion: EmotionLabel,
): Promise<DayMetrics> {
  // -- Memory health --
  // Count only "live" memories (isLatest=true, exclude sentinel rows)
  // This gives a fair comparison: fusion modes replace N memories with 1 derived,
  // marking sources as superseded (isLatest=false).
  const liveCounts = db.raw<{ status: string; cnt: number }>(
    `SELECT
       CASE
         WHEN prominence > ${PROMINENCE_THRESHOLDS.ACTIVE} THEN 'active'
         WHEN prominence > ${PROMINENCE_THRESHOLDS.DORMANT} THEN 'dormant'
         ELSE 'archived'
       END as status,
       COUNT(*) as cnt
     FROM memories
     WHERE is_latest = 1 AND source != '_cleaned_sentinel'
     GROUP BY status`,
    [],
  );
  const countMap: Record<string, number> = {};
  for (const row of liveCounts) countMap[row.status] = row.cnt;
  const activeCount = countMap['active'] ?? 0;
  const dormantCount = countMap['dormant'] ?? 0;
  const archivedCount = countMap['archived'] ?? 0;
  const totalMemories = activeCount + dormantCount + archivedCount;

  // -- Retrieval quality --
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalMrr = 0;
  let queryCount = 0;

  for (const query of queries) {
    try {
      const results = await searchFn(query.query, 5);
      const scores = scoreQuery(results, query);
      totalPrecision += scores.precision5;
      totalRecall += scores.recall;
      totalMrr += scores.mrr;
      queryCount++;
    } catch {
      // Search failed — count as zero
      queryCount++;
    }
  }

  const precision5 = queryCount > 0 ? totalPrecision / queryCount : 0;
  const recall = queryCount > 0 ? totalRecall / queryCount : 0;
  const mrr = queryCount > 0 ? totalMrr / queryCount : 0;

  // -- Lifecycle activity --
  const fusionCount = callLog.filter(l => l.operation === 'fusion' || l.operation === 'nrem').length;
  const remDiscoveries = callLog.filter(l => l.operation === 'rem_judge').length;

  let relationsCount = 0;
  try {
    const relations = db.getAllRelations();
    relationsCount = relations.length;
  } catch {
    // getAllRelations may not exist; fall back to raw query
    try {
      const rows = db.raw<{ cnt: number }>('SELECT COUNT(*) as cnt FROM memory_relations', []);
      relationsCount = rows[0]?.cnt ?? 0;
    } catch {
      relationsCount = 0;
    }
  }

  // -- Cognitive indicators --
  const soulWords = soulContent ? soulContent.split(/\s+/).length : 0;

  const gapSignals = callLog.filter(l => l.operation === 'gap_diagnosis').length;

  let trustScore = 0;
  try {
    const patterns = db.getBehavioralPatterns('default');
    trustScore = (patterns?.responsePreferences?.trustScore as number) ?? 0;
  } catch {
    trustScore = 0;
  }

  return {
    day,
    totalMemories,
    activeCount,
    dormantCount,
    archivedCount,
    precision5,
    recall,
    mrr,
    fusionCount,
    remDiscoveries,
    relationsCount,
    soulWords,
    gapSignals,
    trustScore,
    llmCalls: callCount,
    detectedEmotion,
    expectedEmotion,
  };
}
