/**
 * Shared fused memory storage with DERIVES relations.
 * Used by deepTick (consolidation) and sleepTick (NREM consolidation).
 */

import type { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, ScallopMemoryEntry, MemoryCategory } from './db.js';

export interface StoreFusedMemoryInput {
  scallopStore: ScallopMemoryStore;
  db: ScallopDatabase;
  userId: string;
  summary: string;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  sourceMemoryIds: string[];
  /** Source chunk: for deepTick consolidation, join content; for NREM, join IDs */
  sourceChunk: string;
  /** 'consolidation' or 'nrem_consolidation' */
  learnedFrom: string;
  /** Extra metadata to include (e.g., nrem: true) */
  extraMetadata?: Record<string, unknown>;
}

export interface StoreFusedMemoryResult {
  fusedMemory: ScallopMemoryEntry;
  fusedProminence: number;
}

/**
 * Stores a derived memory, creates DERIVES relations to all sources,
 * and caps prominence at 0.6.
 */
export async function storeFusedMemory(
  input: StoreFusedMemoryInput,
  allMemories: ScallopMemoryEntry[],
): Promise<StoreFusedMemoryResult> {
  const fusedMemory = await input.scallopStore.add({
    userId: input.userId,
    content: input.summary,
    category: input.category,
    importance: input.importance,
    confidence: input.confidence,
    sourceChunk: input.sourceChunk,
    metadata: {
      fusedAt: new Date().toISOString(),
      sourceCount: input.sourceMemoryIds.length,
      sourceIds: input.sourceMemoryIds,
      ...input.extraMetadata,
    },
    learnedFrom: input.learnedFrom,
    detectRelations: false,
  });

  // Override memoryType to 'derived' (add() sets 'regular')
  input.db.updateMemory(fusedMemory.id, { memoryType: 'derived' });

  // Add DERIVES relations from fused memory to each source
  for (const sourceId of input.sourceMemoryIds) {
    input.db.addRelation(fusedMemory.id, sourceId, 'DERIVES', 0.95);
  }

  // Set fused memory prominence capped at 0.6
  const sourceMemories = allMemories.filter(m => input.sourceMemoryIds.includes(m.id));
  const maxProminence = sourceMemories.length > 0
    ? Math.max(...sourceMemories.map(m => m.prominence))
    : 0.5;
  const fusedProminence = Math.min(0.6, maxProminence + 0.1);
  input.db.updateProminences([{ id: fusedMemory.id, prominence: fusedProminence }]);

  return { fusedMemory, fusedProminence };
}
