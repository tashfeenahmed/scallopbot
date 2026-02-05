/**
 * Legacy memory types from the JSONL-based MemoryStore.
 * Kept for migration compatibility and consumers that still reference them.
 */

export type MemoryType = 'raw' | 'fact' | 'summary' | 'preference' | 'context';

export interface MemoryEntry {
  id: string;
  content: string;
  type: MemoryType;
  timestamp: Date;
  sessionId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export type PartialMemoryEntry = Omit<MemoryEntry, 'id'> & { id?: string };
