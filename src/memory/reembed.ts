/**
 * Re-embed memories and session summaries into the active embedding space.
 *
 * A row is "stale" when it has no vector (current memories only) or its
 * vector is tagged with a different embedding model key. Work is done in
 * keyset-paginated batches and each row is committed as soon as it is
 * embedded, so an interrupted run resumes naturally: the next run only sees
 * rows that are still stale.
 */

import type { ScallopDatabase } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';

export interface ReembedProgress {
  phase: 'memories' | 'summaries';
  /** Rows embedded so far in this phase. */
  embedded: number;
  /** Rows that failed (left stale; retried on the next run). */
  failed: number;
  /** Stale rows counted for this phase when the run started. */
  total: number;
}

export interface ReembedOptions {
  /** Texts per embedBatch call (default 16). */
  batchSize?: number;
  /** Stop after this many rows across both phases (default: no limit). */
  limit?: number;
  /** Re-embed vectors from another model (default true). */
  includeStale?: boolean;
  /** Embed current memories that have no vector at all (default true). */
  includeMissing?: boolean;
  /** Also process session summaries (default true). */
  includeSummaries?: boolean;
  /** Abort after this many consecutive fully failed batches (default 3). */
  maxConsecutiveFailedBatches?: number;
  onProgress?: (progress: ReembedProgress) => void;
  signal?: AbortSignal;
}

export interface ReembedResult {
  memories: { embedded: number; failed: number };
  summaries: { embedded: number; failed: number };
  /** True when the run ended early (limit, abort, or provider failing). */
  incomplete: boolean;
  error?: string;
}

const MAX_CHARS_PER_TEXT = 8_000;

async function embedRows<T>(
  embedder: EmbeddingProvider,
  rows: T[],
  text: (row: T) => string,
): Promise<Array<number[] | null>> {
  const texts = rows.map(row => text(row).slice(0, MAX_CHARS_PER_TEXT));
  try {
    const vectors = await embedder.embedBatch(texts);
    if (vectors.length === rows.length) return vectors;
  } catch {
    // Fall through to per-row attempts so one bad input cannot sink a batch.
  }
  const results: Array<number[] | null> = [];
  for (const value of texts) {
    try {
      results.push(await embedder.embed(value));
    } catch {
      results.push(null);
    }
  }
  return results;
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(n => typeof n === 'number' && Number.isFinite(n));
}

export async function reembedStale(
  db: ScallopDatabase,
  embedder: EmbeddingProvider,
  key: string,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const batchSize = Math.max(1, Math.min(256, options.batchSize ?? 16));
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const maxFailedBatches = options.maxConsecutiveFailedBatches ?? 3;
  const result: ReembedResult = {
    memories: { embedded: 0, failed: 0 },
    summaries: { embedded: 0, failed: 0 },
    incomplete: false,
  };
  const counts = db.countStaleEmbeddings(key);
  let processed = 0;
  let failedBatches = 0;
  let dimension: number | undefined;

  const stop = (reason?: string): boolean => {
    if (options.signal?.aborted) {
      result.incomplete = true;
      result.error ??= 'aborted';
      return true;
    }
    if (processed >= limit) {
      result.incomplete = true;
      return true;
    }
    if (reason) {
      result.incomplete = true;
      result.error = reason;
      return true;
    }
    return false;
  };

  const accept = (vector: number[] | null): vector is number[] => {
    if (!isVector(vector)) return false;
    dimension ??= vector.length;
    // One key must map to one dimension; anything else is a provider bug.
    return vector.length === dimension;
  };

  const onBatch = (ok: number, total: number): string | undefined => {
    if (ok === 0 && total > 0) {
      failedBatches++;
      if (failedBatches >= maxFailedBatches) {
        return `embedding provider failed ${failedBatches} batches in a row; re-run to resume`;
      }
    } else {
      failedBatches = 0;
    }
    return undefined;
  };

  // ── Memories ──
  if (options.includeStale !== false || options.includeMissing !== false) {
    let cursor = '';
    while (!stop()) {
      const take = Math.min(batchSize, limit - processed);
      const rows = db.getStaleEmbeddingMemories(key, cursor, take, {
        includeStale: options.includeStale,
        includeMissing: options.includeMissing,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      const vectors = await embedRows(embedder, rows, row => row.content);
      let ok = 0;
      rows.forEach((row, index) => {
        const vector = vectors[index];
        if (accept(vector)) {
          db.setMemoryEmbedding(row.id, row.userId, vector, key);
          ok++;
        }
      });
      processed += rows.length;
      result.memories.embedded += ok;
      result.memories.failed += rows.length - ok;
      options.onProgress?.({ phase: 'memories', ...result.memories, total: counts.memories });
      if (stop(onBatch(ok, rows.length))) break;
    }
  }

  // ── Session summaries ──
  if (options.includeSummaries !== false && !result.incomplete) {
    let cursor = '';
    while (!stop()) {
      const take = Math.min(batchSize, limit - processed);
      const rows = db.getStaleEmbeddingSummaries(key, cursor, take);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      const vectors = await embedRows(embedder, rows, row => row.summary);
      let ok = 0;
      rows.forEach((row, index) => {
        const vector = vectors[index];
        if (accept(vector)) {
          db.setSessionSummaryEmbedding(row.id, vector, key);
          ok++;
        }
      });
      processed += rows.length;
      result.summaries.embedded += ok;
      result.summaries.failed += rows.length - ok;
      options.onProgress?.({ phase: 'summaries', ...result.summaries, total: counts.summaries });
      if (stop(onBatch(ok, rows.length))) break;
    }
  }

  return result;
}
