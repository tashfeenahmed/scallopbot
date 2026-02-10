/**
 * Tests for LLM-based re-ranking of memory search results
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults, type RerankCandidate } from './reranker.js';
import type { LLMProvider, CompletionResponse, CompletionRequest } from '../providers/types.js';

/**
 * Helper to create a mock LLMProvider that returns a predefined response
 */
function createMockProvider(responseText: string): LLMProvider {
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

/**
 * Helper to create a mock provider that throws an error
 */
function createFailingProvider(errorMessage: string): LLMProvider {
  return {
    name: 'mock-failing',
    isAvailable: () => true,
    complete: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

describe('rerankResults', () => {
  it('re-ranks 5 candidates with LLM relevance scores', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Wife likes sushi', originalScore: 0.7 },
      { id: 'mem-2', content: 'Lives in Dublin', originalScore: 0.6 },
      { id: 'mem-3', content: 'Works at Google', originalScore: 0.5 },
      { id: 'mem-4', content: 'Wife is vegetarian on weekdays', originalScore: 0.4 },
      { id: 'mem-5', content: 'Enjoys hiking', originalScore: 0.3 },
    ];

    // LLM scores: "Wife likes sushi" high relevance, "Lives in Dublin" low
    const llmResponse = JSON.stringify([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.1 },
      { index: 2, score: 0.05 },
      { index: 3, score: 0.85 },
      { index: 4, score: 0.02 },
    ]);

    const provider = createMockProvider(llmResponse);

    const results = await rerankResults("wife's food preferences", candidates, provider);

    // Verify provider.complete was called
    expect(provider.complete).toHaveBeenCalledOnce();

    // Verify results are sorted by finalScore descending
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].finalScore).toBeGreaterThanOrEqual(results[i + 1].finalScore);
    }

    // "Wife likes sushi" should be top: finalScore = (0.7 * 0.4) + (0.9 * 0.6) = 0.28 + 0.54 = 0.82
    const sushiResult = results.find(r => r.id === 'mem-1');
    expect(sushiResult).toBeDefined();
    expect(sushiResult!.relevanceScore).toBeCloseTo(0.9, 1);
    expect(sushiResult!.finalScore).toBeCloseTo(0.82, 2);

    // "Lives in Dublin" should be low: finalScore = (0.6 * 0.4) + (0.1 * 0.6) = 0.24 + 0.06 = 0.30
    const dublinResult = results.find(r => r.id === 'mem-2');
    expect(dublinResult).toBeDefined();
    expect(dublinResult!.relevanceScore).toBeCloseTo(0.1, 1);
    expect(dublinResult!.finalScore).toBeCloseTo(0.30, 2);

    // "Wife is vegetarian" should also rank high
    const vegResult = results.find(r => r.id === 'mem-4');
    expect(vegResult).toBeDefined();
    expect(vegResult!.relevanceScore).toBeCloseTo(0.85, 1);
  });

  it('returns empty array for empty candidates', async () => {
    const provider = createMockProvider('[]');

    const results = await rerankResults('anything', [], provider);

    expect(results).toEqual([]);
    // Should NOT call the LLM for empty candidates
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('falls back to original scores when LLM call fails', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Wife likes sushi', originalScore: 0.7 },
      { id: 'mem-2', content: 'Lives in Dublin', originalScore: 0.6 },
      { id: 'mem-3', content: 'Works at Google', originalScore: 0.5 },
    ];

    const provider = createFailingProvider('API rate limit exceeded');

    const results = await rerankResults("wife's food preferences", candidates, provider);

    // Should return results with original scores as finalScore
    expect(results).toHaveLength(3);

    // When LLM fails, finalScore should equal originalScore (graceful fallback)
    for (const result of results) {
      const candidate = candidates.find(c => c.id === result.id)!;
      expect(result.finalScore).toBe(candidate.originalScore);
      expect(result.originalScore).toBe(candidate.originalScore);
    }

    // Should be sorted by finalScore (which is originalScore here)
    expect(results[0].id).toBe('mem-1');
    expect(results[1].id).toBe('mem-2');
    expect(results[2].id).toBe('mem-3');
  });

  it('truncates to maxCandidates before LLM call', async () => {
    // Create 25 candidates (> default maxCandidates of 20)
    const candidates: RerankCandidate[] = Array.from({ length: 25 }, (_, i) => ({
      id: `mem-${i}`,
      content: `Memory item ${i}`,
      originalScore: 1 - i * 0.03, // Descending scores from 1.0 to 0.28
    }));

    // LLM response for 20 candidates (truncated)
    const llmScores = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      score: 0.5,
    }));
    const provider = createMockProvider(JSON.stringify(llmScores));

    const results = await rerankResults('test query', candidates, provider);

    // Verify the LLM was called with only 20 candidates
    const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletionRequest;
    const userMessage = callArgs.messages[0].content as string;

    // Count numbered candidates in the prompt (look for pattern like "1." through "20.")
    const candidateMatches = userMessage.match(/^\d+\./gm);
    expect(candidateMatches).toHaveLength(20);

    // Results should only include the top 20 candidates
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('falls back to original scores when LLM returns malformed JSON', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Wife likes sushi', originalScore: 0.7 },
      { id: 'mem-2', content: 'Lives in Dublin', originalScore: 0.6 },
    ];

    // Return malformed JSON
    const provider = createMockProvider('This is not valid JSON at all {broken');

    const results = await rerankResults("wife's food preferences", candidates, provider);

    // Should gracefully fall back to original scores
    expect(results).toHaveLength(2);
    for (const result of results) {
      const candidate = candidates.find(c => c.id === result.id)!;
      expect(result.finalScore).toBe(candidate.originalScore);
    }
  });

  it('re-ranks a single candidate', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Wife likes sushi', originalScore: 0.7 },
    ];

    const llmResponse = JSON.stringify([{ index: 0, score: 0.95 }]);
    const provider = createMockProvider(llmResponse);

    const results = await rerankResults("wife's food preferences", candidates, provider);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
    expect(results[0].relevanceScore).toBeCloseTo(0.95, 2);
    // finalScore = (0.7 * 0.4) + (0.95 * 0.6) = 0.28 + 0.57 = 0.85
    expect(results[0].finalScore).toBeCloseTo(0.85, 2);
  });

  it('applies correct score blending formula', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Test memory', originalScore: 0.8 },
    ];

    const llmResponse = JSON.stringify([{ index: 0, score: 0.6 }]);
    const provider = createMockProvider(llmResponse);

    const results = await rerankResults('test', candidates, provider);

    // finalScore = (originalScore * 0.4) + (llmRelevanceScore * 0.6)
    // = (0.8 * 0.4) + (0.6 * 0.6) = 0.32 + 0.36 = 0.68
    expect(results[0].finalScore).toBeCloseTo(0.68, 2);
    expect(results[0].originalScore).toBe(0.8);
    expect(results[0].relevanceScore).toBeCloseTo(0.6, 2);
  });

  it('drops results with finalScore below threshold (0.05)', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Relevant memory', originalScore: 0.7 },
      { id: 'mem-2', content: 'Totally irrelevant', originalScore: 0.05 },
      { id: 'mem-3', content: 'Also irrelevant', originalScore: 0.01 },
    ];

    const llmResponse = JSON.stringify([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.0 },  // finalScore = (0.05 * 0.4) + (0.0 * 0.6) = 0.02 → below threshold
      { index: 2, score: 0.0 },  // finalScore = (0.01 * 0.4) + (0.0 * 0.6) = 0.004 → below threshold
    ]);

    const provider = createMockProvider(llmResponse);

    const results = await rerankResults('relevant query', candidates, provider);

    // Only mem-1 should survive (finalScore = 0.82)
    // mem-2 finalScore = 0.02 (below 0.05 threshold) → dropped
    // mem-3 finalScore = 0.004 (below 0.05 threshold) → dropped
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
  });

  it('uses low temperature (0.1) for consistency', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Test memory', originalScore: 0.5 },
    ];

    const llmResponse = JSON.stringify([{ index: 0, score: 0.5 }]);
    const provider = createMockProvider(llmResponse);

    await rerankResults('test', candidates, provider);

    const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletionRequest;
    expect(callArgs.temperature).toBe(0.1);
  });

  it('sends system prompt instructing scoring on 0.0-1.0 scale', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Test memory', originalScore: 0.5 },
    ];

    const llmResponse = JSON.stringify([{ index: 0, score: 0.5 }]);
    const provider = createMockProvider(llmResponse);

    await rerankResults('test', candidates, provider);

    const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletionRequest;
    expect(callArgs.system).toBeDefined();
    expect(callArgs.system).toContain('0.0');
    expect(callArgs.system).toContain('1.0');
  });

  it('respects custom maxCandidates option', async () => {
    const candidates: RerankCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      id: `mem-${i}`,
      content: `Memory item ${i}`,
      originalScore: 1 - i * 0.1,
    }));

    const llmScores = Array.from({ length: 5 }, (_, i) => ({
      index: i,
      score: 0.5,
    }));
    const provider = createMockProvider(JSON.stringify(llmScores));

    const results = await rerankResults('test', candidates, provider, { maxCandidates: 5 });

    // Should only process 5 candidates
    const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletionRequest;
    const userMessage = callArgs.messages[0].content as string;
    const candidateMatches = userMessage.match(/^\d+\./gm);
    expect(candidateMatches).toHaveLength(5);
  });

  it('handles LLM returning partial scores (fewer than candidates)', async () => {
    const candidates: RerankCandidate[] = [
      { id: 'mem-1', content: 'Memory A', originalScore: 0.7 },
      { id: 'mem-2', content: 'Memory B', originalScore: 0.6 },
      { id: 'mem-3', content: 'Memory C', originalScore: 0.5 },
    ];

    // LLM only returns scores for 2 of 3 candidates
    const llmResponse = JSON.stringify([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.3 },
      // index 2 missing
    ]);

    const provider = createMockProvider(llmResponse);

    const results = await rerankResults('test', candidates, provider);

    // All 3 should still be in results
    // mem-3 should use originalScore as fallback since LLM didn't score it
    expect(results).toHaveLength(3);
    const mem3 = results.find(r => r.id === 'mem-3')!;
    expect(mem3).toBeDefined();
    expect(mem3.finalScore).toBe(0.5); // originalScore used as fallback
  });
});
