/**
 * Tests for MMR (Maximal Marginal Relevance) memory search diversity.
 */

import { describe, it, expect } from 'vitest';
import { tokenize, jaccardSimilarity, applyMMR, type MMRItem } from './mmr.js';

// ============ tokenize ============

describe('tokenize', () => {
  it('splits text on non-word boundaries and lowercases', () => {
    const tokens = tokenize('Hello World, how are you?');
    expect(tokens).toEqual(new Set(['hello', 'world', 'how', 'are', 'you']));
  });

  it('returns empty set for empty string', () => {
    expect(tokenize('')).toEqual(new Set());
  });

  it('handles punctuation and special chars', () => {
    const tokens = tokenize("user's email is foo@bar.com");
    expect(tokens.has('user')).toBe(true);
    expect(tokens.has('email')).toBe(true);
    expect(tokens.has('foo')).toBe(true);
    expect(tokens.has('bar')).toBe(true);
  });
});

// ============ jaccardSimilarity ============

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('computes correct partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection = {b, c} = 2, union = {a, b, c, d} = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it('handles one empty set', () => {
    const a = new Set(['a', 'b']);
    expect(jaccardSimilarity(a, new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), a)).toBe(0);
  });
});

// ============ applyMMR ============

describe('applyMMR', () => {
  it('returns results unchanged when below minResultsForMMR', () => {
    const items: MMRItem<string>[] = [
      { item: 'a', score: 1.0, getText: () => 'hello world' },
      { item: 'b', score: 0.5, getText: () => 'foo bar' },
    ];

    const result = applyMMR(items, { minResultsForMMR: 3 });
    expect(result).toEqual(items);
  });

  it('selects highest-scoring item first', () => {
    const items: MMRItem<string>[] = [
      { item: 'low', score: 0.3, getText: () => 'cats are great' },
      { item: 'high', score: 0.9, getText: () => 'dogs are awesome' },
      { item: 'mid', score: 0.6, getText: () => 'birds can fly' },
    ];

    const result = applyMMR(items);
    expect(result[0].item).toBe('high');
  });

  it('promotes diverse results over redundant ones', () => {
    // B is nearly identical to A (same words), C is completely different
    // Scores chosen so that after normalization, C still has meaningful relevance
    const items: MMRItem<string>[] = [
      { item: 'A', score: 1.0, getText: () => 'coffee espresso latte cappuccino americano' },
      { item: 'B', score: 0.9, getText: () => 'coffee espresso latte cappuccino mocha' },
      { item: 'C', score: 0.8, getText: () => 'meeting scheduled tomorrow afternoon office' },
    ];

    const result = applyMMR(items, { lambda: 0.5 });
    // A is selected first (highest score)
    expect(result[0].item).toBe('A');
    // C should be promoted over B since B is very similar to A
    // B's diversity penalty (high Jaccard with A) outweighs its relevance advantage
    expect(result[1].item).toBe('C');
    expect(result[2].item).toBe('B');
  });

  it('with lambda=1.0, preserves original ordering (pure relevance)', () => {
    const items: MMRItem<string>[] = [
      { item: 'first', score: 0.9, getText: () => 'same words same text' },
      { item: 'second', score: 0.8, getText: () => 'same words same text' },
      { item: 'third', score: 0.7, getText: () => 'same words same text' },
    ];

    const result = applyMMR(items, { lambda: 1.0 });
    expect(result.map(r => r.item)).toEqual(['first', 'second', 'third']);
  });

  it('preserves original scores in output', () => {
    const items: MMRItem<string>[] = [
      { item: 'a', score: 0.9, getText: () => 'hello world' },
      { item: 'b', score: 0.5, getText: () => 'foo bar' },
      { item: 'c', score: 0.3, getText: () => 'baz qux' },
    ];

    const result = applyMMR(items);
    expect(result[0].score).toBe(0.9);
  });

  it('handles all identical scores', () => {
    const items: MMRItem<string>[] = [
      { item: 'a', score: 1.0, getText: () => 'alpha beta' },
      { item: 'b', score: 1.0, getText: () => 'gamma delta' },
      { item: 'c', score: 1.0, getText: () => 'epsilon zeta' },
    ];

    const result = applyMMR(items);
    expect(result.length).toBe(3);
  });
});
