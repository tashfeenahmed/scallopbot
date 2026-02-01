import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ResponseCache,
  ToolOutputCache,
  SemanticMatcher,
  CacheEntry,
  computeSimilarity,
  hashContent,
} from './cache.js';

describe('hashContent', () => {
  it('should generate consistent hash for same content', () => {
    const hash1 = hashContent('Hello world');
    const hash2 = hashContent('Hello world');
    expect(hash1).toBe(hash2);
  });

  it('should generate different hash for different content', () => {
    const hash1 = hashContent('Hello world');
    const hash2 = hashContent('Hello World');
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', () => {
    const hash = hashContent('');
    expect(hash).toBeDefined();
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('computeSimilarity', () => {
  it('should return 1 for identical strings', () => {
    const score = computeSimilarity('Hello world', 'Hello world');
    expect(score).toBe(1);
  });

  it('should return 0 for completely different strings', () => {
    const score = computeSimilarity('abc', 'xyz');
    expect(score).toBe(0);
  });

  it('should return value between 0 and 1 for similar strings', () => {
    const score = computeSimilarity(
      'What is TypeScript?',
      'What is JavaScript?'
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('should be case insensitive', () => {
    const score = computeSimilarity('Hello World', 'hello world');
    expect(score).toBe(1);
  });
});

describe('SemanticMatcher', () => {
  let matcher: SemanticMatcher;

  beforeEach(() => {
    matcher = new SemanticMatcher({ threshold: 0.6 });
  });

  describe('isMatch', () => {
    it('should match identical queries', () => {
      expect(matcher.isMatch('What is TypeScript?', 'What is TypeScript?')).toBe(true);
    });

    it('should match very similar queries', () => {
      expect(matcher.isMatch(
        'What is TypeScript?',
        'what is typescript'
      )).toBe(true);
    });

    it('should not match different queries', () => {
      expect(matcher.isMatch(
        'What is TypeScript?',
        'How do I cook pasta?'
      )).toBe(false);
    });

    it('should match queries with minor word differences', () => {
      expect(matcher.isMatch(
        'explain typescript generics',
        'explain generics in typescript'
      )).toBe(true);
    });
  });

  describe('findBestMatch', () => {
    it('should find best matching query from candidates', () => {
      const candidates = [
        'How to make coffee?',
        'What is JavaScript?',
        'What is TypeScript programming?',
        'Weather forecast today',
      ];

      const result = matcher.findBestMatch('What is TypeScript?', candidates);

      expect(result).toBeDefined();
      expect(result?.candidate).toBe('What is TypeScript programming?');
    });

    it('should return undefined if no match above threshold', () => {
      const candidates = [
        'How to make coffee?',
        'Weather forecast today',
      ];

      const result = matcher.findBestMatch('What is TypeScript?', candidates);

      expect(result).toBeUndefined();
    });
  });
});

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ResponseCache({
      maxSize: 100,
      ttlMs: 60000, // 1 minute
      semanticThreshold: 0.6,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set and get', () => {
    it('should store and retrieve response', () => {
      cache.set('What is TypeScript?', 'TypeScript is a typed superset of JavaScript.');

      const result = cache.get('What is TypeScript?');

      expect(result).toBe('TypeScript is a typed superset of JavaScript.');
    });

    it('should return undefined for unknown query', () => {
      const result = cache.get('Unknown query');
      expect(result).toBeUndefined();
    });

    it('should match semantically similar queries', () => {
      cache.set('What is TypeScript?', 'TypeScript is a typed superset of JavaScript.');

      const result = cache.get('what is typescript');

      expect(result).toBe('TypeScript is a typed superset of JavaScript.');
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      cache.set('test query', 'test response');

      // Advance time past TTL
      vi.advanceTimersByTime(61000);

      const result = cache.get('test query');
      expect(result).toBeUndefined();
    });

    it('should not expire entries before TTL', () => {
      cache.set('test query', 'test response');

      // Advance time but not past TTL
      vi.advanceTimersByTime(30000);

      const result = cache.get('test query');
      expect(result).toBe('test response');
    });
  });

  describe('size limits', () => {
    it('should evict oldest entries when max size reached', () => {
      const smallCache = new ResponseCache({
        maxSize: 3,
        ttlMs: 60000,
        semanticThreshold: 0.85,
      });

      smallCache.set('query1', 'response1');
      vi.advanceTimersByTime(100);
      smallCache.set('query2', 'response2');
      vi.advanceTimersByTime(100);
      smallCache.set('query3', 'response3');
      vi.advanceTimersByTime(100);
      smallCache.set('query4', 'response4');

      // Oldest entry should be evicted
      expect(smallCache.get('query1')).toBeUndefined();
      expect(smallCache.get('query4')).toBe('response4');
    });
  });

  describe('invalidation', () => {
    it('should invalidate specific entry', () => {
      cache.set('query1', 'response1');
      cache.set('query2', 'response2');

      cache.invalidate('query1');

      expect(cache.get('query1')).toBeUndefined();
      expect(cache.get('query2')).toBe('response2');
    });

    it('should clear all entries', () => {
      cache.set('query1', 'response1');
      cache.set('query2', 'response2');

      cache.clear();

      expect(cache.get('query1')).toBeUndefined();
      expect(cache.get('query2')).toBeUndefined();
    });
  });

  describe('statistics', () => {
    it('should track cache hits and misses', () => {
      cache.set('query1', 'response1');

      cache.get('query1'); // hit
      cache.get('query1'); // hit
      cache.get('unknown'); // miss

      const stats = cache.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should track cache size', () => {
      cache.set('query1', 'response1');
      cache.set('query2', 'response2');

      const stats = cache.getStats();

      expect(stats.size).toBe(2);
    });
  });

  describe('metadata', () => {
    it('should store metadata with cache entry', () => {
      cache.set('query', 'response', {
        model: 'gpt-4',
        tokens: 100,
      });

      const entry = cache.getEntry('query');

      expect(entry?.metadata?.model).toBe('gpt-4');
      expect(entry?.metadata?.tokens).toBe(100);
    });
  });
});

describe('ToolOutputCache', () => {
  let cache: ToolOutputCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ToolOutputCache({
      maxSize: 50,
      ttlMs: 300000, // 5 minutes
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('deduplication', () => {
    it('should cache tool output by tool name and input hash', () => {
      const input = { path: '/home/user/file.txt' };
      const output = 'File contents here';

      cache.set('read', input, output);

      const result = cache.get('read', input);
      expect(result).toBe(output);
    });

    it('should return different results for different inputs', () => {
      cache.set('read', { path: '/file1.txt' }, 'Content 1');
      cache.set('read', { path: '/file2.txt' }, 'Content 2');

      expect(cache.get('read', { path: '/file1.txt' })).toBe('Content 1');
      expect(cache.get('read', { path: '/file2.txt' })).toBe('Content 2');
    });

    it('should return different results for different tools', () => {
      const input = { command: 'ls' };

      cache.set('bash', input, 'bash output');
      cache.set('exec', input, 'exec output');

      expect(cache.get('bash', input)).toBe('bash output');
      expect(cache.get('exec', input)).toBe('exec output');
    });
  });

  describe('TTL expiration', () => {
    it('should expire tool outputs after TTL', () => {
      cache.set('read', { path: '/file.txt' }, 'content');

      vi.advanceTimersByTime(301000);

      expect(cache.get('read', { path: '/file.txt' })).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('should invalidate by tool name', () => {
      cache.set('read', { path: '/file1.txt' }, 'content1');
      cache.set('read', { path: '/file2.txt' }, 'content2');
      cache.set('write', { path: '/file3.txt' }, 'content3');

      cache.invalidateByTool('read');

      expect(cache.get('read', { path: '/file1.txt' })).toBeUndefined();
      expect(cache.get('read', { path: '/file2.txt' })).toBeUndefined();
      expect(cache.get('write', { path: '/file3.txt' })).toBe('content3');
    });

    it('should invalidate by path pattern', () => {
      cache.set('read', { path: '/home/user/file1.txt' }, 'content1');
      cache.set('read', { path: '/home/user/file2.txt' }, 'content2');
      cache.set('read', { path: '/var/log/app.log' }, 'content3');

      cache.invalidateByPattern('/home/user');

      expect(cache.get('read', { path: '/home/user/file1.txt' })).toBeUndefined();
      expect(cache.get('read', { path: '/home/user/file2.txt' })).toBeUndefined();
      expect(cache.get('read', { path: '/var/log/app.log' })).toBe('content3');
    });
  });

  describe('write-through invalidation', () => {
    it('should invalidate read cache when file is written', () => {
      const path = '/home/user/file.txt';

      cache.set('read', { path }, 'old content');
      cache.onWrite(path);

      expect(cache.get('read', { path })).toBeUndefined();
    });

    it('should invalidate parent directory listings on write', () => {
      cache.set('bash', { command: 'ls /home/user' }, 'file1.txt\nfile2.txt');
      cache.onWrite('/home/user/file3.txt');

      expect(cache.get('bash', { command: 'ls /home/user' })).toBeUndefined();
    });
  });

  describe('statistics', () => {
    it('should track cache statistics', () => {
      cache.set('read', { path: '/file.txt' }, 'content');

      cache.get('read', { path: '/file.txt' }); // hit
      cache.get('read', { path: '/other.txt' }); // miss

      const stats = cache.getStats();

      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });
  });
});
