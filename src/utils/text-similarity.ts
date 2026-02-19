/**
 * Shared text similarity utilities.
 *
 * Word-overlap metric used for deduplication across gap pipeline,
 * goal deadline checks, and scheduled item comparisons.
 */

/** Word overlap threshold for deduplication */
export const DEDUP_OVERLAP_THRESHOLD = 0.8;

/**
 * Compute word overlap ratio between two messages.
 * |intersection| / |smaller set| on lowercase word sets.
 *
 * @param a - First string
 * @param b - Second string
 * @param options - Optional configuration
 * @param options.minWordLength - Minimum word length to include (default: 3)
 */
export function wordOverlap(
  a: string,
  b: string,
  options?: { minWordLength?: number },
): number {
  const minLen = options?.minWordLength ?? 3;

  const wordsA = new Set(
    a.toLowerCase().split(/\s+/).filter((w) => w.length >= minLen),
  );
  const wordsB = new Set(
    b.toLowerCase().split(/\s+/).filter((w) => w.length >= minLen),
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersectionCount = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionCount++;
  }

  const smallerSize = Math.min(wordsA.size, wordsB.size);
  return intersectionCount / smallerSize;
}
