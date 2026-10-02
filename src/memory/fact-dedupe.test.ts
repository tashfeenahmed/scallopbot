import { describe, expect, it } from 'vitest';
import { factTokens, isNearDuplicateFact, tokenJaccard } from './fact-dedupe.js';

describe('LLM-free fact de-duplication', () => {
  it('tokenises without stop words, case or punctuation', () => {
    expect([...factTokens('The user LIVES in Dublin!')]).toEqual(['lives', 'dublin']);
    expect(tokenJaccard('Lives in Dublin', 'lives in dublin.')).toBe(1);
    expect(tokenJaccard('Lives in Dublin', 'Works in Dublin')).toBeCloseTo(1 / 3);
  });

  it('treats high embedding similarity as a duplicate', () => {
    expect(isNearDuplicateFact(
      { content: 'Prefers tea', embedding: [1, 0, 0] },
      { content: 'Likes tea best', embedding: [0.99, 0.01, 0], matchType: 'semantic' },
      { embeddingThreshold: 0.95 },
    )).toBe(true);
  });

  it('catches lexical restatements (BM25 hit) even without embeddings', () => {
    expect(isNearDuplicateFact(
      { content: 'User works at Acme Corp' },
      { content: 'Works at Acme Corp.', matchType: 'keyword' },
      { embeddingThreshold: 0.95 },
    )).toBe(true);
  });

  it('does not merge different facts that share words', () => {
    expect(isNearDuplicateFact(
      { content: 'Works at Acme Corp' },
      { content: 'Used to work at Globex', matchType: 'keyword' },
      { embeddingThreshold: 0.95 },
    )).toBe(false);
    expect(isNearDuplicateFact(
      { content: 'Sister lives in Dublin' },
      { content: 'Brother lives in Dublin', matchType: 'hybrid' },
      { embeddingThreshold: 0.95 },
    )).toBe(false);
  });

  it('ignores the lexical path for semantic-only hits and when vectors disagree', () => {
    expect(isNearDuplicateFact(
      { content: 'Works at Acme Corp' },
      { content: 'Works at Acme Corp', matchType: 'semantic' },
      { embeddingThreshold: 0.95 },
    )).toBe(false);
    expect(isNearDuplicateFact(
      { content: 'Works at Acme Corp', embedding: [1, 0] },
      { content: 'works at acme corp', embedding: [0, 1], matchType: 'keyword' },
      { embeddingThreshold: 0.95 },
    )).toBe(false);
  });
});
