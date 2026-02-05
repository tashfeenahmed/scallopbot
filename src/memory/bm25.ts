/**
 * BM25 scoring for keyword-based search
 */

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
    const uniqueTerms = new Set(doc.toLowerCase().split(/\s+/));
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

  const queryTerms = query.toLowerCase().split(/\s+/);
  const docTerms = document.toLowerCase().split(/\s+/);
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
