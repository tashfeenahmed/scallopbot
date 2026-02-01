/**
 * Gardener Memory System
 * Hot collector, background gardener, and hybrid search
 */

import type { Logger } from 'pino';
import { nanoid } from 'nanoid';

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

/**
 * In-memory store for memories
 */
export class MemoryStore {
  private memories: Map<string, MemoryEntry> = new Map();

  add(entry: PartialMemoryEntry): MemoryEntry {
    const id = entry.id || nanoid();
    const memory: MemoryEntry = {
      ...entry,
      id,
    };
    this.memories.set(id, memory);
    return memory;
  }

  get(id: string): MemoryEntry | undefined {
    return this.memories.get(id);
  }

  delete(id: string): boolean {
    return this.memories.delete(id);
  }

  update(id: string, updates: Partial<MemoryEntry>): MemoryEntry | undefined {
    const existing = this.memories.get(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...updates, id };
    this.memories.set(id, updated);
    return updated;
  }

  search(query: string): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.content.toLowerCase().includes(lowerQuery)) {
        results.push(memory);
      }
    }

    return results;
  }

  searchByTag(tag: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.tags?.includes(tag)) {
        results.push(memory);
      }
    }

    return results;
  }

  searchByType(type: MemoryType): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.type === type) {
        results.push(memory);
      }
    }

    return results;
  }

  getBySession(sessionId: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.sessionId === sessionId) {
        results.push(memory);
      }
    }

    return results;
  }

  getRecent(limit: number): MemoryEntry[] {
    const all = Array.from(this.memories.values());
    return all
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getAll(): MemoryEntry[] {
    return Array.from(this.memories.values());
  }

  clear(): void {
    this.memories.clear();
  }
}

export interface CollectOptions {
  content: string;
  sessionId: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface HotCollectorOptions {
  store: MemoryStore;
  maxBuffer?: number;
}

/**
 * Hot Collector - collects memories during conversation
 */
export class HotCollector {
  private store: MemoryStore;
  private buffers: Map<string, MemoryEntry[]> = new Map();
  private maxBuffer: number;

  constructor(options: HotCollectorOptions) {
    this.store = options.store;
    this.maxBuffer = options.maxBuffer ?? 100;
  }

  collect(options: CollectOptions): MemoryEntry {
    const entry: MemoryEntry = {
      id: nanoid(),
      content: options.content,
      type: 'raw',
      timestamp: new Date(),
      sessionId: options.sessionId,
      tags: options.tags,
      metadata: {
        ...options.metadata,
        source: options.source,
      },
    };

    let buffer = this.buffers.get(options.sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(options.sessionId, buffer);
    }

    buffer.push(entry);

    // Trim buffer if over limit
    if (buffer.length > this.maxBuffer) {
      buffer.shift();
    }

    return entry;
  }

  getBuffer(sessionId: string): MemoryEntry[] {
    return this.buffers.get(sessionId) || [];
  }

  flush(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return;

    for (const entry of buffer) {
      this.store.add(entry);
    }

    this.buffers.set(sessionId, []);
  }

  clear(sessionId: string): void {
    this.buffers.set(sessionId, []);
  }

  flushAll(): void {
    for (const sessionId of this.buffers.keys()) {
      this.flush(sessionId);
    }
  }
}

/**
 * Extract facts from text
 */
export function extractFacts(text: string): string[] {
  if (!text.trim()) return [];

  const facts: string[] = [];

  // Name patterns
  const namePatterns = [
    /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
    /(?:i'm|i am)\s+([A-Z][a-z]+)/gi,
  ];

  // Location patterns
  const locationPatterns = [
    /(?:i live in|i'm from|i am from|i'm in|located in|based in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ];

  // Job patterns
  const jobPatterns = [
    /(?:i work as|i am a|i'm a|work as a|my job is)\s+([a-z]+(?:\s+[a-z]+)*)/gi,
    /(?:work at|working at|employed at|employed by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ];

  // Preference patterns
  const preferencePatterns = [
    /(?:i prefer|i like|i love|i enjoy|i hate|i dislike)\s+([^.,!?]+)/gi,
  ];

  // Extract names
  for (const pattern of namePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      facts.push(`Name: ${match[1]}`);
    }
  }

  // Extract locations
  for (const pattern of locationPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      facts.push(`Location: ${match[1]}`);
    }
  }

  // Extract jobs
  for (const pattern of jobPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      facts.push(`Occupation: ${match[1]}`);
    }
  }

  // Extract preferences
  for (const pattern of preferencePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      facts.push(`Preference: ${match[0].trim()}`);
    }
  }

  // Deduplicate
  return [...new Set(facts)];
}

/**
 * Summarize multiple memories into a compact form
 */
export function summarizeMemories(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  // Group by type
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const mem of memories) {
    const group = byType.get(mem.type) || [];
    group.push(mem);
    byType.set(mem.type, group);
  }

  const parts: string[] = [];

  // Summarize each type
  for (const [type, mems] of byType) {
    if (mems.length === 1) {
      parts.push(mems[0].content);
    } else {
      // Simple concatenation with dedup
      const unique = [...new Set(mems.map((m) => m.content))];
      if (unique.length <= 3) {
        parts.push(unique.join('. '));
      } else {
        parts.push(`${type}: ${unique.slice(0, 3).join(', ')} (and ${unique.length - 3} more)`);
      }
    }
  }

  return parts.join(' | ');
}

export interface BackgroundGardenerOptions {
  store: MemoryStore;
  logger: Logger;
  interval?: number;
}

/**
 * Background Gardener - processes and organizes memories
 */
export class BackgroundGardener {
  private store: MemoryStore;
  private logger: Logger;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: BackgroundGardenerOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ component: 'gardener' });
    this.interval = options.interval ?? 60000; // Default 1 minute
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      this.processMemories();
    }, this.interval);

    this.logger.info('Background gardener started');
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Background gardener stopped');
  }

  processMemories(): void {
    this.logger.debug('Processing memories');

    // Get raw memories that need processing
    const rawMemories = this.store.searchByType('raw');

    for (const memory of rawMemories) {
      // Extract facts
      const facts = extractFacts(memory.content);

      for (const fact of facts) {
        this.store.add({
          content: fact,
          type: 'fact',
          timestamp: new Date(),
          sessionId: memory.sessionId,
          metadata: {
            sourceId: memory.id,
          },
        });
      }

      // Update original memory type to prevent reprocessing
      this.store.update(memory.id, { type: 'context' });
    }

    // Deduplicate periodically
    this.deduplicate();
  }

  deduplicate(): void {
    const facts = this.store.searchByType('fact');
    const seen = new Map<string, string>();
    const toDelete: string[] = [];

    for (const fact of facts) {
      const normalized = fact.content.toLowerCase().trim();

      // Check for similar content
      let isDuplicate = false;
      for (const [existing, id] of seen) {
        if (this.isSimilar(normalized, existing)) {
          toDelete.push(fact.id);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seen.set(normalized, fact.id);
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    if (toDelete.length > 0) {
      this.logger.debug({ removed: toDelete.length }, 'Deduplicated memories');
    }
  }

  private isSimilar(a: string, b: string): boolean {
    // Simple similarity check - could be enhanced with proper similarity algorithm
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;

    // Word overlap
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    const overlap = intersection.length / Math.min(wordsA.size, wordsB.size);

    return overlap > 0.8;
  }
}

export interface BM25Options {
  avgDocLength: number;
  docCount: number;
  k1?: number;
  b?: number;
}

/**
 * Calculate BM25 score for a query against a document
 */
export function calculateBM25Score(
  query: string,
  document: string,
  options: BM25Options
): number {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;

  const queryTerms = query.toLowerCase().split(/\s+/);
  const docTerms = document.toLowerCase().split(/\s+/);
  const docLength = docTerms.length;

  // Calculate term frequencies
  const docTermFreq = new Map<string, number>();
  for (const term of docTerms) {
    docTermFreq.set(term, (docTermFreq.get(term) || 0) + 1);
  }

  let score = 0;

  for (const term of queryTerms) {
    const tf = docTermFreq.get(term) || 0;
    if (tf === 0) continue;

    // Simple IDF approximation
    const idf = Math.log((options.docCount + 0.5) / (1 + 0.5));

    // BM25 term score
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / options.avgDocLength));

    score += idf * (numerator / denominator);
  }

  return score;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  matchType: 'keyword' | 'semantic' | 'hybrid';
}

export interface SearchOptions {
  limit?: number;
  type?: MemoryType;
  recencyBoost?: boolean;
  sessionId?: string;
}

export interface HybridSearchOptions {
  store: MemoryStore;
}

/**
 * Hybrid Search - combines BM25 and vector similarity
 */
export class HybridSearch {
  private store: MemoryStore;

  constructor(options: HybridSearchOptions) {
    this.store = options.store;
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 10;
    const allMemories = this.store.getAll();

    // Filter by type and session if specified
    let candidates = allMemories;
    if (options.type) {
      candidates = candidates.filter((m) => m.type === options.type);
    }
    if (options.sessionId) {
      candidates = candidates.filter((m) => m.sessionId === options.sessionId);
    }

    if (candidates.length === 0) {
      return [];
    }

    // Calculate average document length
    const avgDocLength =
      candidates.reduce((sum, m) => sum + m.content.split(/\s+/).length, 0) /
      candidates.length;

    const bm25Options: BM25Options = {
      avgDocLength,
      docCount: candidates.length,
    };

    // Score each candidate
    const results: SearchResult[] = [];

    for (const memory of candidates) {
      const bm25Score = calculateBM25Score(query, memory.content, bm25Options);
      const semanticScore = this.calculateSemanticScore(query, memory);

      // Combine scores (60% BM25, 40% semantic)
      let combinedScore = bm25Score * 0.6 + semanticScore * 0.4;

      // Apply recency boost if enabled
      if (options.recencyBoost) {
        const ageMs = Date.now() - memory.timestamp.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyMultiplier = Math.exp(-ageDays / 7); // Decay over ~1 week
        combinedScore *= 1 + recencyMultiplier * 0.5;
      }

      if (combinedScore > 0) {
        results.push({
          entry: memory,
          score: combinedScore,
          matchType: bm25Score > semanticScore ? 'keyword' : 'semantic',
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  private calculateSemanticScore(query: string, memory: MemoryEntry): number {
    // Simple semantic similarity using word overlap and related terms
    const queryTerms = new Set(query.toLowerCase().split(/\s+/));
    const memTerms = new Set(memory.content.toLowerCase().split(/\s+/));

    // Direct overlap
    const overlap = [...queryTerms].filter((t) => memTerms.has(t)).length;

    // Related terms mapping (simple semantic expansion)
    const relatedTerms: Record<string, string[]> = {
      javascript: ['js', 'node', 'typescript', 'react', 'frontend', 'backend'],
      'server-side': ['backend', 'node', 'api', 'server'],
      programming: ['coding', 'development', 'software', 'code'],
      web: ['website', 'frontend', 'html', 'css'],
    };

    let relatedScore = 0;
    for (const queryTerm of queryTerms) {
      const related = relatedTerms[queryTerm] || [];
      for (const rel of related) {
        if (memTerms.has(rel)) {
          relatedScore += 0.5;
        }
      }
    }

    // Tag matching
    let tagScore = 0;
    if (memory.tags) {
      for (const tag of memory.tags) {
        if (queryTerms.has(tag.toLowerCase())) {
          tagScore += 1;
        }
      }
    }

    const totalScore = overlap + relatedScore + tagScore;
    const maxPossible = queryTerms.size + 2; // Normalize

    return totalScore / maxPossible;
  }
}
