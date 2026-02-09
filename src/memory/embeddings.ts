/**
 * Vector Embeddings for Semantic Search
 *
 * Provides multiple embedding backends:
 * - TF-IDF: Local, no external dependencies (default)
 * - OpenAI: High quality embeddings via API
 *
 * Embeddings are used for semantic similarity search in the memory system.
 */

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  /** Provider name */
  name: string;
  /** Embedding dimension */
  dimension: number;
  /** Generate embedding for text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Check if provider is available */
  isAvailable(): boolean;
}

/**
 * TF-IDF based embeddings (local, no external dependencies)
 *
 * Creates sparse embeddings based on term frequency-inverse document frequency.
 * Uses a fixed vocabulary built from common English words plus domain terms.
 */
export class TFIDFEmbedder implements EmbeddingProvider {
  name = 'tfidf';
  dimension: number;

  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount = 0;
  private documentFrequency: Map<string, number> = new Map();

  constructor(vocabSize: number = 1000) {
    this.dimension = vocabSize;
    this.initializeVocabulary();
  }

  private initializeVocabulary(): void {
    // Common English words and programming terms
    const baseVocab = [
      // Common words
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
      'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
      'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
      'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
      'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
      'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
      'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
      'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
      'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',

      // Programming and tech terms
      'code', 'function', 'class', 'method', 'variable', 'type', 'string', 'number', 'boolean', 'array',
      'object', 'interface', 'module', 'import', 'export', 'async', 'await', 'promise', 'error', 'exception',
      'file', 'read', 'write', 'create', 'delete', 'update', 'list', 'find', 'search', 'filter',
      'map', 'reduce', 'sort', 'api', 'http', 'request', 'response', 'server', 'client', 'database',
      'query', 'table', 'column', 'row', 'json', 'xml', 'html', 'css', 'javascript', 'typescript',
      'python', 'java', 'rust', 'go', 'node', 'react', 'vue', 'angular', 'svelte', 'next',
      'test', 'unit', 'integration', 'mock', 'stub', 'assert', 'expect', 'describe', 'it', 'before',
      'git', 'commit', 'branch', 'merge', 'push', 'pull', 'clone', 'repository', 'remote', 'origin',
      'docker', 'container', 'image', 'kubernetes', 'deploy', 'build', 'run', 'start', 'stop', 'restart',
      'config', 'environment', 'variable', 'setting', 'option', 'parameter', 'argument', 'flag', 'command', 'cli',

      // Memory and AI terms
      'memory', 'remember', 'forget', 'recall', 'fact', 'preference', 'context', 'session', 'user', 'assistant',
      'model', 'prompt', 'completion', 'token', 'embedding', 'vector', 'similarity', 'search', 'semantic', 'keyword',
      'agent', 'tool', 'skill', 'action', 'task', 'goal', 'plan', 'execute', 'result', 'output',

      // Common actions and states
      'want', 'need', 'like', 'prefer', 'love', 'hate', 'enjoy', 'help', 'fix', 'solve',
      'implement', 'add', 'remove', 'change', 'modify', 'refactor', 'optimize', 'improve', 'debug', 'trace',
      'enable', 'disable', 'configure', 'setup', 'install', 'uninstall', 'upgrade', 'downgrade', 'migrate', 'backup',
    ];

    // Add vocabulary with indices
    let index = 0;
    for (const word of baseVocab) {
      if (!this.vocabulary.has(word)) {
        this.vocabulary.set(word, index++);
      }
    }

    // Fill remaining slots with character n-grams for OOV handling
    const ngrams = this.generateCharNgrams();
    for (const ngram of ngrams) {
      if (index >= this.dimension) break;
      if (!this.vocabulary.has(ngram)) {
        this.vocabulary.set(ngram, index++);
      }
    }

    this.dimension = index;
  }

  private generateCharNgrams(): string[] {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const ngrams: string[] = [];

    // Generate common 2-grams
    for (let i = 0; i < chars.length; i++) {
      for (let j = 0; j < chars.length; j++) {
        ngrams.push(chars[i] + chars[j]);
      }
    }

    return ngrams;
  }

  isAvailable(): boolean {
    return true;
  }

  /**
   * Tokenize text into terms
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  /**
   * Add document to IDF calculation
   */
  addDocument(text: string): void {
    const terms = new Set(this.tokenize(text));
    this.documentCount++;

    for (const term of terms) {
      const count = this.documentFrequency.get(term) || 0;
      this.documentFrequency.set(term, count + 1);
    }

    // Recalculate IDF
    this.updateIDF();
  }

  /**
   * Add multiple documents
   */
  addDocuments(texts: string[]): void {
    for (const text of texts) {
      const terms = new Set(this.tokenize(text));
      this.documentCount++;

      for (const term of terms) {
        const count = this.documentFrequency.get(term) || 0;
        this.documentFrequency.set(term, count + 1);
      }
    }

    this.updateIDF();
  }

  private updateIDF(): void {
    for (const [term, df] of this.documentFrequency) {
      this.idf.set(term, Math.log((this.documentCount + 1) / (df + 1)) + 1);
    }
  }

  /**
   * Synchronous embed - TF-IDF computation is actually synchronous
   */
  embedSync(text: string): number[] {
    const terms = this.tokenize(text);
    const vector = new Array(this.dimension).fill(0);

    // Calculate term frequency
    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // Create TF-IDF vector
    for (const [term, freq] of tf) {
      const index = this.vocabulary.get(term);
      if (index !== undefined) {
        const idfValue = this.idf.get(term) || Math.log(this.documentCount + 2);
        vector[index] = (freq / terms.length) * idfValue;
      }

      // Also add character n-grams for OOV handling
      if (term.length >= 2) {
        for (let i = 0; i < term.length - 1; i++) {
          const ngram = term.slice(i, i + 2);
          const ngramIndex = this.vocabulary.get(ngram);
          if (ngramIndex !== undefined) {
            vector[ngramIndex] += 0.1 * (freq / terms.length);
          }
        }
      }
    }

    // L2 normalize
    return this.normalize(vector);
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  }
}

/**
 * OpenAI Embeddings Provider
 */
export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIEmbedder implements EmbeddingProvider {
  name = 'openai';
  dimension = 1536; // text-embedding-3-small default

  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(options: OpenAIEmbedderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model || 'text-embedding-3-small';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';

    // Update dimension based on model
    if (this.model === 'text-embedding-3-large') {
      this.dimension = 3072;
    } else if (this.model === 'text-embedding-ada-002') {
      this.dimension = 1536;
    }
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * Calculate cosine similarity between two vectors.
 * Returns 0 for dimension mismatches instead of throwing (graceful degradation).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0; // Dimension mismatch - incompatible embeddings, not comparable
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Calculate euclidean distance between two vectors
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same dimension');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Options for EmbeddingCache
 */
export interface EmbeddingCacheOptions {
  /** Maximum number of entries (default: 2000 for ~8MB with 1000-dim vectors) */
  maxSize?: number;
  /** Estimated bytes per float (default: 8 for Float64) */
  bytesPerFloat?: number;
  /** Maximum memory in bytes (default: 50MB). Takes precedence over maxSize if set. */
  maxMemoryBytes?: number;
}

/**
 * Embedding cache for avoiding recomputation
 * Memory-aware with configurable limits suitable for 4GB servers
 */
export class EmbeddingCache {
  private cache: Map<string, number[]> = new Map();
  private accessOrder: string[] = []; // For LRU eviction
  private maxSize: number;
  private maxMemoryBytes: number;
  private bytesPerFloat: number;
  private estimatedDimension: number = 0;

  constructor(options: EmbeddingCacheOptions | number = {}) {
    // Support legacy constructor signature
    if (typeof options === 'number') {
      this.maxSize = options;
      this.maxMemoryBytes = 50 * 1024 * 1024; // 50MB default
      this.bytesPerFloat = 8;
    } else {
      this.maxSize = options.maxSize ?? 2000;
      this.maxMemoryBytes = options.maxMemoryBytes ?? 50 * 1024 * 1024;
      this.bytesPerFloat = options.bytesPerFloat ?? 8;
    }
  }

  get(key: string): number[] | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end of access order (most recently used)
      const idx = this.accessOrder.indexOf(key);
      if (idx > -1) {
        this.accessOrder.splice(idx, 1);
        this.accessOrder.push(key);
      }
    }
    return value;
  }

  set(key: string, embedding: number[]): void {
    // Track dimension for memory estimation
    if (this.estimatedDimension === 0 && embedding.length > 0) {
      this.estimatedDimension = embedding.length;
    }

    // Check memory limit
    const currentMemory = this.estimateMemoryUsage();
    const newEntrySize = embedding.length * this.bytesPerFloat;

    // Evict entries if needed (LRU)
    while (
      (this.cache.size >= this.maxSize || currentMemory + newEntrySize > this.maxMemoryBytes) &&
      this.accessOrder.length > 0
    ) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, embedding);
    this.accessOrder.push(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Estimate current memory usage in bytes
   */
  estimateMemoryUsage(): number {
    if (this.estimatedDimension === 0) return 0;
    return this.cache.size * this.estimatedDimension * this.bytesPerFloat;
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; estimatedMemoryMB: number; maxMemoryMB: number } {
    return {
      size: this.cache.size,
      estimatedMemoryMB: this.estimateMemoryUsage() / (1024 * 1024),
      maxMemoryMB: this.maxMemoryBytes / (1024 * 1024),
    };
  }
}

/**
 * Ollama Embeddings Provider
 * Uses local Ollama instance for embeddings (e.g., EmbeddingGemma, nomic-embed-text)
 */
export interface OllamaEmbedderOptions {
  /** Ollama API base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Model name (default: embeddinggemma) */
  model?: string;
}

export class OllamaEmbedder implements EmbeddingProvider {
  name = 'ollama';
  dimension = 768; // EmbeddingGemma default

  private baseUrl: string;
  private model: string;

  constructor(options: OllamaEmbedderOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:11434';
    this.model = options.model || 'embeddinggemma';

    // Adjust dimension based on model
    if (this.model.includes('nomic')) {
      this.dimension = 768;
    } else if (this.model.includes('mxbai')) {
      this.dimension = 1024;
    } else if (this.model.includes('all-minilm')) {
      this.dimension = 384;
    }
  }

  isAvailable(): boolean {
    // TODO: Could ping Ollama to check availability
    return true;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      embedding: number[];
    };

    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't have batch endpoint, so we do them sequentially
    const embeddings: number[][] = [];
    for (const text of texts) {
      embeddings.push(await this.embed(text));
    }
    return embeddings;
  }
}

/**
 * Fallback Embedder - wraps a primary embedder with TF-IDF fallback.
 * When the primary embedder fails (network error, API down), automatically
 * falls back to local TF-IDF embeddings to prevent data loss.
 */
export class FallbackEmbedder implements EmbeddingProvider {
  name: string;
  dimension: number;

  private primary: EmbeddingProvider;
  private fallback: TFIDFEmbedder;
  private usingFallback = false;
  private consecutiveFailures = 0;
  private static readonly MAX_FAILURES_BEFORE_FALLBACK = 3;

  constructor(primary: EmbeddingProvider, fallback?: TFIDFEmbedder) {
    this.primary = primary;
    this.fallback = fallback ?? new TFIDFEmbedder();
    this.name = `fallback(${primary.name})`;
    this.dimension = primary.dimension;
  }

  isAvailable(): boolean {
    return this.primary.isAvailable() || this.fallback.isAvailable();
  }

  async embed(text: string): Promise<number[]> {
    // If too many consecutive failures, use fallback directly
    if (this.usingFallback) {
      return this.fallback.embed(text);
    }

    try {
      const result = await this.primary.embed(text);
      this.consecutiveFailures = 0;
      return result;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FallbackEmbedder.MAX_FAILURES_BEFORE_FALLBACK) {
        this.usingFallback = true;
        this.dimension = this.fallback.dimension;
        // Schedule a retry of the primary after 5 minutes
        setTimeout(() => {
          this.usingFallback = false;
          this.consecutiveFailures = 0;
          this.dimension = this.primary.dimension;
        }, 5 * 60 * 1000);
      }
      return this.fallback.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.usingFallback) {
      return this.fallback.embedBatch(texts);
    }

    try {
      const result = await this.primary.embedBatch(texts);
      this.consecutiveFailures = 0;
      return result;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FallbackEmbedder.MAX_FAILURES_BEFORE_FALLBACK) {
        this.usingFallback = true;
        this.dimension = this.fallback.dimension;
        setTimeout(() => {
          this.usingFallback = false;
          this.consecutiveFailures = 0;
          this.dimension = this.primary.dimension;
        }, 5 * 60 * 1000);
      }
      return this.fallback.embedBatch(texts);
    }
  }

  /** Check if currently using fallback */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /** Reset to try primary again */
  resetFallback(): void {
    this.usingFallback = false;
    this.consecutiveFailures = 0;
    this.dimension = this.primary.dimension;
  }
}

/**
 * CachedEmbedder - wraps any EmbeddingProvider with EmbeddingCache
 * to avoid recomputing embeddings for previously seen texts.
 */
export class CachedEmbedder implements EmbeddingProvider {
  name: string;
  dimension: number;

  private inner: EmbeddingProvider;
  private cache: EmbeddingCache;
  private hits = 0;
  private misses = 0;

  constructor(inner: EmbeddingProvider, cache?: EmbeddingCache) {
    this.inner = inner;
    this.cache = cache ?? new EmbeddingCache();
    this.name = `cached(${inner.name})`;
    this.dimension = inner.dimension;
  }

  /** Get the underlying embedder (for accessing provider-specific methods like TFIDFEmbedder.addDocuments) */
  getInner(): EmbeddingProvider {
    return this.inner;
  }

  isAvailable(): boolean {
    return this.inner.isAvailable();
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const embedding = await this.inner.embed(text);
    this.cache.set(text, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
        this.hits++;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
        this.misses++;
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.inner.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        results[uncachedIndices[j]] = embeddings[j];
        this.cache.set(uncachedTexts[j], embeddings[j]);
      }
    }

    return results;
  }

  /** Get cache hit rate (0-1) */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** Get cache stats */
  getCacheStats(): { hits: number; misses: number; hitRate: number; cacheSize: number; estimatedMemoryMB: number } {
    const cacheStats = this.cache.getStats();
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.getHitRate(),
      cacheSize: cacheStats.size,
      estimatedMemoryMB: cacheStats.estimatedMemoryMB,
    };
  }
}

/**
 * Create default embedding provider (TF-IDF)
 */
export function createDefaultEmbedder(): EmbeddingProvider {
  return new TFIDFEmbedder();
}

/**
 * Create OpenAI embedding provider
 */
export function createOpenAIEmbedder(apiKey: string, model?: string): EmbeddingProvider {
  return new OpenAIEmbedder({ apiKey, model });
}

/**
 * Create Ollama embedding provider
 */
export function createOllamaEmbedder(options?: OllamaEmbedderOptions): EmbeddingProvider {
  return new OllamaEmbedder(options);
}
