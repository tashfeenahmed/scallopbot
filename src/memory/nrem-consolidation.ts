/**
 * NREM Consolidation Module
 *
 * Relation-context-enriched fusion for deep sleep consolidation.
 * Extends the fusion.ts pipeline with:
 * - Wider prominence window [0.05, 0.8) — catches fading and fresh memories
 * - Cross-category clustering (via findFusionClusters crossCategory flag)
 * - Relation context in LLM prompts — tells the LLM *why* memories connect
 *
 * Pure functions following the fusion.ts pattern:
 * - No DB access — caller provides memories and getRelations callback
 * - LLMProvider passed as argument, not constructor injection
 * - Graceful null return on any LLM error (per-cluster isolation)
 *
 * Pipeline: findFusionClusters() → buildRelationContext() → buildFusionPrompt(cluster, ctx) → LLM → NremResult
 */

import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider } from '../providers/types.js';
import { findFusionClusters, buildFusionPrompt, parseFusionResponse, type RelationContextEntry } from './fusion.js';

// Re-export RelationContextEntry for backward compatibility
export type { RelationContextEntry } from './fusion.js';

// ============ Types ============

/** Configuration for NREM consolidation */
export interface NremConfig {
  /** Minimum prominence for NREM candidates (default: 0.05) */
  minProminence: number;
  /** Maximum prominence for NREM candidates (default: 0.8) */
  maxProminence: number;
  /** Maximum clusters to process per NREM cycle (default: 10) */
  maxClusters: number;
  /** Minimum cluster size (default: 3) */
  minClusterSize: number;
  /** Maximum relations per memory in context (default: 3) */
  maxRelationsPerMemory: number;
}

/** Default NREM configuration */
export const DEFAULT_NREM_CONFIG: NremConfig = {
  minProminence: 0.05,
  maxProminence: 0.8,
  maxClusters: 10,
  minClusterSize: 3,
  maxRelationsPerMemory: 3,
};

/** Result of a single NREM fusion */
export interface NremFusionResult {
  /** Consolidated summary text */
  summary: string;
  /** Max importance from source memories */
  importance: number;
  /** Category — 'insight' for cross-category clusters */
  category: MemoryCategory;
  /** Min confidence from source memories (conservative) */
  confidence: number;
  /** Marker distinguishing NREM from daytime consolidation */
  learnedFrom: 'nrem_consolidation';
  /** IDs of source memories that were fused */
  sourceMemoryIds: string[];
}

/** Overall result of NREM consolidation */
export interface NremResult {
  /** Total number of clusters found and attempted */
  clustersProcessed: number;
  /** Successful fusion results */
  fusionResults: NremFusionResult[];
  /** Number of clusters that failed to fuse */
  failures: number;
}

// ============ Relation Context ============

/**
 * Build relation context for a cluster of memories.
 *
 * Iterates each memory in the cluster, fetches its relations, and filters
 * to only intra-cluster relations (relations where both endpoints are in
 * the cluster). Caps at maxPerMemory relations per source memory.
 *
 * Pure function — uses getRelations callback, no DB access.
 *
 * @param cluster - Array of memories forming a cluster
 * @param getRelations - Callback to get relations for a memory ID
 * @param maxPerMemory - Maximum relations to include per source memory
 * @returns Array of RelationContextEntry for the fusion prompt
 */
export function buildRelationContext(
  cluster: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  maxPerMemory: number,
): RelationContextEntry[] {
  const idToIndex = new Map(cluster.map((m, i) => [m.id, i]));
  const entries: RelationContextEntry[] = [];

  for (let i = 0; i < cluster.length; i++) {
    const memory = cluster[i];
    const relations = getRelations(memory.id);
    let count = 0;

    for (const rel of relations) {
      if (count >= maxPerMemory) break;

      const neighborId = rel.sourceId === memory.id ? rel.targetId : rel.sourceId;
      const neighborIndex = idToIndex.get(neighborId);

      if (neighborIndex !== undefined) {
        entries.push({
          memoryIndex: i + 1,
          relationType: rel.relationType,
          targetIndex: neighborIndex + 1,
          targetContent: cluster[neighborIndex].content.slice(0, 80),
          confidence: rel.confidence,
        });
        count++;
      }
    }
  }

  return entries;
}

/**
 * Determine if a cluster spans multiple categories.
 */
function isCrossCategory(cluster: ScallopMemoryEntry[]): boolean {
  const categories = new Set(cluster.map(m => m.category));
  return categories.size > 1;
}

// ============ Orchestrator ============

/**
 * NREM consolidation orchestrator.
 *
 * Orchestrates the full NREM consolidation pipeline:
 * 1. Find cross-category clusters using wider prominence window
 * 2. For each cluster: build relation context, call enhanced LLM fusion
 * 3. Collect results with per-cluster error isolation
 *
 * Pure async function. No DB access — caller provides memories, getRelations,
 * and LLMProvider.
 *
 * @param memories - Array of candidate memories
 * @param getRelations - Callback to get relations for a memory ID
 * @param provider - LLM provider for generating fusion summaries
 * @param options - Optional partial config overrides
 * @returns NremResult with clusters processed, fusion results, and failure count
 */
export async function nremConsolidate(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  provider: LLMProvider,
  options?: Partial<NremConfig>,
): Promise<NremResult> {
  const config = { ...DEFAULT_NREM_CONFIG, ...options };

  if (memories.length === 0) {
    return { clustersProcessed: 0, fusionResults: [], failures: 0 };
  }

  // Step 1: Find cross-category clusters using NREM config
  const clusters = findFusionClusters(memories, getRelations, {
    minProminence: config.minProminence,
    maxProminence: config.maxProminence,
    maxClusters: config.maxClusters,
    minClusterSize: config.minClusterSize,
    crossCategory: true,
  });

  if (clusters.length === 0) {
    return { clustersProcessed: 0, fusionResults: [], failures: 0 };
  }

  // Step 2: Fuse each cluster with relation context (per-cluster error isolation)
  const fusionResults: NremFusionResult[] = [];
  let failures = 0;

  for (const cluster of clusters) {
    try {
      const relationContext = buildRelationContext(cluster, getRelations, config.maxRelationsPerMemory);
      const request = buildFusionPrompt(cluster, relationContext);
      const response = await provider.complete(request);

      // Extract text from ContentBlock[] response
      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);

      const parsed = parseFusionResponse(responseText);
      if (!parsed) {
        failures++;
        continue;
      }

      // Validate: summary must be shorter than combined source content
      const combinedLength = cluster.reduce((sum, m) => sum + m.content.length, 0);
      if (parsed.summary.length >= combinedLength) {
        failures++;
        continue;
      }

      // Calculate derived values from source memories
      const importance = Math.max(...cluster.map(m => m.importance));
      const confidence = Math.min(...cluster.map(m => m.confidence));

      // For cross-category clusters, override category to 'insight'
      const category: MemoryCategory = isCrossCategory(cluster)
        ? 'insight'
        : cluster[0].category; // same-category cluster: use cluster's category

      fusionResults.push({
        summary: parsed.summary,
        importance,
        category,
        confidence,
        learnedFrom: 'nrem_consolidation',
        sourceMemoryIds: cluster.map(m => m.id),
      });
    } catch {
      failures++;
    }
  }

  return {
    clustersProcessed: clusters.length,
    fusionResults,
    failures,
  };
}
