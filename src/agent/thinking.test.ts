/**
 * Tests for granular thinking levels.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeThinkLevel,
  mapThinkLevelToProvider,
  pickFallbackLevel,
  booleanToThinkLevel,
  type ThinkLevel,
} from './thinking.js';

// ============ normalizeThinkLevel ============

describe('normalizeThinkLevel', () => {
  it('passes through valid levels', () => {
    expect(normalizeThinkLevel('off')).toBe('off');
    expect(normalizeThinkLevel('minimal')).toBe('minimal');
    expect(normalizeThinkLevel('low')).toBe('low');
    expect(normalizeThinkLevel('medium')).toBe('medium');
    expect(normalizeThinkLevel('high')).toBe('high');
    expect(normalizeThinkLevel('xhigh')).toBe('xhigh');
  });

  it('normalizes "on" aliases to low', () => {
    expect(normalizeThinkLevel('on')).toBe('low');
    expect(normalizeThinkLevel('true')).toBe('low');
    expect(normalizeThinkLevel('yes')).toBe('low');
    expect(normalizeThinkLevel('enabled')).toBe('low');
  });

  it('normalizes "off" aliases', () => {
    expect(normalizeThinkLevel('false')).toBe('off');
    expect(normalizeThinkLevel('no')).toBe('off');
    expect(normalizeThinkLevel('disabled')).toBe('off');
    expect(normalizeThinkLevel('none')).toBe('off');
  });

  it('normalizes ultra/max to xhigh', () => {
    expect(normalizeThinkLevel('ultra')).toBe('xhigh');
    expect(normalizeThinkLevel('max')).toBe('xhigh');
    expect(normalizeThinkLevel('maximum')).toBe('xhigh');
  });

  it('is case insensitive', () => {
    expect(normalizeThinkLevel('HIGH')).toBe('high');
    expect(normalizeThinkLevel('Off')).toBe('off');
    expect(normalizeThinkLevel('MEDIUM')).toBe('medium');
  });

  it('returns off for unknown values', () => {
    expect(normalizeThinkLevel('garbage')).toBe('off');
    expect(normalizeThinkLevel('')).toBe('off');
  });
});

// ============ mapThinkLevelToProvider ============

describe('mapThinkLevelToProvider', () => {
  describe('off level', () => {
    it('returns enableThinking: false for all providers', () => {
      expect(mapThinkLevelToProvider('off', 'anthropic', 'claude')).toEqual({ enableThinking: false });
      expect(mapThinkLevelToProvider('off', 'openai', 'gpt-5')).toEqual({ enableThinking: false });
      expect(mapThinkLevelToProvider('off', 'moonshot', 'kimi')).toEqual({ enableThinking: false });
    });
  });

  describe('anthropic provider', () => {
    it('maps levels to thinking budgets', () => {
      const result = mapThinkLevelToProvider('medium', 'anthropic', 'claude-sonnet-4');
      expect(result.enableThinking).toBe(true);
      expect(result.thinkingBudgetTokens).toBe(8192);
    });

    it('uses correct budget for each level', () => {
      expect(mapThinkLevelToProvider('minimal', 'anthropic', 'claude').thinkingBudgetTokens).toBe(2048);
      expect(mapThinkLevelToProvider('low', 'anthropic', 'claude').thinkingBudgetTokens).toBe(4096);
      expect(mapThinkLevelToProvider('high', 'anthropic', 'claude').thinkingBudgetTokens).toBe(16384);
      expect(mapThinkLevelToProvider('xhigh', 'anthropic', 'claude').thinkingBudgetTokens).toBe(32768);
    });
  });

  describe('openai provider', () => {
    it('maps levels to reasoning effort', () => {
      const low = mapThinkLevelToProvider('low', 'openai', 'gpt-5.2');
      expect(low.reasoningEffort).toBe('low');

      const medium = mapThinkLevelToProvider('medium', 'openai', 'gpt-5.2');
      expect(medium.reasoningEffort).toBe('medium');

      const high = mapThinkLevelToProvider('high', 'openai', 'gpt-5.2');
      expect(high.reasoningEffort).toBe('high');
    });

    it('xhigh maps to high reasoning effort', () => {
      const result = mapThinkLevelToProvider('xhigh', 'openai', 'o3');
      expect(result.reasoningEffort).toBe('high');
    });
  });

  describe('moonshot provider', () => {
    it('sets temperature to 1.0 for thinking mode', () => {
      const result = mapThinkLevelToProvider('medium', 'moonshot', 'kimi-k2.5');
      expect(result.enableThinking).toBe(true);
      expect(result.temperature).toBe(1.0);
      expect(result.thinkingBudgetTokens).toBe(8192);
    });
  });

  describe('unknown provider', () => {
    it('returns generic thinking params', () => {
      const result = mapThinkLevelToProvider('high', 'ollama', 'llama3');
      expect(result.enableThinking).toBe(true);
      expect(result.thinkingBudgetTokens).toBe(16384);
    });
  });
});

// ============ pickFallbackLevel ============

describe('pickFallbackLevel', () => {
  it('downgrades in order', () => {
    expect(pickFallbackLevel('xhigh')).toBe('high');
    expect(pickFallbackLevel('high')).toBe('medium');
    expect(pickFallbackLevel('medium')).toBe('low');
    expect(pickFallbackLevel('low')).toBe('minimal');
    expect(pickFallbackLevel('minimal')).toBe('off');
  });

  it('returns null for off', () => {
    expect(pickFallbackLevel('off')).toBeNull();
  });
});

// ============ booleanToThinkLevel ============

describe('booleanToThinkLevel', () => {
  it('converts true to low', () => {
    expect(booleanToThinkLevel(true)).toBe('low');
  });

  it('converts false to off', () => {
    expect(booleanToThinkLevel(false)).toBe('off');
  });
});
