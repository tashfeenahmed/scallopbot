import { describe, it, expect } from 'vitest';
import { stripThinkTags, extractResponseText, extractJSON } from './proactive-utils.js';

describe('stripThinkTags', () => {
  it('removes a closed think block', () => {
    expect(stripThinkTags('<think>reasoning here</think>{"items": []}')).toBe('{"items": []}');
  });

  it('removes multiple think blocks', () => {
    expect(stripThinkTags('<think>a</think>foo<think>b</think>bar')).toBe('foobar');
  });

  it('truncates at an unterminated think block (max_tokens cutoff)', () => {
    expect(stripThinkTags('{"items": []}<think>I should also consider')).toBe('{"items": []}');
  });

  it('drops everything before an orphan closing tag', () => {
    expect(stripThinkTags('leaked reasoning</think>{"items": []}')).toBe('{"items": []}');
  });

  it('returns empty string for a pure-reasoning response', () => {
    expect(stripThinkTags('<think>never finished thinking')).toBe('');
  });

  it('passes through normal text unchanged', () => {
    expect(stripThinkTags('{"items": [{"index": 1}]}')).toBe('{"items": [{"index": 1}]}');
  });
});

describe('extractResponseText', () => {
  it('joins text blocks and strips thinking markup', () => {
    const content = [
      { type: 'text', text: '<think>hmm {nested: brace}</think>' },
      { type: 'text', text: '{"items": []}' },
    ];
    expect(extractResponseText(content)).toBe('{"items": []}');
  });
});

describe('extractJSON', () => {
  it('parses a plain JSON object', () => {
    expect(extractJSON('{"items": [1]}')).toEqual({ items: [1] });
  });

  it('prefers a fenced json block', () => {
    const res = extractJSON('Sure! ```json\n{"items": [2]}\n``` hope that helps');
    expect(res).toEqual({ items: [2] });
  });

  it('survives trailing prose containing stray braces', () => {
    // The old greedy /\{[\s\S]*\}/ regex failed on this shape.
    const res = extractJSON('{"items": []} (note: {} means no action)');
    expect(res).toEqual({ items: [] });
  });

  it('skips a malformed candidate and finds the next valid object', () => {
    const res = extractJSON('{oops not json} then {"items": [3]}');
    expect(res).toEqual({ items: [3] });
  });

  it('handles braces inside JSON strings', () => {
    const res = extractJSON('{"message": "use {placeholder} here"}');
    expect(res).toEqual({ message: 'use {placeholder} here' });
  });

  it('returns null for empty or brace-free input', () => {
    expect(extractJSON('')).toBeNull();
    expect(extractJSON('no json here')).toBeNull();
  });

  it('returns null for a truncated object', () => {
    expect(extractJSON('{"items": [{"index": 1, "action": "nud')).toBeNull();
  });
});
