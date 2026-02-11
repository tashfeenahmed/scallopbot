/**
 * Eval Mode Configurations
 *
 * Defines the three memory architectures being compared:
 * - OpenClaw: append-only, 0.7 vec + 0.3 BM25, no lifecycle
 * - Mem0: pure vector + dedup, no lifecycle
 * - ScallopBot: hybrid retrieval + decay + full cognitive pipeline
 */

import type { DecayConfig } from '../memory/decay.js';
import type { ScallopMemoryStore, ScallopSearchResult } from '../memory/scallop-store.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';
import { cosineSimilarity } from '../memory/embeddings.js';
import { calculateBM25Score, buildDocFreqMap } from '../memory/bm25.js';

// ============ Types ============

export type ModeSearchFn = (query: string, limit: number) => Promise<ScallopSearchResult[]>;

export type EvalModeName = 'openclaw' | 'mem0' | 'scallopbot';

export interface EvalModeConfig {
  name: EvalModeName;
  label: string;
  searchWeights: { keyword: number; semantic: number; prominence: number };
  enableDecay: boolean;
  enableFusion: boolean;
  enableDreams: boolean;
  enableReflection: boolean;
  enableProactive: boolean;
  /** Mem0-style LLM-driven fact extraction before storage */
  enableFactExtraction: boolean;
  /** Mem0-style LLM-driven dedup (ADD/UPDATE/DELETE/NONE decision) */
  enableLLMDedup: boolean;
  enableReranking: boolean;
  /** Accelerated decay rates for visible effects in 30 days */
  decayOverrides?: Partial<DecayConfig>;
}

// ============ Accelerated Decay Rates ============

/**
 * Accelerated category decay rates to show visible effects in 30 simulated days.
 * Real-world half-lives are too long for a 30-day benchmark.
 */
const EVAL_CATEGORY_DECAY_RATES = {
  event: 0.92,        // half-life ~8.3 days (real: 14d)
  fact: 0.96,         // half-life ~17 days (real: 69d)
  insight: 0.94,      // half-life ~11 days (real: 23d)
  preference: 0.985,  // half-life ~46 days (real: 138d)
  relationship: 0.993, // half-life ~99 days (real: 346d)
} as const;

// ============ Mode Presets ============

/**
 * OpenClaw mode: append-only, 0.7 vec + 0.3 BM25, no prominence, no lifecycle.
 * Based on docs.openclaw.ai/concepts/memory.
 */
export const OPENCLAW_MODE: EvalModeConfig = {
  name: 'openclaw',
  label: 'OpenClaw',
  searchWeights: { keyword: 0.3, semantic: 0.7, prominence: 0.0 },
  enableDecay: false,
  enableFusion: false,
  enableDreams: false,
  enableReflection: false,
  enableProactive: false,
  enableFactExtraction: false,
  enableLLMDedup: false,
  enableReranking: false,
};

/**
 * Mem0 mode: LLM fact extraction + cosine vector search + LLM-driven dedup.
 * Based on arXiv:2504.19413 and github.com/mem0ai/mem0.
 *
 * Real Mem0 pipeline:
 * 1. LLM extracts structured facts from conversation messages
 * 2. For each fact, search top-5 similar existing memories
 * 3. LLM decides ADD/UPDATE/DELETE/NONE for each fact vs existing memories
 * 4. Search is pure cosine similarity (delegated to vector store)
 */
export const MEM0_MODE: EvalModeConfig = {
  name: 'mem0',
  label: 'Mem0',
  searchWeights: { keyword: 0.0, semantic: 1.0, prominence: 0.0 },
  enableDecay: false,
  enableFusion: false,
  enableDreams: false,
  enableReflection: false,
  enableProactive: false,
  enableFactExtraction: true,
  enableLLMDedup: true,
  enableReranking: false,
};

/**
 * ScallopBot mode: everything enabled.
 * Complete cognitive architecture with hybrid retrieval, decay, and LLM reranking.
 */
export const SCALLOPBOT_MODE: EvalModeConfig = {
  name: 'scallopbot',
  label: 'ScallopBot',
  searchWeights: { keyword: 0.5, semantic: 0.5, prominence: 0.0 },
  enableDecay: true,
  enableFusion: true,
  enableDreams: true,
  enableReflection: true,
  enableProactive: true,
  enableFactExtraction: false,
  enableLLMDedup: false,
  enableReranking: true,
  decayOverrides: {
    categoryDecayRates: EVAL_CATEGORY_DECAY_RATES,
  },
};

/** All three modes in evaluation order */
export const ALL_MODES: EvalModeConfig[] = [
  OPENCLAW_MODE,
  MEM0_MODE,
  SCALLOPBOT_MODE,
];

// ============ Mode-Specific Search ============

/**
 * Create a search function that implements the mode's documented search algorithm.
 *
 * - OpenClaw: Weighted fusion of cosine + BM25 with rank-based BM25 normalization.
 *   score = 0.7 * cosine + 0.3 * (1 / (1 + bm25Rank)), minScore=0.35.
 *   Based on: github.com/openclaw/openclaw, docs.openclaw.ai/concepts/memory
 *
 * - Mem0: Pure cosine similarity from vector store, no BM25 or prominence.
 *   Based on: github.com/mem0ai/mem0, arXiv:2504.19413
 *
 * - ScallopBot: delegate to store.search() (0.5/0.5 weights + multiplicative prominence + LLM reranking)
 */
export function createModeSearch(
  mode: EvalModeConfig,
  store: ScallopMemoryStore,
  db: ScallopDatabase,
  embedder: EmbeddingProvider,
): ModeSearchFn {
  if (mode.name === 'openclaw') {
    // OpenClaw: union-based hybrid search.
    // 1. Score all candidates by cosine similarity
    // 2. Score all candidates by BM25, sort, assign ranks, normalize: 1/(1+rank)
    // 3. Fuse: finalScore = 0.7 * cosine + 0.3 * bm25RankScore
    // 4. Filter by minScore=0.35, return top limit
    return async (query: string, limit: number) => {
      const candidateMultiplier = 4;
      const minScore = 0.35;
      const candidates = db.getMemoriesByUser('default', {
        isLatest: true,
        includeAllSources: true,
      });
      if (candidates.length === 0) return [];

      const queryEmbedding = await embedder.embed(query);

      // Build BM25 corpus stats
      const docs = candidates.map(m => m.content);
      const docFreq = buildDocFreqMap(docs);
      const avgDocLen = docs.reduce((sum, d) => sum + d.split(/\s+/).length, 0) / docs.length;

      // Score all candidates by BM25
      const withBM25 = candidates
        .filter(m => m.embedding != null)
        .map(m => ({
          memory: m,
          cosine: cosineSimilarity(queryEmbedding, m.embedding!),
          bm25Raw: calculateBM25Score(query, m.content, {
            avgDocLength: avgDocLen,
            docCount: candidates.length,
            docFreq,
          }),
        }));

      // Sort by BM25 descending to assign ranks
      const bm25Sorted = [...withBM25].sort((a, b) => b.bm25Raw - a.bm25Raw);
      const bm25RankMap = new Map<string, number>();
      bm25Sorted.forEach((item, rank) => {
        bm25RankMap.set(item.memory.id, rank);
      });

      // Fuse scores: 0.7 * cosine + 0.3 * (1 / (1 + bm25Rank))
      const scored = withBM25.map(item => {
        const bm25Rank = bm25RankMap.get(item.memory.id) ?? withBM25.length;
        const bm25RankScore = 1 / (1 + bm25Rank);
        const score = 0.7 * item.cosine + 0.3 * bm25RankScore;
        return { memory: item.memory, score, sourceChunk: item.memory.sourceChunk, matchType: 'hybrid' as const };
      });

      scored.sort((a, b) => b.score - a.score);
      // Apply minScore threshold and candidate limit
      return scored
        .filter(r => r.score >= minScore)
        .slice(0, limit * candidateMultiplier)
        .slice(0, limit);
    };
  }

  if (mode.name === 'mem0') {
    // Mem0: pure cosine similarity from vector store.
    // No BM25, no prominence, no custom scoring formula on top.
    // Real Mem0 delegates entirely to the vector DB (Qdrant by default).
    return async (query: string, limit: number) => {
      const candidates = db.getMemoriesByUser('default', {
        isLatest: true,
        includeAllSources: true,
      });
      if (candidates.length === 0) return [];

      const queryEmbedding = await embedder.embed(query);

      const scored = candidates
        .filter(m => m.embedding != null)
        .map(m => {
          const score = cosineSimilarity(queryEmbedding, m.embedding!);
          return { memory: m, score, sourceChunk: m.sourceChunk, matchType: 'semantic' as const };
        });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    };
  }

  // ScallopBot: delegate to store.search() (hybrid + LLM reranking)
  return async (query: string, limit: number) => {
    return store.search(query, { userId: 'default', limit });
  };
}
