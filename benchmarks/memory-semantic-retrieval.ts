/**
 * Reproducible semantic retrieval benchmark.
 *
 * Run with:
 *   node --expose-gc --import tsx benchmarks/memory-semantic-retrieval.ts
 *
 * It creates 10,000 JSON embeddings with the common 768 dimensions and compares
 * only the semantic candidate/exact-scoring stage. BM25 work is common to all
 * three production designs and is prepared once:
 *   legacy   - semantic scoring gated by lexical top-50 (fast, loses paraphrases)
 *   fullScan - independent semantic union that parses every vector (unbounded)
 *   indexed  - SQLite LSH candidates unioned with lexical top-50 (bounded)
 */

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { ScallopDatabase } from '../src/memory/db.js';
import { calculateBM25Score, buildDocFreqMap } from '../src/memory/bm25.js';
import { cosineSimilarity } from '../src/memory/embeddings.js';
import { SEMANTIC_CANDIDATE_LIMIT } from '../src/memory/semantic-index.js';

const DB_PATH = join(tmpdir(), `scallop-semantic-retrieval-benchmark-${process.pid}.db`);
const CORPUS_SIZE = 10_000;
const DIMENSION = 768;
const ROUNDS = 7;

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      // File does not exist.
    }
  }
}

/** Deterministic, dense, three-decimal embedding without retaining the corpus. */
function vector(seed: number): number[] {
  let state = seed >>> 0;
  return Array.from({ length: DIMENSION }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.round((state / 0xffffffff * 2 - 1) * 1000) / 1000;
  });
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024 * 100) / 100;
}

interface Sample {
  elapsedMs: number;
  candidateLookupMs: number;
  vectorLoadAndScoreMs: number;
  heapDeltaBytes: number;
  candidatesParsed: number;
  targetRecovered: boolean;
}

function samplePath(
  db: ScallopDatabase,
  getIds: () => string[],
  query: number[],
  targetId: string,
): Sample {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const ids = getIds();
  const candidatesReady = performance.now();
  const embeddings = db.getEmbeddingsByIds(ids);
  let bestId = '';
  let bestScore = -Infinity;
  for (const [id, embedding] of embeddings) {
    const score = cosineSimilarity(query, embedding);
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  const elapsedMs = performance.now() - started;
  const candidateLookupMs = candidatesReady - started;
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const result = {
    elapsedMs,
    candidateLookupMs,
    vectorLoadAndScoreMs: elapsedMs - candidateLookupMs,
    heapDeltaBytes,
    candidatesParsed: embeddings.size,
    targetRecovered: bestId === targetId,
  };
  embeddings.clear();
  return result;
}

function summarize(samples: Sample[]): Record<string, number | boolean> {
  return {
    candidatesParsed: samples[0].candidatesParsed,
    targetRecall: samples.filter((sample) => sample.targetRecovered).length / samples.length,
    latencyP50Ms: Math.round(percentile(samples.map((sample) => sample.elapsedMs), 0.5) * 100) / 100,
    latencyP95Ms: Math.round(percentile(samples.map((sample) => sample.elapsedMs), 0.95) * 100) / 100,
    candidateLookupP50Ms: Math.round(
      percentile(samples.map((sample) => sample.candidateLookupMs), 0.5) * 100,
    ) / 100,
    vectorLoadAndScoreP50Ms: Math.round(
      percentile(samples.map((sample) => sample.vectorLoadAndScoreMs), 0.5) * 100,
    ) / 100,
    retainedHeapMbMedian: mb(percentile(samples.map((sample) => sample.heapDeltaBytes), 0.5)),
    retainedHeapMbMax: mb(Math.max(...samples.map((sample) => sample.heapDeltaBytes))),
  };
}

cleanup();

// Create the current schema, then emulate a pre-index database so the benchmark
// also records the one-time migration cost and on-disk index overhead.
new ScallopDatabase(DB_PATH).close();
const sqlite = new Database(DB_PATH);
const insert = sqlite.prepare(`
  INSERT INTO memories (
    id, user_id, content, category, memory_type, importance, confidence,
    is_latest, source, document_date, event_date, prominence, last_accessed,
    access_count, source_chunk, embedding, metadata, learned_from,
    times_confirmed, contradiction_ids, created_at, updated_at
  ) VALUES (?, 'default', ?, 'fact', 'regular', 5, 0.8, 1, 'user', ?, NULL,
            1, NULL, 0, NULL, ?, NULL, 'conversation', 1, NULL, ?, ?)
`);
const insertCorpus = sqlite.transaction(() => {
  const now = Date.now() - CORPUS_SIZE;
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const content = i === CORPUS_SIZE - 1
      ? 'The canine companion sleeps beside the fireplace'
      : `keyword inventory decoy ${i}`;
    insert.run(`memory-${i}`, content, now + i, JSON.stringify(vector(i + 1)), now + i, now + i);
  }
});
insertCorpus();
sqlite.close();

const unindexedBytes = fs.statSync(DB_PATH).size;
const backfillStarted = performance.now();
let db = new ScallopDatabase(DB_PATH);
const backfillMs = performance.now() - backfillStarted;
db.close();
const indexedBytes = fs.statSync(DB_PATH).size;
db = new ScallopDatabase(DB_PATH);

const memories = db.getMemoriesByUserLight('default', {
  minProminence: 0,
  isLatest: true,
  includeAllSources: true,
});
const texts = memories.map((memory) => memory.content);
const bm25Options = {
  avgDocLength: texts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) / texts.length,
  docCount: texts.length,
  docFreq: buildDocFreqMap(texts),
};
const lexicalIds = memories
  .map((memory) => ({
    id: memory.id,
    score: calculateBM25Score('keyword', memory.content.toLowerCase(), bm25Options),
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 50)
  .map(({ id }) => id);

const targetId = `memory-${CORPUS_SIZE - 1}`;
const query = vector(CORPUS_SIZE);
const allIds = memories.map((memory) => memory.id);
const eligibleMemories = new Map(memories.map((memory) => [memory.id, memory]));

// Candidate-recall audit for realistic paraphrase similarity rather than only
// an identical query vector. Blending independent dense vectors at 0.85 keeps
// the source as the exact nearest neighbour while perturbing its LSH signature.
let indexedNeighbourHits = 0;
let legacyNeighbourHits = 0;
let similaritySum = 0;
let candidateCountSum = 0;
const qualityQueries = 100;
for (let i = 0; i < qualityQueries; i++) {
  const targetIndex = 100 + i * 91;
  const target = vector(targetIndex + 1);
  const noise = vector(100_000 + i);
  const neighbourQuery = target.map((value, dimension) =>
    value * 0.85 + noise[dimension] * Math.sqrt(1 - 0.85 ** 2));
  const candidates = db.getSemanticCandidateIds(neighbourQuery, {
    userId: 'default',
    minProminence: 0,
    isLatest: true,
    maxCandidates: SEMANTIC_CANDIDATE_LIMIT,
    eligibleIds: eligibleMemories,
    candidatePriorities: eligibleMemories,
  });
  const neighbourTargetId = `memory-${targetIndex}`;
  if (candidates.includes(neighbourTargetId)) indexedNeighbourHits++;
  if (lexicalIds.includes(neighbourTargetId)) legacyNeighbourHits++;
  similaritySum += cosineSimilarity(target, neighbourQuery);
  candidateCountSum += candidates.length;
}

const paths = {
  legacy: () => lexicalIds,
  fullScan: () => allIds,
  indexed: () => [...new Set([
    ...db.getSemanticCandidateIds(query, {
      userId: 'default',
      minProminence: 0,
      isLatest: true,
      maxCandidates: SEMANTIC_CANDIDATE_LIMIT,
      eligibleIds: eligibleMemories,
      candidatePriorities: eligibleMemories,
    }),
    ...lexicalIds,
  ])],
};
const results: Record<string, Record<string, number | boolean>> = {};
const pathEntries = Object.entries(paths);
const samplesByPath = new Map(pathEntries.map(([name]) => [name, [] as Sample[]]));

// Measure steady-state retrieval: warm every path once, then rotate execution
// order each round. This prevents either SQLite page-cache warmth or temporary
// machine load from consistently favouring the path that happens to run last.
for (const [, getIds] of pathEntries) samplePath(db, getIds, query, targetId);
for (let round = 0; round < ROUNDS; round++) {
  for (let offset = 0; offset < pathEntries.length; offset++) {
    const [name, getIds] = pathEntries[(round + offset) % pathEntries.length];
    samplesByPath.get(name)!.push(samplePath(db, getIds, query, targetId));
  }
}
for (const [name] of pathEntries) {
  results[name] = summarize(samplesByPath.get(name)!);
}

const latencySpeedup = Math.round(
  Number(results.fullScan.latencyP50Ms) / Number(results.indexed.latencyP50Ms) * 100,
) / 100;
const heapReduction = Math.round(
  Number(results.fullScan.retainedHeapMbMedian) /
  Math.max(0.01, Number(results.indexed.retainedHeapMbMedian)) * 100,
) / 100;
const indexedNoisyRecall = indexedNeighbourHits / qualityQueries;
const validation = {
  minimumLatencySpeedup: 2,
  minimumHeapReduction: 2,
  minimumNoisyRecall: 0.95,
  exactTargetRecallRequired: 1,
};
const validationPassed =
  latencySpeedup >= validation.minimumLatencySpeedup &&
  heapReduction >= validation.minimumHeapReduction &&
  indexedNoisyRecall >= validation.minimumNoisyRecall &&
  Number(results.indexed.targetRecall) === validation.exactTargetRecallRequired;

const output = {
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    corpusSize: CORPUS_SIZE,
    embeddingDimension: DIMENSION,
    rounds: ROUNDS,
    explicitGc: Boolean(global.gc),
  },
  migration: {
    oneTimeBackfillMs: Math.round(backfillMs * 100) / 100,
    unindexedDatabaseMb: mb(unindexedBytes),
    indexedDatabaseMb: mb(indexedBytes),
    lshIndexOverheadMb: mb(indexedBytes - unindexedBytes),
  },
  results,
  quality: {
    queries: qualityQueries,
    averageTargetCosine: Math.round(similaritySum / qualityQueries * 1000) / 1000,
    legacyCandidateRecall: legacyNeighbourHits / qualityQueries,
    fullScanCandidateRecall: 1,
    indexedCandidateRecall: indexedNoisyRecall,
    averageIndexedCandidates: Math.round(candidateCountSum / qualityQueries),
  },
  improvement: {
    versusFullScanLatencyP50: latencySpeedup,
    versusFullScanRetainedHeap: heapReduction,
  },
  validation: { ...validation, passed: validationPassed },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
db.close();
cleanup();
if (!validationPassed) process.exitCode = 1;
