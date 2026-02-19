import { describe, it, expect } from 'vitest';
import { wordOverlap, DEDUP_OVERLAP_THRESHOLD } from './text-similarity.js';

describe('wordOverlap', () => {
  it('returns 1 for identical strings', () => {
    expect(wordOverlap('hello world test', 'hello world test')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(wordOverlap('', 'hello world test')).toBe(0);
    expect(wordOverlap('hello world test', '')).toBe(0);
  });

  it('returns 0 when strings share no words', () => {
    expect(wordOverlap('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('is case insensitive', () => {
    expect(wordOverlap('Hello World Test', 'hello world test')).toBe(1);
  });

  it('filters short words by default (< 3 chars)', () => {
    // 'is' is 2 chars (filtered), 'the', 'sky', 'blue', 'red' are >= 3 (kept)
    // wordsA: {the, sky, blue}, wordsB: {the, sky, red}
    // intersection: {the, sky} = 2, smaller: 3 → 2/3
    expect(wordOverlap('the sky is blue', 'the sky is red')).toBeCloseTo(2 / 3, 5);
  });

  it('respects custom minWordLength', () => {
    // With minWordLength 1, all words count
    const result = wordOverlap('I am here', 'I am there', { minWordLength: 1 });
    expect(result).toBeGreaterThan(0);
  });

  it('computes ratio against smaller set', () => {
    // wordsA: {hello, world, test} (3 words)
    // wordsB: {hello, world, test, extra, words} (5 words)
    // intersection: 3, smaller: 3 → ratio = 1.0
    expect(wordOverlap('hello world test', 'hello world test extra words')).toBe(1);
  });

  it('handles partial overlap', () => {
    // wordsA: {goal, approaching, deadline} (3 words)
    // wordsB: {goal, approaching, review} (3 words)
    // intersection: 2, smaller: 3 → ratio ≈ 0.667
    const result = wordOverlap('goal approaching deadline', 'goal approaching review');
    expect(result).toBeCloseTo(2 / 3, 2);
  });

  it('returns 0 when all words are below minWordLength', () => {
    expect(wordOverlap('is a', 'is a')).toBe(0);
  });
});

describe('DEDUP_OVERLAP_THRESHOLD', () => {
  it('is 0.8', () => {
    expect(DEDUP_OVERLAP_THRESHOLD).toBe(0.8);
  });
});
