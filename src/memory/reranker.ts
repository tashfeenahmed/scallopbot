/**
 * LLM-based Re-ranker for Memory Search Results
 *
 * Scores each candidate memory's relevance to a query using an LLM,
 * then blends the LLM score with the original retrieval score to produce
 * a final ranking that captures semantic nuance beyond lexical/vector similarity.
 *
 * Score blending: finalScore = (originalScore * 0.4) + (llmRelevanceScore * 0.6)
 */

import type { LLMProvider, CompletionRequest } from '../providers/types.js';

/** Options for re-ranking */
export interface RerankOptions {
  /** Maximum candidates to send to the LLM (default: 20) */
  maxCandidates?: number;
  /** Timeout in milliseconds for the LLM call (not implemented — relies on provider timeout) */
  timeoutMs?: number;
}

/** A candidate memory to be re-ranked */
export interface RerankCandidate {
  /** Memory ID */
  id: string;
  /** Memory content text */
  content: string;
  /** Original retrieval score (from hybrid search) */
  originalScore: number;
}

/** Result of re-ranking a candidate */
export interface RerankResult {
  /** Memory ID */
  id: string;
  /** LLM-assigned relevance score (0.0 - 1.0) */
  relevanceScore: number;
  /** Original retrieval score */
  originalScore: number;
  /** Blended final score: (originalScore * 0.4) + (relevanceScore * 0.6) */
  finalScore: number;
}

/** Weight constants for score blending */
const ORIGINAL_WEIGHT = 0.4;
const LLM_WEIGHT = 0.6;

/** Minimum finalScore to keep a result */
const SCORE_THRESHOLD = 0.05;

/** Default maximum candidates to send to the LLM */
const DEFAULT_MAX_CANDIDATES = 20;

/**
 * Re-rank memory search results using an LLM to score relevance.
 *
 * - Empty candidates => returns empty array (no LLM call)
 * - LLM failure => graceful fallback to original scores
 * - Malformed LLM JSON => graceful fallback to original scores
 * - Candidates exceeding maxCandidates are truncated before the LLM call
 * - Results with finalScore < 0.05 are dropped
 */
export async function rerankResults(
  query: string,
  candidates: RerankCandidate[],
  provider: LLMProvider,
  options?: RerankOptions,
): Promise<RerankResult[]> {
  if (candidates.length === 0) {
    return [];
  }

  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  // Truncate to maxCandidates (keep the highest-originalScore ones)
  const truncated = candidates.length > maxCandidates
    ? candidates.slice(0, maxCandidates)
    : candidates;

  // Attempt LLM re-ranking
  let llmScores: Map<number, number> | null = null;
  try {
    const request = buildRerankPrompt(query, truncated);
    const response = await provider.complete(request);

    // Extract text from ContentBlock[] response (same pattern as fact-extractor.ts)
    const responseText = Array.isArray(response.content)
      ? response.content.map(block => 'text' in block ? block.text : '').join('')
      : String(response.content);

    llmScores = parseRerankResponse(responseText);
  } catch {
    // LLM call failed — fall through to graceful fallback
  }

  // Build results with score blending
  const results: RerankResult[] = truncated.map((candidate, index) => {
    if (llmScores !== null && llmScores.has(index)) {
      const relevanceScore = llmScores.get(index)!;
      const finalScore = candidate.originalScore * ORIGINAL_WEIGHT + relevanceScore * LLM_WEIGHT;
      return {
        id: candidate.id,
        relevanceScore,
        originalScore: candidate.originalScore,
        finalScore,
      };
    }

    // Fallback: use original score directly
    return {
      id: candidate.id,
      relevanceScore: candidate.originalScore,
      originalScore: candidate.originalScore,
      finalScore: candidate.originalScore,
    };
  });

  // Filter by threshold
  const filtered = results.filter(r => r.finalScore >= SCORE_THRESHOLD);

  // Sort by finalScore descending
  filtered.sort((a, b) => b.finalScore - a.finalScore);

  return filtered;
}

/**
 * Build a CompletionRequest for the re-ranking LLM call.
 *
 * System prompt instructs scoring on 0.0-1.0 scale.
 * User message presents query + numbered candidates.
 * Requests JSON array of { index, score } pairs.
 * Uses low temperature (0.1) for consistency.
 */
export function buildRerankPrompt(
  query: string,
  candidates: RerankCandidate[],
): CompletionRequest {
  const system = `You are a relevance scoring system. Score each memory's relevance to the user's query on a 0.0 to 1.0 scale.

Rules:
- 1.0 = perfectly relevant, directly answers the query
- 0.0 = completely irrelevant
- Score based on semantic relevance, not just keyword overlap
- Consider whether the memory would be useful context when answering the query

Respond with a JSON array only: [{ "index": number, "score": number }, ...]`;

  const candidateLines = candidates
    .map((c, i) => `${i + 1}. "${c.content}"`)
    .join('\n');

  const userMessage = `Query: "${query}"

Memories:
${candidateLines}

Score each memory's relevance to the query (JSON array only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.1,
    maxTokens: 500,
  };
}

/**
 * Parse the LLM response to extract relevance scores.
 *
 * Expects a JSON array of { index: number, score: number }.
 * Returns a Map from index to score, or null if parsing fails.
 * Follows the fact-extractor.ts pattern: extract JSON with regex, then parse.
 */
export function parseRerankResponse(responseText: string): Map<number, number> | null {
  if (!responseText || responseText.trim().length === 0) {
    return null;
  }

  // Try to extract a JSON array from the response
  const arrayMatch = responseText.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(arrayMatch[0]) as Array<{ index: number; score: number }>;

    if (!Array.isArray(parsed)) {
      return null;
    }

    const scores = new Map<number, number>();

    // Detect if LLM returned 1-based indices (prompt numbers candidates 1-based).
    // If the minimum index is >= 1 and no index is 0, assume 1-based and convert.
    const validEntries = parsed.filter(
      (e): e is { index: number; score: number } =>
        typeof e.index === 'number' &&
        typeof e.score === 'number' &&
        e.score >= 0 &&
        e.score <= 1,
    );

    if (validEntries.length === 0) return null;

    const minIndex = Math.min(...validEntries.map(e => e.index));
    const isOneBased = minIndex >= 1;

    for (const entry of validEntries) {
      const idx = isOneBased ? entry.index - 1 : entry.index;
      if (idx >= 0) {
        scores.set(idx, entry.score);
      }
    }

    return scores.size > 0 ? scores : null;
  } catch {
    return null;
  }
}
