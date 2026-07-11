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
import { completionBudgetForPurpose } from '../routing/model-limits.js';
import { extractResponseText } from '../proactive/proactive-utils.js';

/** Options for re-ranking */
export interface RerankOptions {
  /** Maximum candidates to send to the LLM (default: 20) */
  maxCandidates?: number;
  /** End-to-end latency budget before falling back to deterministic scores. */
  timeoutMs?: number;
  /** Durable circuit shared across processes/restarts (normally ScallopDatabase). */
  circuitStore?: RerankCircuitStore;
  /** Injectable clock for deterministic circuit tests. */
  now?: () => number;
}

export interface RerankCircuitStore {
  getStructuredRouteCircuit(route: string): { nextRetryAt: number } | null;
  recordStructuredRouteFailure(route: string, errorCode: string, now?: number): unknown;
  clearStructuredRouteCircuit(route: string): void;
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
const SCORE_THRESHOLD = 0.15;

/** Default maximum candidates to send to the LLM */
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_CANDIDATE_CONTENT_CHARS = 320;
const DEFAULT_TIMEOUT_MS = 5_000;
const CIRCUIT_FAILURE_THRESHOLD = 2;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

interface RerankProviderHealth {
  failures: number;
  openUntil: number;
}

// Provider objects are long-lived runtime singletons. WeakMap keeps the
// circuit bounded and avoids cross-provider/test contamination.
const providerHealth = new WeakMap<LLMProvider, RerankProviderHealth>();

function rerankRoute(provider: LLMProvider): string {
  return `rerank:${provider.name}`;
}

function circuitIsOpen(
  provider: LLMProvider,
  store?: RerankCircuitStore,
  now: number = Date.now(),
): boolean {
  if (store) {
    try {
      return (store.getStructuredRouteCircuit(rerankRoute(provider))?.nextRetryAt ?? 0) > now;
    } catch {
      // Diagnostics must not break deterministic-score fallback.
    }
  }
  const health = providerHealth.get(provider);
  return !!health && health.openUntil > now;
}

function recordFailure(
  provider: LLMProvider,
  store?: RerankCircuitStore,
  now: number = Date.now(),
  errorCode: string = 'provider_error',
): void {
  if (store) {
    try {
      store.recordStructuredRouteFailure(rerankRoute(provider), errorCode, now);
    } catch {
      // Keep the process-local fallback circuit available if persistence fails.
    }
  }
  const current = providerHealth.get(provider) ?? { failures: 0, openUntil: 0 };
  current.failures++;
  if (current.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    current.openUntil = now + CIRCUIT_COOLDOWN_MS;
  }
  providerHealth.set(provider, current);
}

function recordSuccess(provider: LLMProvider, store?: RerankCircuitStore): void {
  if (store) {
    try {
      store.clearStructuredRouteCircuit(rerankRoute(provider));
    } catch {
      // Best effort; the current result is still valid.
    }
  }
  providerHealth.delete(provider);
}

async function completeWithin(
  provider: LLMProvider,
  request: CompletionRequest,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.complete({ ...request, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Reranking exceeded ${timeoutMs}ms latency budget`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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
  const now = options?.now?.() ?? Date.now();

  // Truncate to maxCandidates (keep the highest-originalScore ones)
  const truncated = candidates.length > maxCandidates
    ? candidates.slice(0, maxCandidates)
    : candidates;

  // An unhealthy structured route must not delay every foreground chat turn.
  // Deterministic hybrid scores are always a safe fallback.
  let llmScores: Map<number, number> | null = null;
  if (!circuitIsOpen(provider, options?.circuitStore, now)) try {
    const maxTokens = completionBudgetForPurpose(
      provider,
      'rerank',
      Math.max(2_048, truncated.length * 64 + 512),
    );
    const request = buildRerankPrompt(query, truncated, {
      maxTokens,
      maxContentChars: DEFAULT_CANDIDATE_CONTENT_CHARS,
    });
    request.purpose = 'rerank';
    request.enableThinking = false;
    const response = await completeWithin(
      provider,
      request,
      Math.max(50, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );

    const responseText = extractResponseText(response.content);
    llmScores = parseRerankResponse(responseText);
    if (llmScores) recordSuccess(provider, options?.circuitStore);
    else recordFailure(provider, options?.circuitStore, now, 'invalid_json');
  } catch {
    recordFailure(provider, options?.circuitStore, now, 'timeout_or_provider_error');
    // LLM call failed/timed out — fall through to graceful fallback.
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
  options?: { maxTokens?: number; maxContentChars?: number },
): CompletionRequest {
  const system = `You are a relevance scoring system. Score each memory's relevance to the user's query on a 0.0 to 1.0 scale.

Rules:
- 1.0 = perfectly relevant, directly answers the query
- 0.0 = completely irrelevant
- Score based on semantic relevance, not just keyword overlap
- Consider whether the memory would be useful context when answering the query
- If NONE of the memories are relevant, score ALL 0.0. Be strict: tangential content should score below 0.3

Respond with a JSON object only: {"scores":[{ "index": number, "score": number }, ...]}`;

  const candidateLines = candidates
    .map((c, i) => `${i + 1}. "${truncateCandidateContent(c.content, options?.maxContentChars)}"`)
    .join('\n');

  const userMessage = `Query: "${query}"

Memories:
${candidateLines}

Score each memory's relevance to the query (JSON object only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.1,
    maxTokens: options?.maxTokens ?? 1024,
    structuredOutput: {
      name: 'memory_rerank_scores',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scores: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', minimum: 0 },
                score: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['index', 'score'],
            },
          },
        },
        required: ['scores'],
      },
    },
  };
}

function truncateCandidateContent(content: string, maxChars = DEFAULT_CANDIDATE_CONTENT_CHARS): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars) + '...';
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
