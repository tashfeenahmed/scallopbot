/**
 * Fact de-duplication without an LLM.
 *
 * Fact extraction used to rerank every extracted fact's neighbours with an LLM
 * before deciding whether it was new. That cost one LLM call per fact. The
 * decision only needs "is this the same statement?", which embedding similarity
 * plus lexical (BM25-matched) token overlap answers deterministically.
 */

import { cosineSimilarity } from './embeddings.js';

const DEDUPE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'to', 'of',
  'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'that',
  'this', 'it', 'its', 'user', 'users', 's', 'has', 'have', 'had', 'their', 'his', 'her',
]);

/** Normalised content-word set used for lexical duplicate checks. */
export function factTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(token => token.length > 0 && !DEDUPE_STOP_WORDS.has(token)),
  );
}

/** Jaccard overlap of two content-word sets, 0..1. */
export function tokenJaccard(a: string, b: string): number {
  const left = factTokens(a);
  const right = factTokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

export interface DedupeCandidate {
  content: string;
  embedding?: number[] | null;
  /** Search match type; 'semantic' means BM25 found no lexical overlap. */
  matchType?: 'semantic' | 'keyword' | 'hybrid';
}

export interface DedupeOptions {
  /** Cosine at/above which two facts are duplicates on embeddings alone. */
  embeddingThreshold: number;
  /** Token Jaccard at/above which a BM25-matched candidate counts as the same statement. */
  lexicalThreshold?: number;
  /** When both sides have vectors, the lexical path also needs at least this cosine. */
  lexicalMinCosine?: number;
}

/**
 * True when `candidate` states the same thing as `fact`:
 *   - embedding cosine >= embeddingThreshold, or
 *   - the candidate was a lexical (BM25) hit, its content words overlap the
 *     fact's almost entirely, and (if both have vectors) the vectors agree.
 * The lexical path covers TF-IDF/missing-embedding setups and reworded
 * casing/punctuation, which the old per-fact LLM rerank used to absorb.
 */
export function isNearDuplicateFact(
  fact: { content: string; embedding?: number[] | null },
  candidate: DedupeCandidate,
  options: DedupeOptions,
): boolean {
  const lexicalThreshold = options.lexicalThreshold ?? 0.9;
  const lexicalMinCosine = options.lexicalMinCosine ?? 0.85;
  const cosine = fact.embedding && candidate.embedding
    && fact.embedding.length === candidate.embedding.length
    ? cosineSimilarity(fact.embedding, candidate.embedding)
    : undefined;
  if (cosine !== undefined && cosine >= options.embeddingThreshold) return true;
  if (candidate.matchType === 'semantic') return false;
  if (tokenJaccard(fact.content, candidate.content) < lexicalThreshold) return false;
  return cosine === undefined || cosine >= lexicalMinCosine;
}
