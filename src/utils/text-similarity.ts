/**
 * Shared text similarity utilities.
 *
 * Word-overlap metric used for deduplication across gap pipeline,
 * goal deadline checks, and scheduled item comparisons.
 */

/** Word overlap threshold for deduplication */
export const DEDUP_OVERLAP_THRESHOLD = 0.8;
export const SEMANTIC_TOPIC_OVERLAP_THRESHOLD = 0.75;

const TOPIC_STOP_WORDS = new Set([
  'about', 'again', 'any', 'anything', 'check', 'checking', 'did', 'follow', 'followup', 'happen',
  'happened', 'just', 'latest', 'message', 'need', 'needed', 'nudge', 'please',
  'project', 'recap', 'remind', 'reminder', 'rollout', 'status', 'task', 'today', 'tomorrow',
  'update', 'user', 'want', 'wanted', 'with', 'would', 'your',
]);

const TOPIC_ALIASES: Record<string, string> = {
  dental: 'dentist', dentist: 'dentist',
  exercise: 'workout', gym: 'workout', training: 'workout', workout: 'workout',
  medication: 'medicine', medications: 'medicine', meds: 'medicine',
  deploy: 'release', deployed: 'release', deployment: 'release', launch: 'release', shipping: 'release',
  flight: 'travel', trip: 'travel', travelling: 'travel', traveling: 'travel',
  appointment: 'appointment', meeting: 'appointment', visit: 'appointment',
  confirm: 'confirmation', confirmed: 'confirmation', verify: 'confirmation',
};

function topicTokens(text: string): Set<string> {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = raw.flatMap((word) => {
    if (word.length < 3 || TOPIC_STOP_WORDS.has(word)) return [];
    let token = TOPIC_ALIASES[word] ?? word;
    if (!TOPIC_ALIASES[word] && token.length > 5 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
    else if (!TOPIC_ALIASES[word] && token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3);
    else if (!TOPIC_ALIASES[word] && token.length > 4 && token.endsWith('ed')) token = token.slice(0, -2);
    else if (!TOPIC_ALIASES[word] && token.length > 4 && token.endsWith('s')) token = token.slice(0, -1);
    return TOPIC_STOP_WORDS.has(token) ? [] : [TOPIC_ALIASES[token] ?? token];
  });
  return new Set(tokens);
}

/**
 * Lightweight semantic topic overlap for proactive deduplication. It removes
 * generic outreach wording and canonicalizes a small set of common concepts,
 * so rephrases such as “Atlas rollout” / “update on Atlas” share an identity even
 * when ordinary word overlap is low.
 */
export function semanticTopicOverlap(a: string, b: string): number {
  const wordsA = topicTokens(a);
  const wordsB = topicTokens(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection++;
  return intersection / Math.min(wordsA.size, wordsB.size);
}

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
