/**
 * A small, dependency-free locality-sensitive hash (LSH) for memory embeddings.
 *
 * Why this exists instead of a native ANN extension:
 * - Smartbot targets Raspberry Pi, where native SQLite/vector extensions are
 *   frequently unavailable or difficult to install.
 * - Embeddings are stored as JSON today. Parsing every 768-dimensional vector
 *   on every query has unbounded latency and heap usage.
 * - LSH gives SQLite an ordinary integer index to query. Only a bounded set of
 *   likely neighbours is then parsed and scored with exact cosine similarity.
 *
 * Each table is a six-bit sparse random-hyperplane signature. Twelve tables
 * provide independent chances for nearby vectors to collide. One deterministic
 * Hamming-distance-one probe per table improves recall without the candidate
 * explosion caused by probing every neighbouring bucket.
 */

export const SEMANTIC_LSH_VERSION = 1;
export const SEMANTIC_LSH_TABLES = 12;
export const SEMANTIC_LSH_BITS = 6;
export const SEMANTIC_LSH_COMPONENTS_PER_BIT = 8;

/** Maximum vectors parsed/exactly scored for the semantic branch of a query. */
export const SEMANTIC_CANDIDATE_LIMIT = 384;

export interface SemanticLshBucket {
  tableId: number;
  bucket: number;
}

export interface SemanticLshProbe extends SemanticLshBucket {
  /** Exact buckets rank above the single Hamming-neighbour probe. */
  weight: number;
}

interface ProjectionPlan {
  indices: Uint32Array;
  signs: Int8Array;
}

const projectionPlans = new Map<number, ProjectionPlan>();

/** A deterministic 32-bit mixer; stable across Node versions and platforms. */
function mix32(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function getProjectionPlan(dimension: number): ProjectionPlan {
  const existing = projectionPlans.get(dimension);
  if (existing) return existing;

  const projectionCount =
    SEMANTIC_LSH_TABLES * SEMANTIC_LSH_BITS * SEMANTIC_LSH_COMPONENTS_PER_BIT;
  const indices = new Uint32Array(projectionCount);
  const signs = new Int8Array(projectionCount);

  for (let i = 0; i < projectionCount; i++) {
    // Separate mixers avoid correlating a selected coordinate with its sign.
    indices[i] = mix32(0x51f15e5 ^ i) % dimension;
    signs[i] = (mix32(0x1b873593 ^ i) & 1) === 0 ? -1 : 1;
  }

  const plan = { indices, signs };
  projectionPlans.set(dimension, plan);
  return plan;
}

/**
 * Compute the indexed signatures for an embedding.
 *
 * Work is constant with respect to corpus size and only 576 vector component
 * reads for the default 12 x 6 x 8 layout, including 768-dimensional vectors.
 */
export function computeSemanticLshBuckets(embedding: readonly number[]): SemanticLshBucket[] {
  if (embedding.length === 0) return [];

  const plan = getProjectionPlan(embedding.length);
  const buckets: SemanticLshBucket[] = [];
  let planOffset = 0;

  for (let tableId = 0; tableId < SEMANTIC_LSH_TABLES; tableId++) {
    let bucket = 0;
    for (let bit = 0; bit < SEMANTIC_LSH_BITS; bit++) {
      let projection = 0;
      for (let component = 0; component < SEMANTIC_LSH_COMPONENTS_PER_BIT; component++) {
        projection += embedding[plan.indices[planOffset]] * plan.signs[planOffset];
        planOffset++;
      }
      if (projection > 0) bucket |= 1 << bit;
    }
    buckets.push({ tableId, bucket });
  }

  return buckets;
}

/** Exact buckets plus one bounded Hamming-distance-one probe per table. */
export function buildSemanticLshProbes(embedding: readonly number[]): SemanticLshProbe[] {
  return computeSemanticLshBuckets(embedding).flatMap(({ tableId, bucket }) => {
    // Rotate the probed bit across tables so all signature positions receive
    // coverage without multiplying the query by all six neighbours.
    const neighbourBit = tableId % SEMANTIC_LSH_BITS;
    return [
      { tableId, bucket, weight: 2 },
      { tableId, bucket: bucket ^ (1 << neighbourBit), weight: 1 },
    ];
  });
}
