/**
 * Caching System
 * Semantic response cache with TTL and tool output deduplication
 */

import { createHash } from 'crypto';

/**
 * Generate a hash for content
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Compute similarity between two strings using Jaccard similarity
 */
export function computeSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .split(/\s+/)
      .filter((w) => w.length > 0);

  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  return intersection / union;
}

export interface SemanticMatcherOptions {
  threshold: number;
}

export interface MatchResult {
  candidate: string;
  score: number;
}

/**
 * Semantic matcher for finding similar queries
 */
export class SemanticMatcher {
  private threshold: number;

  constructor(options: SemanticMatcherOptions) {
    this.threshold = options.threshold;
  }

  isMatch(query: string, candidate: string): boolean {
    const score = computeSimilarity(query, candidate);
    return score >= this.threshold;
  }

  findBestMatch(query: string, candidates: string[]): MatchResult | undefined {
    let bestMatch: MatchResult | undefined;

    for (const candidate of candidates) {
      const score = computeSimilarity(query, candidate);
      if (score >= this.threshold) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { candidate, score };
        }
      }
    }

    return bestMatch;
  }
}

export interface CacheEntry<T = string> {
  value: T;
  timestamp: number;
  query: string;
  metadata?: Record<string, unknown>;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface ResponseCacheOptions {
  maxSize: number;
  ttlMs: number;
  semanticThreshold: number;
}

/**
 * Response cache with semantic matching and TTL
 */
export class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map();
  private queryIndex: Map<string, string> = new Map(); // query -> hash
  private maxSize: number;
  private ttlMs: number;
  private matcher: SemanticMatcher;
  private hits = 0;
  private misses = 0;

  constructor(options: ResponseCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.matcher = new SemanticMatcher({ threshold: options.semanticThreshold });
  }

  set(query: string, response: string, metadata?: Record<string, unknown>): void {
    // Evict expired entries
    this.evictExpired();

    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const hash = hashContent(query);
    const entry: CacheEntry = {
      value: response,
      timestamp: Date.now(),
      query,
      metadata,
    };

    this.cache.set(hash, entry);
    this.queryIndex.set(query, hash);
  }

  get(query: string): string | undefined {
    const entry = this.getEntry(query);
    if (entry) {
      this.hits++;
      return entry.value;
    }
    this.misses++;
    return undefined;
  }

  getEntry(query: string): CacheEntry | undefined {
    // Try exact match first
    const hash = hashContent(query);
    let entry = this.cache.get(hash);

    if (entry && this.isExpired(entry)) {
      this.cache.delete(hash);
      this.queryIndex.delete(entry.query);
      entry = undefined;
    }

    if (entry) {
      return entry;
    }

    // Try semantic match
    const queries = Array.from(this.queryIndex.keys());
    const match = this.matcher.findBestMatch(query, queries);

    if (match) {
      const matchHash = this.queryIndex.get(match.candidate);
      if (matchHash) {
        entry = this.cache.get(matchHash);
        if (entry && !this.isExpired(entry)) {
          return entry;
        }
      }
    }

    return undefined;
  }

  invalidate(query: string): void {
    const hash = hashContent(query);
    const entry = this.cache.get(hash);
    if (entry) {
      this.cache.delete(hash);
      this.queryIndex.delete(entry.query);
    }
  }

  clear(): void {
    this.cache.clear();
    this.queryIndex.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > this.ttlMs;
  }

  private evictExpired(): void {
    for (const [hash, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(hash);
        this.queryIndex.delete(entry.query);
      }
    }
  }

  private evictOldest(): void {
    let oldestHash: string | undefined;
    let oldestTime = Infinity;

    for (const [hash, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestHash = hash;
      }
    }

    if (oldestHash) {
      const entry = this.cache.get(oldestHash);
      if (entry) {
        this.queryIndex.delete(entry.query);
      }
      this.cache.delete(oldestHash);
    }
  }
}

export interface ToolCacheEntry {
  output: string;
  timestamp: number;
  toolName: string;
  inputHash: string;
  inputJson: string;
}

export interface ToolOutputCacheOptions {
  maxSize: number;
  ttlMs: number;
}

/**
 * Tool output cache with deduplication
 */
export class ToolOutputCache {
  private cache: Map<string, ToolCacheEntry> = new Map();
  private maxSize: number;
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(options: ToolOutputCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  private makeKey(toolName: string, input: Record<string, unknown>): string {
    const inputHash = hashContent(JSON.stringify(input));
    return `${toolName}:${inputHash}`;
  }

  set(toolName: string, input: Record<string, unknown>, output: string): void {
    this.evictExpired();

    while (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const key = this.makeKey(toolName, input);
    const inputHash = hashContent(JSON.stringify(input));

    this.cache.set(key, {
      output,
      timestamp: Date.now(),
      toolName,
      inputHash,
      inputJson: JSON.stringify(input),
    });
  }

  get(toolName: string, input: Record<string, unknown>): string | undefined {
    const key = this.makeKey(toolName, input);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry.output;
  }

  invalidateByTool(toolName: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
      }
    }
  }

  invalidateByPattern(pattern: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.inputJson.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  onWrite(path: string): void {
    // Invalidate any read cache for this file
    this.invalidateByPattern(path);

    // Invalidate parent directory listings
    const parentDir = path.substring(0, path.lastIndexOf('/'));
    if (parentDir) {
      for (const [key, entry] of this.cache) {
        if (
          entry.toolName === 'bash' &&
          entry.inputJson.includes('ls') &&
          entry.inputJson.includes(parentDir)
        ) {
          this.cache.delete(key);
        }
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  private isExpired(entry: ToolCacheEntry): boolean {
    return Date.now() - entry.timestamp > this.ttlMs;
  }

  private evictExpired(): void {
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
