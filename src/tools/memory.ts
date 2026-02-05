/**
 * Memory Tools
 *
 * Exposes memory system capabilities as tools for the agent:
 * - memory_get: Retrieve specific memories by ID or session
 *
 * Note: memory_search has been migrated to the memory_search skill.
 *
 * Supports both ScallopMemoryStore (SQLite, preferred) and legacy MemoryStore (JSONL).
 * When ScallopStore is available, tools query it directly for accurate results.
 */

import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import {
  MemoryStore,
  HybridSearch,
  ScallopMemoryStore,
  type MemoryEntry,
  type MemoryType,
  type ScallopMemoryEntry,
  type MemoryCategory,
} from '../memory/index.js';

/**
 * Shared memory store instances
 */
let sharedMemoryStore: MemoryStore | null = null;
let sharedHybridSearch: HybridSearch | null = null;
let sharedScallopStore: ScallopMemoryStore | null = null;

/**
 * Initialize memory tools with shared instances.
 * When scallopStore is provided, tools will prefer it over legacy store.
 */
export function initializeMemoryTools(
  store: MemoryStore,
  search?: HybridSearch,
  scallopStore?: ScallopMemoryStore
): void {
  sharedMemoryStore = store;
  sharedHybridSearch = search || new HybridSearch({ store });
  sharedScallopStore = scallopStore ?? null;
}

/**
 * Get or create memory store
 */
function getMemoryStore(): MemoryStore {
  if (!sharedMemoryStore) {
    sharedMemoryStore = new MemoryStore();
  }
  return sharedMemoryStore;
}

/**
 * Get scallop store (may be null)
 */
function getScallopStore(): ScallopMemoryStore | null {
  return sharedScallopStore;
}

/**
 * Format a memory entry for display (legacy)
 */
function formatMemoryEntry(entry: MemoryEntry): string {
  const lines: string[] = [];
  lines.push(`ID: ${entry.id}`);
  lines.push(`Type: ${entry.type}`);
  lines.push(`Content: ${entry.content}`);
  lines.push(`Timestamp: ${entry.timestamp.toISOString()}`);
  lines.push(`Session: ${entry.sessionId}`);
  if (entry.tags?.length) {
    lines.push(`Tags: ${entry.tags.join(', ')}`);
  }
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(entry.metadata)}`);
  }
  return lines.join('\n');
}

/**
 * Format a single ScallopStore memory entry for display
 */
function formatScallopEntry(mem: ScallopMemoryEntry): string {
  const lines: string[] = [];
  lines.push(`ID: ${mem.id}`);
  lines.push(`Category: ${mem.category}`);
  lines.push(`Content: ${mem.content}`);
  lines.push(`Timestamp: ${new Date(mem.documentDate).toISOString()}`);
  lines.push(`Prominence: ${mem.prominence.toFixed(2)}`);
  if (mem.userId) {
    lines.push(`User: ${mem.userId}`);
  }
  if (mem.metadata?.subject) {
    lines.push(`Subject: ${mem.metadata.subject}`);
  }
  if (mem.metadata && Object.keys(mem.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(mem.metadata)}`);
  }
  return lines.join('\n');
}

/**
 * Options for memory tools
 */
export interface MemoryToolOptions {
  /** Memory store instance (uses shared if not provided) */
  store?: MemoryStore;
  /** Hybrid search instance (uses shared if not provided) */
  search?: HybridSearch;
  /** ScallopMemoryStore for SQLite-backed search (preferred over legacy) */
  scallopStore?: ScallopMemoryStore;
}

// Note: MemorySearchTool has been removed — replaced by memory_search skill.

/**
 * Memory Get Tool
 *
 * Retrieve specific memories by ID or get all memories for a session
 */
export class MemoryGetTool implements Tool {
  name = 'memory_get';
  category = 'memory' as const;
  description = 'Retrieve specific memories by ID or get all memories for a session';

  private store: MemoryStore | null;
  private scallopStore: ScallopMemoryStore | null;

  constructor(options: MemoryToolOptions = {}) {
    this.store = options.store || null;
    this.scallopStore = options.scallopStore || null;
  }

  /**
   * Map legacy type filter to ScallopStore category filter
   */
  private mapTypeToCategory(type?: string): MemoryCategory | undefined {
    if (!type) return undefined;
    switch (type) {
      case 'fact': return 'fact';
      case 'preference': return 'preference';
      case 'context': return 'event';
      case 'summary': return 'insight';
      default: return undefined;
    }
  }

  definition: ToolDefinition = {
    name: 'memory_get',
    description:
      'Retrieve specific memories from the store. Can get a single memory by ID, ' +
      'all memories for a session, recent memories, or memories filtered by type.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Specific memory ID to retrieve',
        },
        sessionId: {
          type: 'string',
          description: 'Get all memories for this session',
        },
        type: {
          type: 'string',
          enum: ['raw', 'fact', 'summary', 'preference', 'context'],
          description: 'Filter by memory type',
        },
        recent: {
          type: 'number',
          description: 'Get N most recent memories (max: 100)',
        },
      },
      required: [],
    },
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const id = input.id as string | undefined;
    const sessionId = input.sessionId as string | undefined;
    const type = input.type as MemoryType | undefined;
    const recent = input.recent as number | undefined;

    try {
      // Prefer ScallopStore (SQLite) when available
      const scallop = this.scallopStore || getScallopStore();
      if (scallop) {
        return this.executeWithScallop(scallop, { id, sessionId, type, recent }, context);
      }

      // Fallback to legacy MemoryStore
      const store = this.store || getMemoryStore();
      let entries: MemoryEntry[] = [];

      if (id) {
        const entry = store.get(id);
        if (entry) {
          entries = [entry];
        } else {
          return { success: false, output: '', error: `Memory not found with ID: ${id}` };
        }
      } else if (sessionId) {
        entries = store.getBySession(sessionId);
        if (type) entries = entries.filter((e) => e.type === type);
      } else if (recent) {
        entries = store.getRecent(Math.min(recent, 100));
        if (type) entries = entries.filter((e) => e.type === type);
      } else if (type) {
        entries = store.searchByType(type);
      } else {
        entries = store.getRecent(10);
      }

      context.logger.debug(
        { id, sessionId, type, recent, count: entries.length, backend: 'legacy' },
        'Memory get completed'
      );

      if (entries.length === 0) {
        return { success: true, output: 'No memories found matching the criteria.' };
      }

      if (entries.length === 1) {
        return { success: true, output: formatMemoryEntry(entries[0]) };
      }

      const formatted = entries.map((entry, index) =>
        `--- Memory ${index + 1} ---\n${formatMemoryEntry(entry)}`
      );
      return { success: true, output: `Found ${entries.length} memories:\n\n${formatted.join('\n\n')}` };
    } catch (error) {
      const err = error as Error;
      context.logger.error({ id, sessionId, error: err.message }, 'Memory get failed');
      return { success: false, output: '', error: `Memory get failed: ${err.message}` };
    }
  }

  /**
   * Execute using ScallopStore (SQLite) backend
   */
  private async executeWithScallop(
    scallop: ScallopMemoryStore,
    params: { id?: string; sessionId?: string; type?: string; recent?: number },
    context: ToolContext
  ): Promise<ToolResult> {
    const { id, sessionId, type, recent } = params;
    let entries: ScallopMemoryEntry[] = [];

    if (id) {
      const entry = scallop.get(id);
      if (entry) {
        entries = [entry];
      } else {
        return { success: false, output: '', error: `Memory not found with ID: ${id}` };
      }
    } else if (sessionId) {
      const category = this.mapTypeToCategory(type);
      entries = scallop.getByUser(sessionId, { category, limit: 100 });
    } else if (recent) {
      const limit = Math.min(recent, 100);
      const category = this.mapTypeToCategory(type);
      // getByUser without userId returns all; use getActiveMemories-like query
      entries = scallop.getByUser('', { category, limit });
    } else if (type) {
      const category = this.mapTypeToCategory(type);
      entries = scallop.getByUser('', { category, limit: 50 });
    } else {
      entries = scallop.getByUser('', { limit: 10 });
    }

    context.logger.debug(
      { id, sessionId, type, recent, count: entries.length, backend: 'scallop' },
      'Memory get completed'
    );

    if (entries.length === 0) {
      return { success: true, output: 'No memories found matching the criteria.' };
    }

    if (entries.length === 1) {
      return { success: true, output: formatScallopEntry(entries[0]) };
    }

    const formatted = entries.map((entry, index) =>
      `--- Memory ${index + 1} ---\n${formatScallopEntry(entry)}`
    );
    return { success: true, output: `Found ${entries.length} memories:\n\n${formatted.join('\n\n')}` };
  }
}
