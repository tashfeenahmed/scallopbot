/**
 * Tests for Vector Embeddings
 */

import { describe, it, expect } from 'vitest';
import {
  TFIDFEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  EmbeddingCache,
  cosineSimilarity,
  euclideanDistance,
  createDefaultEmbedder,
  createOpenAIEmbedder,
  createOllamaEmbedder,
} from './embeddings.js';

describe('TFIDFEmbedder', () => {
  describe('constructor', () => {
    it('should create embedder with default vocabulary size', () => {
      const embedder = new TFIDFEmbedder();
      expect(embedder.name).toBe('tfidf');
      expect(embedder.dimension).toBeGreaterThan(0);
    });

    it('should create embedder with custom vocabulary size', () => {
      const embedder = new TFIDFEmbedder(500);
      expect(embedder.dimension).toBeLessThanOrEqual(500 + 1296); // base + ngrams
    });
  });

  describe('isAvailable', () => {
    it('should always return true', () => {
      const embedder = new TFIDFEmbedder();
      expect(embedder.isAvailable()).toBe(true);
    });
  });

  describe('embedSync', () => {
    it('should generate embedding vector', () => {
      const embedder = new TFIDFEmbedder();
      const embedding = embedder.embedSync('hello world');

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(embedder.dimension);
    });

    it('should generate normalized vector', () => {
      const embedder = new TFIDFEmbedder();
      const embedding = embedder.embedSync('test embedding');

      // Calculate magnitude
      const magnitude = Math.sqrt(
        embedding.reduce((sum, v) => sum + v * v, 0)
      );

      // Should be normalized to ~1 (allowing small floating point error)
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('should handle empty string', () => {
      const embedder = new TFIDFEmbedder();
      const embedding = embedder.embedSync('');

      // Empty string should return zero vector
      const allZeros = embedding.every((v) => v === 0);
      expect(allZeros).toBe(true);
    });
  });

  describe('embed', () => {
    it('should return same result as embedSync (async wrapper)', async () => {
      const embedder = new TFIDFEmbedder();
      const sync = embedder.embedSync('test');
      const async = await embedder.embed('test');

      expect(sync).toEqual(async);
    });
  });

  describe('embedBatch', () => {
    it('should embed multiple texts', async () => {
      const embedder = new TFIDFEmbedder();
      const texts = ['hello', 'world', 'test'];
      const embeddings = await embedder.embedBatch(texts);

      expect(embeddings.length).toBe(3);
      expect(embeddings[0].length).toBe(embedder.dimension);
    });
  });

  describe('addDocument', () => {
    it('should update IDF values', () => {
      const embedder = new TFIDFEmbedder();

      // Add documents to train IDF
      embedder.addDocument('machine learning algorithms');
      embedder.addDocument('deep learning neural networks');
      embedder.addDocument('learning is important');

      // 'learning' appears in all docs, should have low IDF
      const embedding = embedder.embedSync('learning');
      expect(embedding.some((v) => v > 0)).toBe(true);
    });
  });

  describe('addDocuments', () => {
    it('should add multiple documents at once', () => {
      const embedder = new TFIDFEmbedder();
      embedder.addDocuments(['doc one', 'doc two', 'doc three']);

      const embedding = embedder.embedSync('doc');
      expect(embedding.some((v) => v > 0)).toBe(true);
    });
  });

  describe('semantic similarity', () => {
    it('should give higher similarity for related concepts', () => {
      const embedder = new TFIDFEmbedder();

      const embedding1 = embedder.embedSync('javascript nodejs programming');
      const embedding2 = embedder.embedSync('typescript code development');
      const embedding3 = embedder.embedSync('banana fruit yellow');

      const sim1to2 = cosineSimilarity(embedding1, embedding2);
      const sim1to3 = cosineSimilarity(embedding1, embedding3);

      // Programming-related texts should be more similar
      expect(sim1to2).toBeGreaterThan(sim1to3);
    });

    it('should find similar content with different wording', () => {
      const embedder = new TFIDFEmbedder();

      const embedding1 = embedder.embedSync('user codes in nodejs for backend');
      const embedding2 = embedder.embedSync('server side javascript node');

      const similarity = cosineSimilarity(embedding1, embedding2);
      // Should have some similarity due to shared programming context
      expect(similarity).toBeGreaterThan(0);
    });
  });
});

describe('OpenAIEmbedder', () => {
  describe('constructor', () => {
    it('should create embedder with API key', () => {
      const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
      expect(embedder.name).toBe('openai');
      expect(embedder.dimension).toBe(1536);
    });

    it('should use custom model dimensions', () => {
      const embedder = new OpenAIEmbedder({
        apiKey: 'test-key',
        model: 'text-embedding-3-large',
      });
      expect(embedder.dimension).toBe(3072);
    });

    it('should support ada-002 model', () => {
      const embedder = new OpenAIEmbedder({
        apiKey: 'test-key',
        model: 'text-embedding-ada-002',
      });
      expect(embedder.dimension).toBe(1536);
    });
  });

  describe('isAvailable', () => {
    it('should return true if API key is provided', () => {
      const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
      expect(embedder.isAvailable()).toBe(true);
    });

    it('should return false if no API key', () => {
      const embedder = new OpenAIEmbedder({ apiKey: '' });
      expect(embedder.isAvailable()).toBe(false);
    });
  });
});

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('should return -1 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('should handle non-normalized vectors', () => {
    const a = [2, 0, 0];
    const b = [4, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('should return 0 for mismatched dimensions (graceful degradation)', () => {
    const a = [1, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should return 0 for zero vectors', () => {
    const a = [0, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('euclideanDistance', () => {
  it('should return 0 for identical vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(euclideanDistance(a, b)).toBe(0);
  });

  it('should calculate correct distance', () => {
    const a = [0, 0, 0];
    const b = [3, 4, 0];
    expect(euclideanDistance(a, b)).toBe(5);
  });

  it('should throw for mismatched dimensions', () => {
    const a = [1, 0];
    const b = [1, 0, 0];
    expect(() => euclideanDistance(a, b)).toThrow('Vectors must have the same dimension');
  });
});

describe('EmbeddingCache', () => {
  describe('constructor', () => {
    it('should create cache with default size', () => {
      const cache = new EmbeddingCache();
      expect(cache.size).toBe(0);
    });

    it('should create cache with custom size', () => {
      const cache = new EmbeddingCache(100);
      expect(cache.size).toBe(0);
    });
  });

  describe('get/set', () => {
    it('should store and retrieve embeddings', () => {
      const cache = new EmbeddingCache();
      const embedding = [0.1, 0.2, 0.3];

      cache.set('key1', embedding);
      expect(cache.get('key1')).toEqual(embedding);
    });

    it('should return undefined for missing key', () => {
      const cache = new EmbeddingCache();
      expect(cache.get('nonexistent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing key', () => {
      const cache = new EmbeddingCache();
      cache.set('key1', [0.1]);

      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for missing key', () => {
      const cache = new EmbeddingCache();
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('eviction', () => {
    it('should evict oldest entry when full', () => {
      const cache = new EmbeddingCache(3);

      cache.set('key1', [0.1]);
      cache.set('key2', [0.2]);
      cache.set('key3', [0.3]);
      cache.set('key4', [0.4]); // Should evict key1

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key4')).toBe(true);
      expect(cache.size).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const cache = new EmbeddingCache();
      cache.set('key1', [0.1]);
      cache.set('key2', [0.2]);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.has('key1')).toBe(false);
    });
  });
});

describe('createDefaultEmbedder', () => {
  it('should create TFIDFEmbedder', () => {
    const embedder = createDefaultEmbedder();
    expect(embedder.name).toBe('tfidf');
    expect(embedder.isAvailable()).toBe(true);
  });
});

describe('createOpenAIEmbedder', () => {
  it('should create OpenAIEmbedder with key', () => {
    const embedder = createOpenAIEmbedder('test-key');
    expect(embedder.name).toBe('openai');
  });

  it('should create OpenAIEmbedder with custom model', () => {
    const embedder = createOpenAIEmbedder('test-key', 'text-embedding-3-large');
    expect(embedder.dimension).toBe(3072);
  });
});

describe('OllamaEmbedder', () => {
  describe('constructor', () => {
    it('should create embedder with default settings', () => {
      const embedder = new OllamaEmbedder();
      expect(embedder.name).toBe('ollama');
      expect(embedder.dimension).toBe(768); // embeddinggemma default
    });

    it('should use custom model', () => {
      const embedder = new OllamaEmbedder({ model: 'nomic-embed-text' });
      expect(embedder.dimension).toBe(768);
    });

    it('should adjust dimension for mxbai model', () => {
      const embedder = new OllamaEmbedder({ model: 'mxbai-embed-large' });
      expect(embedder.dimension).toBe(1024);
    });

    it('should adjust dimension for all-minilm model', () => {
      const embedder = new OllamaEmbedder({ model: 'all-minilm' });
      expect(embedder.dimension).toBe(384);
    });

    it('should use custom base URL', () => {
      const embedder = new OllamaEmbedder({ baseUrl: 'http://remote:11434' });
      expect(embedder.name).toBe('ollama');
    });
  });

  describe('isAvailable', () => {
    it('should return true', () => {
      const embedder = new OllamaEmbedder();
      expect(embedder.isAvailable()).toBe(true);
    });
  });
});

describe('createOllamaEmbedder', () => {
  it('should create OllamaEmbedder with defaults', () => {
    const embedder = createOllamaEmbedder();
    expect(embedder.name).toBe('ollama');
  });

  it('should create OllamaEmbedder with custom options', () => {
    const embedder = createOllamaEmbedder({
      baseUrl: 'http://localhost:11435',
      model: 'nomic-embed-text',
    });
    expect(embedder.name).toBe('ollama');
    expect(embedder.dimension).toBe(768);
  });
});
