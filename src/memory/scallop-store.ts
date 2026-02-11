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
import { RelationGraph, type RelationDetectionOptions, type ActivationConfig } from './relations.js';
import { ProfileManager, type ProfileUpdateOptions } from './profiles.js';
import { TemporalExtractor, TemporalQuery } from './temporal.js';
import type { EmbeddingProvider } from './embeddings.js';
import { cosineSimilarity, CachedEmbedder, TFIDFEmbedder } from './embeddings.js';
import { calculateBM25Score, buildDocFreqMap, SEARCH_WEIGHTS, type BM25Options } from './bm25.js';
import { rerankResults, type RerankCandidate } from './reranker.js';
import type { LLMProvider } from '../providers/types.js';

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
  /** Optional LLM provider for re-ranking search results */
  rerankProvider?: LLMProvider;
  /** Optional LLM provider for LLM-based relation classification */
  relationsProvider?: LLMProvider;
  /** Optional spreading activation config for related memory retrieval */
  activationConfig?: ActivationConfig;
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
  /** Source of the memory: user message or assistant response */
  source?: 'user' | 'assistant';
  /** Automatically detect relations with existing memories */
  detectRelations?: boolean;
  /** How the memory was learned: conversation, correction, inference, consolidation */
  learnedFrom?: string;
  /** Pre-computed embedding vector — skips embedder.embed() when provided */
  embedding?: number[];
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
  /** Pre-computed query embedding — skips embedder.embed(query) when provided */
  queryEmbedding?: number[];
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
  private rerankProvider?: LLMProvider;
  private activationConfig?: ActivationConfig;
  private decayEngine: DecayEngine;
  private relationGraph: RelationGraph;
  private profileManager: ProfileManager;
  private temporalExtractor: TemporalExtractor;

  constructor(options: ScallopMemoryStoreOptions) {
    this.db = new ScallopDatabase(options.dbPath);
    this.logger = options.logger.child({ component: 'scallop-memory' });
    // Wrap embedder with cache to avoid recomputing embeddings for seen texts
    this.embedder = options.embedder ? new CachedEmbedder(options.embedder) : undefined;
    this.rerankProvider = options.rerankProvider;
    this.activationConfig = options.activationConfig;

    // Initialize components
    this.decayEngine = new DecayEngine(options.decayConfig);
    this.relationGraph = new RelationGraph(this.db, this.embedder, options.relationOptions, options.relationsProvider);
    this.profileManager = new ProfileManager(this.db, options.profileOptions);
    this.temporalExtractor = new TemporalExtractor();

    // Seed TF-IDF IDF weights from existing memories so search quality is correct.
    // Without this, all terms get uniform IDF=1.0 (no discrimination power).
    this.seedTFIDFWeights();

    this.logger.info({ dbPath: options.dbPath }, 'ScallopMemoryStore initialized');
  }

  /**
   * Seed TF-IDF IDF weights from existing memories.
   * Finds the TFIDFEmbedder (possibly wrapped in CachedEmbedder) and calls addDocuments
   * so IDF weights reflect the actual corpus, not uniform defaults.
   */
  private seedTFIDFWeights(): void {
    if (!this.embedder) return;

    // Unwrap CachedEmbedder to find the inner embedder
    const inner = this.embedder instanceof CachedEmbedder
      ? this.embedder.getInner()
      : this.embedder;

    if (!(inner instanceof TFIDFEmbedder)) return;

    try {
      const memories = this.db.getAllMemories({ minProminence: 0.1, limit: 500 });
      if (memories.length === 0) return;

      inner.addDocuments(memories.map(m => m.content));
      this.logger.debug({ docCount: memories.length }, 'Seeded TF-IDF IDF weights from existing memories');
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to seed TF-IDF weights');
    }
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
      source = 'user',
      detectRelations = true,
      learnedFrom = 'conversation',
    } = options;

    // Extract temporal information
    const temporal = this.temporalExtractor.extract(content);
    const eventDate = options.eventDate ?? temporal.eventDate;

    // Use pre-computed embedding if provided, otherwise generate via embedder
    let embedding: number[] | undefined = options.embedding;
    if (!embedding && this.embedder) {
      try {
        embedding = await this.embedder.embed(content);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'Embedding generation failed, storing without embedding');
      }
    }

    // Ingestion-time deduplication: check for semantically near-identical existing memory
    if (embedding) {
      const existing = this.db.getMemoriesByUser(userId, {
        isLatest: true,
        minProminence: PROMINENCE_THRESHOLDS.DORMANT,
        limit: 100,
        includeAllSources: false,
      });

      let bestMatch: ScallopMemoryEntry | null = null;
      let bestSim = 0;
      for (const mem of existing) {
        if (!mem.embedding) continue;
        const sim = cosineSimilarity(embedding, mem.embedding);
        if (sim >= 0.85 && sim > bestSim) {
          bestSim = sim;
          bestMatch = mem;
        }
      }

      if (bestMatch) {
        // If new content is meaningfully longer (>10%), update the existing memory's content
        if (content.length > bestMatch.content.length * 1.1) {
          this.db.updateMemory(bestMatch.id, { content });
          this.logger.debug(
            { existingId: bestMatch.id, similarity: bestSim },
            'Dedup: updated existing memory with longer content'
          );
        } else {
          this.db.recordAccess(bestMatch.id);
          this.logger.debug(
            { existingId: bestMatch.id, similarity: bestSim },
            'Dedup: boosted existing memory access count'
          );
        }
        return this.db.getMemory(bestMatch.id)!;
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
      source,
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
      learnedFrom,
      timesConfirmed: 1,
      contradictionIds: null,
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

    // Update user profiles (both per-session and canonical "default" for cross-session access)
    this.profileManager.updateDynamicFromConversation(userId, content);
    this.profileManager.updateStaticFromFacts(userId, [memory]);
    if (userId !== 'default') {
      this.profileManager.updateStaticFromFacts('default', [memory]);
    }

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

    // Get candidate memories - use a large pool so BM25 can find keyword matches
    // even when they're not the highest-prominence memories
    const candidateLimit = Math.max(limit * 5, 200);
    let candidates: ScallopMemoryEntry[];
    if (userId) {
      candidates = this.db.getMemoriesByUser(userId, {
        category,
        minProminence,
        isLatest,
        limit: candidateLimit,
        includeAllSources: false, // Exclude skill outputs and system pollution
      });
    } else {
      this.logger.warn('Search called without userId - searching ALL users. This may leak memories across users in multi-user deployments.');
      candidates = this.db.getAllMemories({ minProminence, limit: candidateLimit });
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

    // Score each candidate using two-pass min-max BM25 normalization
    const queryLower = query.toLowerCase();

    // Use pre-computed query embedding if provided, otherwise compute it
    const anyCandidateHasEmbedding = candidates.some(m => m.embedding !== null);
    let queryEmbedding: number[] | undefined = options.queryEmbedding;
    if (!queryEmbedding && this.embedder && anyCandidateHasEmbedding) {
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

    // Pass 1: Compute raw BM25 + semantic scores for all candidates
    const rawScores = candidates.map(memory => {
      const rawBM25 = calculateBM25Score(queryLower, memory.content.toLowerCase(), bm25Options);
      let semanticScore = 0;
      if (queryEmbedding && memory.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, memory.embedding);
      }
      return { memory, rawBM25, semanticScore };
    });

    // Min-max normalize BM25 values across the candidate pool
    let minBM25 = Infinity;
    let maxBM25 = -Infinity;
    for (const s of rawScores) {
      if (s.rawBM25 < minBM25) minBM25 = s.rawBM25;
      if (s.rawBM25 > maxBM25) maxBM25 = s.rawBM25;
    }
    const bm25Range = maxBM25 - minBM25;

    // Pass 2: Normalize and combine scores
    const results: ScallopSearchResult[] = [];
    for (const { memory, rawBM25, semanticScore } of rawScores) {
      // Min-max normalized BM25 (preserves full discriminative range)
      const keywordScore = bm25Range > 0 ? (rawBM25 - minBM25) / bm25Range : 0;

      let matchType: 'semantic' | 'keyword' | 'hybrid' = 'keyword';
      if (semanticScore > 0) {
        matchType = keywordScore > semanticScore ? 'keyword' : 'semantic';
        if (rawBM25 > 0 && semanticScore > 0) {
          matchType = 'hybrid';
        }
      }

      // Combine scores with multiplicative prominence
      const relevanceScore = keywordScore * SEARCH_WEIGHTS.keyword + semanticScore * SEARCH_WEIGHTS.semantic;
      const prominenceMultiplier = 0.5 + 0.5 * memory.prominence;
      let score = relevanceScore * prominenceMultiplier;

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
    let topResults = results.slice(0, limit);

    // LLM re-ranking: refine top results using semantic relevance scoring
    if (this.rerankProvider && topResults.length > 0) {
      try {
        const candidates: RerankCandidate[] = topResults.map(r => ({
          id: r.memory.id,
          content: r.memory.content,
          originalScore: r.score,
        }));

        const reranked = await rerankResults(query, candidates, this.rerankProvider, { maxCandidates: 20 });

        // Map re-ranked scores back to search results
        const rerankedMap = new Map(reranked.map(r => [r.id, r.finalScore]));
        topResults = topResults
          .filter(r => rerankedMap.has(r.memory.id))
          .map(r => ({ ...r, score: rerankedMap.get(r.memory.id)! }))
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'LLM re-ranking failed, using original scores');
        // Fall through with original topResults unchanged
      }
    }

    // Add related memories using spreading activation (ranked by activation score)
    for (const result of topResults) {
      result.relatedMemories = this.relationGraph.getRelatedMemoriesWithActivation(
        result.memory.id,
        this.activationConfig,
      );
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

  // ============ Session Summary Search ============

  /**
   * Search session summaries with hybrid keyword + semantic search
   */
  async searchSessions(query: string, options: { userId?: string; limit?: number } = {}): Promise<Array<{
    summary: import('./db.js').SessionSummaryRow;
    score: number;
  }>> {
    const { userId, limit = 5 } = options;
    const db = this.db;

    // Get candidate summaries
    const candidates = userId
      ? db.getSessionSummariesByUser(userId, 50)
      : db.getAllSessionSummaries(50);

    if (candidates.length === 0) return [];

    // Compute query embedding if available
    let queryEmbedding: number[] | undefined;
    const anyCandidateHasEmbedding = candidates.some(s => s.embedding !== null);
    if (this.embedder && anyCandidateHasEmbedding) {
      try {
        queryEmbedding = await this.embedder.embed(query);
      } catch {
        // Fall through to keyword-only
      }
    }

    const queryLower = query.toLowerCase();
    const results: Array<{ summary: import('./db.js').SessionSummaryRow; score: number }> = [];

    for (const summary of candidates) {
      let score = 0;

      // Keyword matching: check summary text and topics
      const summaryLower = summary.summary.toLowerCase();
      const topicsStr = summary.topics.join(' ').toLowerCase();
      const combinedText = `${summaryLower} ${topicsStr}`;

      // Simple keyword overlap score
      const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (combinedText.includes(term)) matchedTerms++;
      }
      const keywordScore = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0;

      // Semantic score
      let semanticScore = 0;
      if (queryEmbedding && summary.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, summary.embedding);
      }

      score = keywordScore * SEARCH_WEIGHTS.keyword + semanticScore * SEARCH_WEIGHTS.semantic;

      // Boost for exact phrase match
      if (combinedText.includes(queryLower)) {
        score *= 1.5;
      }

      if (score > 0.05) {
        results.push({ summary, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
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
   * Process full decay for all memories (deep consolidation)
   */
  processFullDecay(): { updated: number; archived: number } {
    const result = this.decayEngine.processFullDecay(this.db);
    this.logger.debug(result, 'Full decay processed');
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
   * Backfill the "default" user profile from existing facts across all sessions.
   * Should be called once on startup to populate the profile for pre-existing data.
   */
  backfillDefaultProfile(): { fieldsPopulated: number } {
    const existing = this.profileManager.getStaticProfile('default');
    if (Object.keys(existing).length > 0) {
      this.logger.debug({ existingFields: Object.keys(existing) }, 'Default profile already exists, skipping backfill');
      return { fieldsPopulated: 0 };
    }

    // Scan all fact memories for profile-worthy content
    const allFacts = this.db.getAllMemories({ minProminence: 0.1 });
    const userFacts = allFacts.filter(
      (m) => m.category === 'fact' && (!m.metadata?.subject || m.metadata.subject === 'user')
    );

    this.logger.info({ totalMemories: allFacts.length, userFacts: userFacts.length }, 'Backfilling default profile from existing facts');

    this.profileManager.updateStaticFromFacts('default', userFacts);
    const populated = this.profileManager.getStaticProfile('default');
    const count = Object.keys(populated).length;

    this.logger.info({ profile: populated, fieldsPopulated: count }, 'Default profile backfill complete');

    return { fieldsPopulated: count };
  }

  /**
   * Get memory system statistics for observability
   */
  getStats(): {
    totalMemories: number;
    activeMemories: number;
    dormantMemories: number;
    sessionSummaries: number;
    embeddingCacheHitRate: number | null;
  } {
    const total = this.db.getMemoryCount();
    const active = this.db.raw<{ count: number }>(
      'SELECT COUNT(*) as count FROM memories WHERE prominence >= ?',
      [PROMINENCE_THRESHOLDS.ACTIVE]
    )[0]?.count ?? 0;
    const dormant = this.db.raw<{ count: number }>(
      'SELECT COUNT(*) as count FROM memories WHERE prominence >= ? AND prominence < ?',
      [PROMINENCE_THRESHOLDS.DORMANT, PROMINENCE_THRESHOLDS.ACTIVE]
    )[0]?.count ?? 0;
    const sessionSummaries = this.db.getSessionSummaryCount();

    // Get embedding cache hit rate if using CachedEmbedder
    let embeddingCacheHitRate: number | null = null;
    if (this.embedder && 'getHitRate' in this.embedder) {
      embeddingCacheHitRate = (this.embedder as CachedEmbedder).getHitRate();
    }

    return {
      totalMemories: total,
      activeMemories: active,
      dormantMemories: dormant,
      sessionSummaries,
      embeddingCacheHitRate,
    };
  }

  /**
   * Get graph data for 3D memory map visualization.
   * Returns memories, relations, and PCA-projected 3D positions.
   */
  getGraphData(userId: string = 'default'): {
    memories: Array<{
      id: string; content: string; category: string; memoryType: string;
      importance: number; confidence: number; prominence: number;
      isLatest: boolean; hasEmbedding: boolean; accessCount: number;
      createdAt: number; updatedAt: number;
    }>;
    relations: Array<{
      id: string; sourceId: string; targetId: string;
      relationType: string; confidence: number; createdAt: number;
    }>;
    positions: Record<string, [number, number, number]> | null;
  } {
    // 1. Fetch memories
    const rawMemories = this.db.getMemoriesByUser(userId, {
      minProminence: 0.01,
      limit: 500,
      includeAllSources: true,
    });

    const memoryIds = new Set(rawMemories.map(m => m.id));

    // 2. Fetch relations, filter to edges within the memory set
    const allRelations = this.db.getAllRelations();
    const relations = allRelations.filter(
      r => memoryIds.has(r.sourceId) && memoryIds.has(r.targetId)
    );

    // 3. Compute 3D positions via server-side PCA
    const embeddingMap = new Map<string, number[]>();
    for (const m of rawMemories) {
      if (m.embedding && m.embedding.length > 0) {
        embeddingMap.set(m.id, m.embedding);
      }
    }

    let positions: Record<string, [number, number, number]> | null = null;

    if (embeddingMap.size >= 3) {
      const ids = Array.from(embeddingMap.keys());
      const dim = embeddingMap.get(ids[0])!.length;
      const n = ids.length;

      // Build matrix and compute mean
      const mean = new Float64Array(dim);
      const matrix: Float64Array[] = [];
      for (const id of ids) {
        const vec = new Float64Array(embeddingMap.get(id)!);
        matrix.push(vec);
        for (let j = 0; j < dim; j++) mean[j] += vec[j];
      }
      for (let j = 0; j < dim; j++) mean[j] /= n;

      // Center data
      for (const vec of matrix) {
        for (let j = 0; j < dim; j++) vec[j] -= mean[j];
      }

      // Power iteration for top 3 principal components
      const components: Float64Array[] = [];
      for (let comp = 0; comp < 3; comp++) {
        let v = new Float64Array(dim);
        for (let j = 0; j < dim; j++) v[j] = Math.random() - 0.5;

        for (let iter = 0; iter < 50; iter++) {
          // Compute X^T * X * v
          const newV = new Float64Array(dim);
          for (const row of matrix) {
            let dot = 0;
            for (let j = 0; j < dim; j++) dot += row[j] * v[j];
            for (let j = 0; j < dim; j++) newV[j] += dot * row[j];
          }

          // Gram-Schmidt orthogonalization against previous components
          for (const prev of components) {
            let dot = 0;
            for (let j = 0; j < dim; j++) dot += newV[j] * prev[j];
            for (let j = 0; j < dim; j++) newV[j] -= dot * prev[j];
          }

          // Normalize
          let norm = 0;
          for (let j = 0; j < dim; j++) norm += newV[j] * newV[j];
          norm = Math.sqrt(norm);
          if (norm > 0) {
            for (let j = 0; j < dim; j++) newV[j] /= norm;
          }
          v = newV;
        }
        components.push(v);
      }

      // Project data onto 3 components
      const projected: [number, number, number][] = [];
      for (const row of matrix) {
        const p: [number, number, number] = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          let dot = 0;
          for (let j = 0; j < dim; j++) dot += row[j] * components[c][j];
          p[c] = dot;
        }
        projected.push(p);
      }

      // Uniform normalization: use the single largest axis range so
      // proportions are preserved (avoids stretching into a cube)
      let globalMax = 0;
      for (let c = 0; c < 3; c++) {
        for (const p of projected) {
          const abs = Math.abs(p[c]);
          if (abs > globalMax) globalMax = abs;
        }
      }
      const scale = globalMax > 0 ? 10 / globalMax : 1;
      for (const p of projected) {
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
      }

      // Build positions map
      positions = {};
      for (let i = 0; i < ids.length; i++) {
        positions[ids[i]] = projected[i];
      }

      // Assign random positions on a sphere for memories without embeddings
      for (const m of rawMemories) {
        if (!positions[m.id]) {
          const theta = Math.random() * 2 * Math.PI;
          const phi = Math.acos(2 * Math.random() - 1);
          const r = 8 + Math.random() * 2; // radius 8-10, on the outer shell
          positions[m.id] = [
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.sin(phi) * Math.sin(theta),
            r * Math.cos(phi),
          ];
        }
      }
    } else {
      // No embeddings available — place all memories on a sphere
      positions = {};
      for (const m of rawMemories) {
        const theta = Math.random() * 2 * Math.PI;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 4 + Math.random() * 6; // radius 4-10, distributed through volume
        positions[m.id] = [
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi),
        ];
      }
    }

    // 4. Strip embeddings from response
    const memories = rawMemories.map(m => ({
      id: m.id,
      content: m.content,
      category: m.category,
      memoryType: m.memoryType,
      importance: m.importance,
      confidence: m.confidence,
      prominence: m.prominence,
      isLatest: m.isLatest,
      hasEmbedding: m.embedding !== null,
      accessCount: m.accessCount,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    return { memories, relations, positions };
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
