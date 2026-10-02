import { describe, it, expect } from 'vitest';
import { effortFor, desiredEffort, modelFamily, clampEffort, EFFORT_ORDER } from './effort-ladder.js';

describe('desiredEffort', () => {
  it('chat is low, capable tier steps up, fast caps at low', () => {
    expect(desiredEffort('standard', 'chat')).toBe('low');
    expect(desiredEffort('capable', 'chat')).toBe('medium');
    expect(desiredEffort('fast', 'coding')).toBe('low');
    expect(desiredEffort('standard', 'coding')).toBe('medium');
    expect(desiredEffort('capable', 'coding')).toBe('high');
    expect(desiredEffort('capable', 'goal')).toBe('high');
  });

  it('background work never thinks', () => {
    expect(desiredEffort('capable', 'background')).toBe('off');
    expect(desiredEffort('capable', 'compaction')).toBe('off');
  });

  it('never goes above high on its own', () => {
    for (const tier of ['fast', 'standard', 'capable'] as const) {
      for (const purpose of ['chat', 'coding', 'planning', 'goal', 'review'] as const) {
        expect(EFFORT_ORDER.indexOf(desiredEffort(tier, purpose))).toBeLessThanOrEqual(EFFORT_ORDER.indexOf('high'));
      }
    }
  });
});

describe('modelFamily', () => {
  it.each([
    ['kimi-k3', 'kimi'],
    ['moonshotai/kimi-k2.5', 'kimi'],
    ['gpt-5.1', 'gpt5'],
    ['openai/gpt-5.4-mini', 'gpt5'],
    ['gpt-5', 'gpt5-legacy'],
    ['gpt-5-mini', 'gpt5-legacy'],
    ['o4-mini', 'o-series'],
    ['claude-opus-4-1', 'anthropic'],
    ['google/gemini-3-pro', 'gemini'],
    ['x-ai/grok-3-mini', 'grok'],
    ['qwen/qwen3.6-plus', 'toggle'],
    ['llama-3.3-70b', 'unknown'],
  ])('%s -> %s', (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });
});

describe('clampEffort', () => {
  it('rounds down to the nearest supported level', () => {
    expect(clampEffort('medium', ['low', 'high'])).toEqual({ level: 'low', atFloor: false });
    expect(clampEffort('xhigh', ['low', 'medium', 'high'])).toEqual({ level: 'high', atFloor: false });
  });

  it('only rises to the model floor when nothing lower exists', () => {
    expect(clampEffort('off', ['low', 'medium', 'high'])).toEqual({ level: 'low', atFloor: true });
  });

  it('returns null when the family has no knob', () => {
    expect(clampEffort('high', [])).toBeNull();
  });
});

describe('effortFor', () => {
  it('Kimi: low thinking for chat, medium/high on the capable tier', () => {
    const chat = effortFor('kimi-k3', 'standard', 'chat');
    expect(chat).toMatchObject({ family: 'kimi', level: 'low', enableThinking: true, thinkingBudgetTokens: 4096 });
    expect(chat.reasoningEffort).toBeUndefined();
    expect(effortFor('kimi-k3', 'capable', 'chat')).toMatchObject({ level: 'medium', thinkingBudgetTokens: 8192 });
    expect(effortFor('kimi-k3', 'capable', 'coding')).toMatchObject({ level: 'high', thinkingBudgetTokens: 16384 });
    expect(effortFor('kimi-k3', 'standard', 'compaction')).toMatchObject({ level: 'off', enableThinking: false });
  });

  it('GPT-5.x: reasoning_effort low/medium/high, "none" for background', () => {
    expect(effortFor('gpt-5.1', 'standard', 'chat').reasoningEffort).toBe('low');
    expect(effortFor('gpt-5.1', 'standard', 'coding').reasoningEffort).toBe('medium');
    expect(effortFor('gpt-5.1', 'capable', 'goal').reasoningEffort).toBe('high');
    expect(effortFor('gpt-5.1', 'standard', 'background')).toMatchObject({ reasoningEffort: 'none', enableThinking: false });
  });

  it('gpt-5 (legacy) uses minimal as its floor', () => {
    const d = effortFor('gpt-5-mini', 'standard', 'background');
    expect(d).toMatchObject({ reasoningEffort: 'minimal', atFloor: true, clamped: true });
  });

  it('o-series cannot go below low and says so', () => {
    expect(effortFor('o4-mini', 'fast', 'compaction')).toMatchObject({ level: 'low', atFloor: true });
  });

  it('grok clamps medium down to low, never up to high', () => {
    expect(effortFor('grok-3-mini', 'standard', 'coding')).toMatchObject({ level: 'low', reasoningEffort: 'low', clamped: true, atFloor: false });
  });

  it('toggle families only think when the ladder reaches high', () => {
    expect(effortFor('qwen3.6', 'standard', 'chat')).toMatchObject({ level: 'off', enableThinking: false });
    expect(effortFor('qwen3.6', 'capable', 'coding')).toMatchObject({ level: 'high', enableThinking: true });
  });

  it('respects an operator ceiling', () => {
    expect(effortFor('kimi-k3', 'capable', 'coding', { ceiling: 'low' }).level).toBe('low');
    expect(effortFor('claude-sonnet-4-5', 'capable', 'coding', { ceiling: 'off' })).toMatchObject({ level: 'off', enableThinking: false });
  });

  it('unknown models get no knob', () => {
    expect(effortFor('llama-3.3-70b', 'capable', 'coding')).toMatchObject({ family: 'unknown', level: null, enableThinking: false });
  });

  it('clamping never raises cost above the desired level except at a model floor', () => {
    const models = ['kimi-k3', 'gpt-5.1', 'gpt-5', 'o3', 'claude-opus-4', 'gemini-3-pro', 'grok-3-mini', 'qwen3', 'mystery'];
    for (const model of models) {
      for (const tier of ['fast', 'standard', 'capable'] as const) {
        for (const purpose of ['chat', 'coding', 'goal', 'background'] as const) {
          const d = effortFor(model, tier, purpose);
          if (d.level === null || d.atFloor) continue;
          expect(EFFORT_ORDER.indexOf(d.level)).toBeLessThanOrEqual(EFFORT_ORDER.indexOf(d.desired));
        }
      }
    }
  });
});
