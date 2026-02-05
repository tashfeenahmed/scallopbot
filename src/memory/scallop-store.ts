/**
 * ScallopMemoryStore - Unified Memory System
 *
 * Integrates all ScallopMemory components:
 * - SQLite persistence
 * - Memory relationships (UPDATES/EXTENDS/DERIVES)
 * - Decay system
 * - User profiles
 * - Temporal grounding
 * - Hybrid search with source chunks
 */

import type { Logger } from 'pino';
import {
  ScallopDatabase,
  type ScallopMemoryEntry,
  type MemoryCategory,
} from './db.js';
import { DecayEngine, PROMINENCE_THRESHOLDS, type DecayConfig } from './decay.js';
import { RelationGraph, type RelationDetectionOptions } from './relations.js';
import { ProfileManager, type ProfileUpdateOptions } from './profiles.js';
import { TemporalExtractor, TemporalQuery } from './temporal.js';
import type { EmbeddingProvider } from './embeddings.js';
import { cosineSimilarity } from './embeddings.js';
import { calculateBM25Score, buildDocFreqMap, type BM25Options } from './memory.js';

/**
 * Options for ScallopMemoryStore
 */
export interface ScallopMemoryStoreOptions {
  /** Path to SQLite database */
  dbPath: string;
  /** Logger instance */
  logger: Logger;
  /** Embedding provider for semantic search */
  embedder?: EmbeddingProvider;
  /** Decay configuration */
  decayConfig?: DecayConfig;
  /** Relation detection options */
  relationOptions?: RelationDetectionOptions;
  /** Profile update options */
  profileOptions?: ProfileUpdateOptions;
}

/**
 * Options for adding a memory
 */
export interface AddMemoryOptions {
  userId: string;
  content: string;
  category?: MemoryCategory;
  importance?: number;
  confidence?: number;
  sourceChunk?: string;
  eventDate?: number;
  metadata?: Record<string, unknown>;
  /** Automatically detect relations with existing memories */
  detectRelations?: boolean;
}

/**
 * Search options for hybrid search
 */
export interface ScallopSearchOptions {
  userId?: string;
  category?: MemoryCategory;
  minProminence?: number;
  isLatest?: boolean;
  limit?: number;
  /** Include source chunks in results */
  includeChunks?: boolean;
  /** Time range for event dates */
  eventDateRange?: { start: number; end: number };
  /** Time range for document dates */
  documentDateRange?: { start: number; end: number };
}

/**
 * Search result with chunk injection
 */
export interface ScallopSearchResult {
  memory: ScallopMemoryEntry;
  score: number;
  sourceChunk: string | null;
  matchType: 'semantic' | 'keyword' | 'hybrid';
  relatedMemories?: ScallopMemoryEntry[];
}

/**
 * ScallopMemoryStore - Main entry point for memory operations
 */
export class ScallopMemoryStore {
  private db: ScallopDatabase;
  private logger: Logger;
  private embedder?: EmbeddingProvider;
  private decayEngine: DecayEngine;
  private relationGraph: RelationGraph;
  private profileManager: ProfileManager;
  private temporalExtractor: TemporalExtractor;

  constructor(options: ScallopMemoryStoreOptions) {
    this.db = new ScallopDatabase(options.dbPath);
    this.logger = options.logger.child({ component: 'scallop-memory' });
    this.embedder = options.embedder;

    // Initialize components
    this.decayEngine = new DecayEngine(options.decayConfig);
    this.relationGraph = new RelationGraph(this.db, options.embedder, options.relationOptions);
    this.profileManager = new ProfileManager(this.db, options.profileOptions);
    this.temporalExtractor = new TemporalExtractor();

    this.logger.info({ dbPath: options.dbPath }, 'ScallopMemoryStore initialized');
  }

  // ============ Memory CRUD ============

  /**
   * Add a new memory
   */
  async add(options: AddMemoryOptions): Promise<ScallopMemoryEntry> {
    const {
      userId,
      content,
      category = 'fact',
      importance = 5,
      confidence = 0.8,
      sourceChunk,
      metadata,
      detectRelations = true,
    } = options;

    // Extract temporal information
    const temporal = this.temporalExtractor.extract(content);
    const eventDate = options.eventDate ?? temporal.eventDate;

    // Generate embedding if embedder available (non-fatal if it fails)
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(content);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Embedding generation failed, storing without embedding');
      }
    }

    // Add memory to database
    const memory = this.db.addMemory({
      userId,
      content,
      category,
      memoryType: 'regular',
      importance,
      confidence,
      isLatest: true,
      documentDate: Date.now(),
      eventDate,
      prominence: 1.0,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: sourceChunk ?? null,
      embedding: embedding ?? null,
      metadata: {
        ...metadata,
        rawDateText: temporal.rawDateText,
        isRelativeDate: temporal.isRelative,
      },
    });

    this.logger.debug({ memoryId: memory.id, category, userId }, 'Memory added');

    // Detect and apply relations
    if (detectRelations && this.embedder) {
      try {
        const relations = await this.relationGraph.detectRelations(memory);
        if (relations.length > 0) {
          this.relationGraph.applyRelations(relations);
          this.logger.debug(
            { memoryId: memory.id, relationsCount: relations.length },
            'Relations detected and applied'
          );
        }
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Relation detection failed');
      }
    }

    // Update user profile
    this.profileManager.updateDynamicFromConversation(userId, content);

    return memory;
  }

  /**
   * Get a memory by ID
   */
  get(id: string): ScallopMemoryEntry | null {
    const memory = this.db.getMemory(id);
    if (memory) {
      // Record access for decay system
      this.db.recordAccess(id);
    }
    return memory;
  }

  /**
   * Update a memory
   */
  update(id: string, updates: Partial<ScallopMemoryEntry>): boolean {
    return this.db.updateMemory(id, updates);
  }

  /**
   * Delete a memory
   */
  delete(id: string): boolean {
    return this.db.deleteMemory(id);
  }

  /**
   * Get memories by user
   */
  getByUser(
    userId: string,
    options: {
      category?: MemoryCategory;
      isLatest?: boolean;
      minProminence?: number;
      limit?: number;
    } = {}
  ): ScallopMemoryEntry[] {
    return this.db.getMemoriesByUser(userId, {
      category: options.category,
      isLatest: options.isLatest,
      minProminence: options.minProminence ?? PROMINENCE_THRESHOLDS.DORMANT,
      limit: options.limit,
    });
  }

  /**
   * Get active memories (prominence > 0.5)
   */
  getActiveMemories(userId: string, limit?: number): ScallopMemoryEntry[] {
    return this.db.getMemoriesByUser(userId, {
      minProminence: PROMINENCE_THRESHOLDS.ACTIVE,
      isLatest: true,
      limit,
    });
  }

  // ============ Hybrid Search ============

  /**
   * Search memories with hybrid semantic + keyword search
   */
  async search(query: string, options: ScallopSearchOptions = {}): Promise<ScallopSearchResult[]> {
    const {
      userId,
      category,
      minProminence = PROMINENCE_THRESHOLDS.DORMANT,
      isLatest = true,
      limit = 10,
      includeChunks = true,
      eventDateRange,
      documentDateRange,
    } = options;

    // Get candidate memories - warn if userId is omitted (potential cross-user leak)
    let candidates: ScallopMemoryEntry[];
    if (userId) {
      candidates = this.db.getMemoriesByUser(userId, {
        category,
        minProminence,
        isLatest,
        limit: limit * 5, // Get more candidates for filtering
      });
    } else {
      this.logger.warn('Search called without userId - searching ALL users. This may leak memories across users in multi-user deployments.');
      candidates = this.db.getAllMemories({ minProminence, limit: limit * 5 });
    }

    // Apply date filters
    if (eventDateRange) {
      candidates = candidates.filter(
        (m) =>
          m.eventDate !== null &&
          m.eventDate >= eventDateRange.start &&
          m.eventDate <= eventDateRange.end
      );
    }
    if (documentDateRange) {
      candidates = candidates.filter(
        (m) =>
          m.documentDate >= documentDateRange.start &&
          m.documentDate <= documentDateRange.end
      );
    }

    if (candidates.length === 0) {
      return [];
    }

    // Score each candidate
    const results: ScallopSearchResult[] = [];
    const queryLower = query.toLowerCase();

    // Only compute query embedding if at least one candidate has an embedding
    // This avoids wasting API calls when no semantic comparison is possible
    const anyCandidateHasEmbedding = candidates.some(m => m.embedding !== null);
    let queryEmbedding: number[] | undefined;
    if (this.embedder && anyCandidateHasEmbedding) {
      try {
        queryEmbedding = await this.embedder.embed(query);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Query embedding failed, using keyword-only search');
      }
    }

    // Pre-compute BM25 statistics for proper keyword scoring
    const contentTexts = candidates.map((m) => m.content);
    const avgDocLength =
      contentTexts.reduce((sum, c) => sum + c.split(/\s+/).length, 0) / contentTexts.length;
    const docFreq = buildDocFreqMap(contentTexts);
    const bm25Options: BM25Options = {
      avgDocLength,
      docCount: candidates.length,
      docFreq,
    };

    for (const memory of candidates) {
      let score = 0;
      let matchType: 'semantic' | 'keyword' | 'hybrid' = 'keyword';

      // Keyword score (proper BM25)
      const keywordScore = calculateBM25Score(queryLower, memory.content.toLowerCase(), bm25Options);

      // Semantic score
      let semanticScore = 0;
      if (queryEmbedding && memory.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, memory.embedding);
        matchType = keywordScore > semanticScore ? 'keyword' : 'semantic';
        if (keywordScore > 0 && semanticScore > 0) {
          matchType = 'hybrid';
        }
      }

      // Combine scores (weighted)
      score = keywordScore * 0.4 + semanticScore * 0.4 + memory.prominence * 0.2;

      // Boost for exact matches
      if (memory.content.toLowerCase().includes(queryLower)) {
        score *= 1.5;
      }

      if (score > 0.01) {
        results.push({
          memory,
          score,
          sourceChunk: includeChunks ? memory.sourceChunk : null,
          matchType,
        });
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    // Add related memories if requested
    for (const result of topResults) {
      result.relatedMemories = this.relationGraph.getRelatedMemoriesForContext(result.memory.id);
    }

    // Record access for top results
    for (const result of topResults) {
      this.db.recordAccess(result.memory.id);
    }

    return topResults;
  }

  // calculateKeywordScore removed — now using imported calculateBM25Score from memory.ts

  /**
   * Temporal search - find memories by time range
   */
  searchByTime(
    userId: string,
    range: 'thisWeek' | 'lastWeek' | 'thisMonth' | { start: number; end: number },
    options: { useEventDate?: boolean; limit?: number } = {}
  ): ScallopMemoryEntry[] {
    const { useEventDate = true, limit = 20 } = options;

    // Get time range
    let timeRange: { start: number; end: number };
    if (typeof range === 'object') {
      timeRange = range;
    } else {
      switch (range) {
        case 'thisWeek':
          timeRange = TemporalQuery.thisWeek();
          break;
        case 'lastWeek':
          timeRange = TemporalQuery.lastWeek();
          break;
        case 'thisMonth':
          timeRange = TemporalQuery.thisMonth();
          break;
      }
    }

    // Query database
    const dateField = useEventDate ? 'event_date' : 'document_date';
    const results = this.db.raw<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE user_id = ?
         AND ${dateField} IS NOT NULL
         AND ${dateField} BETWEEN ? AND ?
         AND prominence > ?
       ORDER BY ${dateField} DESC
       LIMIT ?`,
      [userId, timeRange.start, timeRange.end, PROMINENCE_THRESHOLDS.DORMANT, limit]
    );

    return results.map((row) => this.db.getMemory(row.id as string)!).filter(Boolean);
  }

  // ============ Relations ============

  /**
   * Add an UPDATES relation (new supersedes old)
   */
  addUpdatesRelation(newMemoryId: string, oldMemoryId: string): void {
    this.relationGraph.addUpdatesRelation(newMemoryId, oldMemoryId);
  }

  /**
   * Add an EXTENDS relation (new enriches existing)
   */
  addExtendsRelation(newMemoryId: string, existingMemoryId: string): void {
    this.relationGraph.addExtendsRelation(newMemoryId, existingMemoryId);
  }

  /**
   * Get the latest version of a memory
   */
  getLatestVersion(memoryId: string): ScallopMemoryEntry | null {
    return this.relationGraph.getLatestVersion(memoryId);
  }

  /**
   * Get update history for a memory
   */
  getUpdateHistory(memoryId: string): ScallopMemoryEntry[] {
    return this.relationGraph.getUpdateHistory(memoryId);
  }

  // ============ User Profiles ============

  /**
   * Get user profile manager
   */
  getProfileManager(): ProfileManager {
    return this.profileManager;
  }

  /**
   * Set a static profile value
   */
  setProfileValue(userId: string, key: string, value: string): void {
    this.profileManager.setStaticValue(userId, key, value);
  }

  /**
   * Get profile context string for LLM injection
   */
  async getProfileContext(userId: string, query?: string): Promise<string> {
    // Get relevant memories for context
    let relevantMemories: ScallopMemoryEntry[] = [];
    if (query) {
      const results = await this.search(query, { userId, limit: 5 });
      relevantMemories = results.map((r) => r.memory);
    } else {
      relevantMemories = this.getActiveMemories(userId, 5);
    }

    return this.profileManager.getContextString(userId, relevantMemories);
  }

  // ============ Decay System ============

  /**
   * Process decay for all memories
   */
  processDecay(): { updated: number; archived: number } {
    const result = this.decayEngine.processDecay(this.db);
    this.logger.debug(result, 'Decay processed');
    return result;
  }

  /**
   * Get memory status based on prominence
   */
  getMemoryStatus(memory: ScallopMemoryEntry): 'active' | 'dormant' | 'archived' {
    return this.decayEngine.getMemoryStatus(memory.prominence);
  }

  // ============ Utility Methods ============

  /**
   * Get memory count
   */
  getCount(userId?: string): number {
    return this.db.getMemoryCount(userId);
  }

  /**
   * Get database instance (for advanced operations)
   */
  getDatabase(): ScallopDatabase {
    return this.db;
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
    this.logger.info('ScallopMemoryStore closed');
  }
}

/**
 * Create a ScallopMemoryStore instance
 */
export function createScallopMemoryStore(options: ScallopMemoryStoreOptions): ScallopMemoryStore {
  return new ScallopMemoryStore(options);
}
