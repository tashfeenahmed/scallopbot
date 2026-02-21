/**
 * MMR (Maximal Marginal Relevance) for Memory Search Diversity
 *
 * Reduces redundancy in search results by balancing relevance with diversity.
 * Uses Jaccard similarity on tokenized text as a lightweight diversity measure.
 */

/**
 * Tokenize text into a set of lowercase words for similarity comparison.
 */
export function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0);
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|
 * Returns 0 if both sets are empty.
 */
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const item of smaller) {
    if (larger.has(item)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export interface MMROptions {
  /** Balance between relevance (1.0) and diversity (0.0). Default: 0.7 */
  lambda?: number;
  /** Minimum results before applying MMR (skip for tiny result sets). Default: 3 */
  minResultsForMMR?: number;
}

export interface MMRItem<T> {
  item: T;
  score: number;
  getText: () => string;
}

/**
 * Apply Maximal Marginal Relevance to reorder results.
 *
 * Algorithm:
 * 1. Normalize scores to [0,1]
 * 2. Select highest-scoring item first
 * 3. For each remaining: mmrScore = lambda * relevance - (1-lambda) * maxSimilarityToSelected
 * 4. Select highest mmrScore, repeat
 *
 * @returns Items reordered by MMR score
 */
export function applyMMR<T>(
  results: MMRItem<T>[],
  options: MMROptions = {}
): MMRItem<T>[] {
  const { lambda = 0.7, minResultsForMMR = 3 } = options;

  if (results.length < minResultsForMMR) {
    return results;
  }

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...results.map(r => r.score));
  const minScore = Math.min(...results.map(r => r.score));
  const scoreRange = maxScore - minScore;

  const candidates = results.map(r => ({
    ...r,
    normalizedScore: scoreRange > 0 ? (r.score - minScore) / scoreRange : 1,
    tokens: tokenize(r.getText()),
  }));

  const selected: typeof candidates = [];
  const remaining = new Set(candidates.map((_, i) => i));

  // Select highest-scoring item first
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    if (candidates[idx].normalizedScore > bestScore) {
      bestScore = candidates[idx].normalizedScore;
      bestIdx = idx;
    }
  }
  selected.push(candidates[bestIdx]);
  remaining.delete(bestIdx);

  // Iteratively select remaining items by MMR score
  while (remaining.size > 0) {
    let bestMMRScore = -Infinity;
    let bestMMRIdx = -1;

    for (const idx of remaining) {
      const candidate = candidates[idx];
      const relevance = candidate.normalizedScore;

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.tokens, sel.tokens);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestMMRIdx = idx;
      }
    }

    if (bestMMRIdx >= 0) {
      selected.push(candidates[bestMMRIdx]);
      remaining.delete(bestMMRIdx);
    } else {
      break;
    }
  }

  // Return in MMR order with original scores preserved
  return selected.map(s => ({
    item: s.item,
    score: s.score,
    getText: s.getText,
  }));
}
