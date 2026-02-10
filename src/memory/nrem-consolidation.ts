/**
 * NREM Consolidation Module (stub — tests should fail)
 *
 * Relation-context-enriched fusion for deep sleep consolidation.
 * Extends the fusion.ts pipeline with wider prominence window,
 * cross-category clustering, and relation context in LLM prompts.
 */

import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';

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

/** A relation context entry for the fusion prompt */
export interface RelationContextEntry {
  memoryIndex: number;
  relationType: string;
  targetIndex: number;
  targetContent: string;
  confidence: number;
}

/** Result of a single NREM fusion */
export interface NremFusionResult {
  summary: string;
  importance: number;
  category: MemoryCategory;
  confidence: number;
  learnedFrom: 'nrem_consolidation';
  sourceMemoryIds: string[];
}

/** Overall result of NREM consolidation */
export interface NremResult {
  clustersProcessed: number;
  fusionResults: NremFusionResult[];
  failures: number;
}

// ============ Stub Functions ============

export function buildRelationContext(
  _cluster: ScallopMemoryEntry[],
  _getRelations: (memoryId: string) => MemoryRelation[],
  _maxPerMemory: number,
): RelationContextEntry[] {
  throw new Error('Not implemented');
}

export function buildNremFusionPrompt(
  _cluster: ScallopMemoryEntry[],
  _relationContext: RelationContextEntry[],
): CompletionRequest {
  throw new Error('Not implemented');
}

export async function nremConsolidate(
  _memories: ScallopMemoryEntry[],
  _getRelations: (memoryId: string) => MemoryRelation[],
  _provider: LLMProvider,
  _options?: Partial<NremConfig>,
): Promise<NremResult> {
  throw new Error('Not implemented');
}
