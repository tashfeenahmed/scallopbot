/**
 * Memory Tools
 *
 * Exposes memory system capabilities as tools for the agent:
 * - memory_search: Search memories using hybrid search
 * - memory_get: Retrieve specific memories by ID or session
 */

import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import {
  MemoryStore,
  HybridSearch,
  type MemoryEntry,
  type MemoryType,
  type SearchResult,
} from '../memory/index.js';

/**
 * Shared memory store instance
 * Tools need access to the same store instance used by the system
 */
let sharedMemoryStore: MemoryStore | null = null;
let sharedHybridSearch: HybridSearch | null = null;

/**
 * Initialize memory tools with shared instances
 */
export function initializeMemoryTools(
  store: MemoryStore,
  search?: HybridSearch
): void {
  sharedMemoryStore = store;
  sharedHybridSearch = search || new HybridSearch({ store });
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
 * Get or create hybrid search
 */
function getHybridSearch(): HybridSearch {
  if (!sharedHybridSearch) {
    sharedHybridSearch = new HybridSearch({ store: getMemoryStore() });
  }
  return sharedHybridSearch;
}

/**
 * Format a memory entry for display
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
 * Format search results for display
 */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No memories found matching the query.';
  }

  const formatted = results.map((result, index) => {
    const entry = result.entry;
    const lines: string[] = [];
    lines.push(`--- Result ${index + 1} (score: ${result.score.toFixed(3)}, match: ${result.matchType}) ---`);
    lines.push(`ID: ${entry.id}`);
    lines.push(`Type: ${entry.type}`);
    lines.push(`Content: ${entry.content}`);
    lines.push(`Timestamp: ${entry.timestamp.toISOString()}`);
    if (entry.tags?.length) {
      lines.push(`Tags: ${entry.tags.join(', ')}`);
    }
    return lines.join('\n');
  });

  return `Found ${results.length} memories:\n\n${formatted.join('\n\n')}`;
}

/**
 * Options for memory tools
 */
export interface MemoryToolOptions {
  /** Memory store instance (uses shared if not provided) */
  store?: MemoryStore;
  /** Hybrid search instance (uses shared if not provided) */
  search?: HybridSearch;
}

/**
 * Memory Search Tool
 *
 * Search memories using hybrid BM25 + semantic search
 */
export class MemorySearchTool implements Tool {
  name = 'memory_search';
  category = 'memory' as const;
  description = 'Search through stored memories using keyword and semantic matching';

  private search: HybridSearch | null;

  constructor(options: MemoryToolOptions = {}) {
    if (options.store && !options.search) {
      this.search = new HybridSearch({ store: options.store });
    } else {
      this.search = options.search || null;
    }
  }

  definition: ToolDefinition = {
    name: 'memory_search',
    description:
      'Search memories using hybrid search combining keyword matching (BM25) and semantic similarity. ' +
      'Returns ranked results with relevance scores. Use this to find relevant context, facts, ' +
      'user preferences, or past conversation details. By default, searches facts (what you learned about the user).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - can be keywords, phrases, or natural language questions',
        },
        type: {
          type: 'string',
          enum: ['raw', 'fact', 'summary', 'preference', 'context', 'all'],
          description:
            'Filter by memory type: fact (default - extracted facts about the user), ' +
            'raw (unprocessed), summary (condensed), preference (user preferences), context (processed), ' +
            'all (search all types)',
        },
        subject: {
          type: 'string',
          description: 'Filter to facts about a specific person (e.g., "user", "Hamza", "John"). ' +
            'Use "user" for facts about the user themselves.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
        },
        recencyBoost: {
          type: 'boolean',
          description: 'Boost recent memories in ranking (default: true)',
        },
        sessionId: {
          type: 'string',
          description: 'Filter results to a specific session ID',
        },
      },
      required: ['query'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const query = input.query as string;
    const typeInput = input.type as string | undefined;
    const limit = Math.min((input.limit as number) || 10, 50);
    const recencyBoost = input.recencyBoost !== false; // Default true
    const sessionId = input.sessionId as string | undefined;
    const subject = input.subject as string | undefined;

    // Default to 'fact' type unless 'all' is specified
    // This ensures we search facts about the user, not raw conversation logs
    const type: MemoryType | undefined = typeInput === 'all' ? undefined : (typeInput as MemoryType || 'fact');

    try {
      const search = this.search || getHybridSearch();

      const results = search.search(query, {
        limit,
        type,
        recencyBoost,
        sessionId,
        subject,
        userSubjectBoost: 1.5,  // Boost facts about the user
      });

      context.logger.debug(
        { query, type, subject, limit, resultsCount: results.length },
        'Memory search completed'
      );

      return {
        success: true,
        output: formatSearchResults(results),
      };
    } catch (error) {
      const err = error as Error;
      context.logger.error({ query, error: err.message }, 'Memory search failed');
      return {
        success: false,
        output: '',
        error: `Memory search failed: ${err.message}`,
      };
    }
  }
}

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

  constructor(options: MemoryToolOptions = {}) {
    this.store = options.store || null;
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
      const store = this.store || getMemoryStore();
      let entries: MemoryEntry[] = [];

      // Get by specific ID
      if (id) {
        const entry = store.get(id);
        if (entry) {
          entries = [entry];
        } else {
          return {
            success: false,
            output: '',
            error: `Memory not found with ID: ${id}`,
          };
        }
      }
      // Get by session
      else if (sessionId) {
        entries = store.getBySession(sessionId);
        if (type) {
          entries = entries.filter((e) => e.type === type);
        }
      }
      // Get recent
      else if (recent) {
        const limit = Math.min(recent, 100);
        entries = store.getRecent(limit);
        if (type) {
          entries = entries.filter((e) => e.type === type);
        }
      }
      // Get by type only
      else if (type) {
        entries = store.searchByType(type);
      }
      // No filters - return recent
      else {
        entries = store.getRecent(10);
      }

      context.logger.debug(
        { id, sessionId, type, recent, count: entries.length },
        'Memory get completed'
      );

      if (entries.length === 0) {
        return {
          success: true,
          output: 'No memories found matching the criteria.',
        };
      }

      if (entries.length === 1) {
        return {
          success: true,
          output: formatMemoryEntry(entries[0]),
        };
      }

      const formatted = entries.map((entry, index) => {
        return `--- Memory ${index + 1} ---\n${formatMemoryEntry(entry)}`;
      });

      return {
        success: true,
        output: `Found ${entries.length} memories:\n\n${formatted.join('\n\n')}`,
      };
    } catch (error) {
      const err = error as Error;
      context.logger.error({ id, sessionId, error: err.message }, 'Memory get failed');
      return {
        success: false,
        output: '',
        error: `Memory get failed: ${err.message}`,
      };
    }
  }
}
