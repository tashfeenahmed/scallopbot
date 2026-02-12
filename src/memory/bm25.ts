/**
 * BM25 scoring for keyword-based search
 */

/**
 * Shared search weights used across all hybrid search paths.
 * keyword + semantic + prominence must sum to 1.0.
 */
export const SEARCH_WEIGHTS = {
  keyword: 0.3,
  semantic: 0.7,
  prominence: 0.0,
} as const;

/**
 * Common English stop words + question words that waste BM25 weight.
 * Filtering these sharpens keyword discrimination for queries like
 * "What did Caroline research?" → ["caroline", "research"].
 */
const STOP_WORDS = new Set([
  // Articles & determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  // Pronouns
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'it', 'its', 'they', 'them', 'their',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'into', 'about', 'between', 'through', 'after', 'before', 'during',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet',
  // Auxiliary / common verbs
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
  // Question words
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  // Other function words
  'not', 'no', 'if', 'then', 'than', 'too', 'very', 'just',
  'also', 'there', 'here', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
]);

/** Filter tokens by removing stop words */
function removeStopWords(tokens: string[]): string[] {
  const filtered = tokens.filter(t => !STOP_WORDS.has(t));
  // If ALL tokens are stop words, return original to avoid empty queries
  return filtered.length > 0 ? filtered : tokens;
}

export interface BM25Options {
  avgDocLength: number;
  docCount: number;
  k1?: number;
  b?: number;
  /** Document frequency map: term -> number of documents containing that term */
  docFreq?: Map<string, number>;
}

/**
 * Build a document frequency map from an array of text documents.
 * Counts how many documents contain each unique term.
 */
export function buildDocFreqMap(documents: string[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const doc of documents) {
    const uniqueTerms = new Set(removeStopWords(doc.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 0)));
    for (const term of uniqueTerms) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }
  return docFreq;
}

/**
 * Calculate BM25 score for a query against a document
 */
export function calculateBM25Score(
  query: string,
  document: string,
  options: BM25Options
): number {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;

  const queryTerms = removeStopWords(query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 0));
  const docTerms = removeStopWords(document.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 0));
  const docLength = docTerms.length;

  // Calculate term frequencies
  const docTermFreq = new Map<string, number>();
  for (const term of docTerms) {
    docTermFreq.set(term, (docTermFreq.get(term) || 0) + 1);
  }

  let score = 0;

  for (const term of queryTerms) {
    const tf = docTermFreq.get(term) || 0;
    if (tf === 0) continue;

    // IDF: use actual document frequency when available
    const df = options.docFreq?.get(term) ?? 1;
    const idf = Math.log((options.docCount - df + 0.5) / (df + 0.5) + 1);

    // BM25 term score
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / options.avgDocLength));

    score += idf * (numerator / denominator);
  }

  return score;
}
