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
  /** Mark source memories as superseded (default: false). Set true for deepTick consolidation. */
  supersedeSources?: boolean;
}

export interface StoreFusedMemoryResult {
  fusedMemory: ScallopMemoryEntry;
  fusedProminence: number;
}

const RELATIVE_DATE_RE = /\b(?:today|tomorrow|yesterday|next\s+(?:week|month|year)|last\s+(?:week|month|year))\b/gi;
const HAS_RELATIVE_DATE_RE = /\b(?:today|tomorrow|yesterday|next\s+(?:week|month|year)|last\s+(?:week|month|year))\b/i;

function normalizeFusedTemporalSummary(
  summary: string,
  sourceMemories: ScallopMemoryEntry[],
): { content: string; eventDate?: number; temporalSourceDate?: string } {
  if (!HAS_RELATIVE_DATE_RE.test(summary)) return { content: summary };

  const relativeSources = sourceMemories.filter(memory => {
    const metadata = memory.metadata as Record<string, unknown> | null;
    return memory.eventDate != null
      && (metadata?.isRelativeDate === true || HAS_RELATIVE_DATE_RE.test(memory.content));
  });
  const dates = new Map<string, number>();
  for (const source of relativeSources) {
    const day = new Date(source.eventDate!).toISOString().slice(0, 10);
    if (!dates.has(day)) dates.set(day, source.eventDate!);
  }
  if (dates.size !== 1) {
    throw new Error('fused_relative_time_has_no_unique_source_date');
  }

  const [day, eventDate] = [...dates.entries()][0];
  return {
    content: summary.replace(RELATIVE_DATE_RE, `on ${day}`),
    eventDate,
    temporalSourceDate: day,
  };
}

/**
 * Stores a derived memory, creates DERIVES relations to all sources,
 * and caps prominence at 0.6.
 */
export async function storeFusedMemory(
  input: StoreFusedMemoryInput,
  allMemories: ScallopMemoryEntry[],
): Promise<StoreFusedMemoryResult> {
  const sourceMemories = allMemories.filter(m => input.sourceMemoryIds.includes(m.id));
  const temporal = normalizeFusedTemporalSummary(input.summary, sourceMemories);
  const fusedMemory = await input.scallopStore.add({
    userId: input.userId,
    content: temporal.content,
    category: input.category,
    importance: input.importance,
    confidence: input.confidence,
    sourceChunk: input.sourceChunk,
    metadata: {
      fusedAt: new Date().toISOString(),
      sourceCount: input.sourceMemoryIds.length,
      sourceIds: input.sourceMemoryIds,
      ...(temporal.temporalSourceDate
        ? { temporalSourceDate: temporal.temporalSourceDate, relativeDateCanonicalized: true }
        : {}),
      ...input.extraMetadata,
    },
    learnedFrom: input.learnedFrom,
    detectRelations: false,
    ...(temporal.eventDate !== undefined ? { eventDate: temporal.eventDate } : {}),
  });

  // Override memoryType to 'derived' (add() sets 'regular')
  input.db.updateMemory(fusedMemory.id, { memoryType: 'derived' });

  // Add DERIVES relations from fused memory to each source
  for (const sourceId of input.sourceMemoryIds) {
    input.db.addRelation(fusedMemory.id, sourceId, 'DERIVES', 0.95);
  }

  // Mark source memories as superseded when consolidating (deepTick),
  // but not for supplementary fusion (NREM sleepTick)
  if (input.supersedeSources) {
    for (const sourceId of input.sourceMemoryIds) {
      input.db.updateMemory(sourceId, { isLatest: false, memoryType: 'superseded' });
    }
  }

  // Set fused memory prominence capped at 0.6
  const maxProminence = sourceMemories.length > 0
    ? Math.max(...sourceMemories.map(m => m.prominence))
    : 0.5;
  const fusedProminence = Math.min(0.6, maxProminence + 0.1);
  input.db.updateProminences([{ id: fusedMemory.id, prominence: fusedProminence }]);

  return { fusedMemory, fusedProminence };
}
