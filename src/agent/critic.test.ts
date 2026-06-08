import { describe, it, expect, vi } from 'vitest';
import {
  scoreResponseHeuristic,
  selectBest,
  bestOfN,
  scoreResponseLLM,
} from './critic.js';
import type { LLMProvider } from '../providers/types.js';

describe('scoreResponseHeuristic', () => {
  it('scores a clean, relevant answer highly', () => {
    const s = scoreResponseHeuristic(
      'The capital of France is Paris, a city on the Seine.',
      'what is the capital of France'
    );
    expect(s.score).toBeGreaterThan(0.85);
  });

  it('tanks an empty response', () => {
    expect(scoreResponseHeuristic('', 'anything').score).toBeLessThan(0.4);
  });

  it('penalizes a pure refusal', () => {
    const refusal = scoreResponseHeuristic("I'm sorry, I can't help with that.", 'do the thing');
    const real = scoreResponseHeuristic('Sure — here is how you do the thing: step one, step two.', 'do the thing');
    expect(real.score).toBeGreaterThan(refusal.score);
  });

  it('penalizes leaked error text', () => {
    const bad = scoreResponseHeuristic('Error: undefined is not a function', 'run the script');
    expect(bad.signals.clean).toBeLessThan(0.5);
  });

  it('penalizes leaked tool-call JSON', () => {
    const leaked = scoreResponseHeuristic('{"function":"bash","arguments":{"command":"ls"}}', 'list files');
    expect(leaked.signals.noToolLeak).toBeLessThan(0.5);
  });

  it('keeps relevance from solely tanking an otherwise good answer', () => {
    const s = scoreResponseHeuristic('Here is a thorough, well-formed response.', 'xyzzy plugh frobnicate');
    expect(s.signals.relevance).toBeGreaterThanOrEqual(0.5);
  });
});

describe('selectBest', () => {
  it('picks the highest-scoring candidate', () => {
    const candidates = [
      { text: '' }, // empty → low
      { text: 'A complete and clearly written answer about cats.' }, // high
      { text: "I can't." }, // refusal → low
    ];
    const sel = selectBest(candidates, (c) => scoreResponseHeuristic(c.text, 'tell me about cats'));
    expect(sel.bestIndex).toBe(1);
    expect(sel.best.text).toMatch(/cats/);
  });

  it('resolves ties to the earliest candidate', () => {
    const candidates = [{ text: 'same' }, { text: 'same' }];
    const sel = selectBest(candidates, (c) => scoreResponseHeuristic(c.text));
    expect(sel.bestIndex).toBe(0);
  });

  it('throws on empty candidate list', () => {
    expect(() => selectBest([], () => scoreResponseHeuristic(''))).toThrow();
  });
});

describe('bestOfN', () => {
  it('generates N candidates and returns the best', async () => {
    const outputs = ['', 'I cannot do that.', 'Here is a detailed, correct answer to your question.'];
    const gen = vi.fn(async (i: number) => outputs[i]);
    const r = await bestOfN(3, gen, (t) => scoreResponseHeuristic(t, 'your question'));
    expect(gen).toHaveBeenCalledTimes(3);
    expect(r.best).toMatch(/detailed, correct/);
    expect(r.candidates.length).toBe(2); // empty one filtered out
  });

  it('survives some attempts throwing', async () => {
    const gen = vi.fn(async (i: number) => {
      if (i === 0) throw new Error('boom');
      return 'A solid answer.';
    });
    const r = await bestOfN(2, gen);
    expect(r.best).toBe('A solid answer.');
  });

  it('throws when every attempt fails', async () => {
    await expect(bestOfN(2, async () => { throw new Error('nope'); })).rejects.toThrow('all attempts failed');
  });

  it('defaults to at least one attempt', async () => {
    const gen = vi.fn(async () => 'one');
    const r = await bestOfN(0, gen);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(r.best).toBe('one');
  });
});

describe('scoreResponseLLM', () => {
  it('normalizes an integer judge score to [0,1]', async () => {
    const provider = {
      name: 'judge',
      isAvailable: () => true,
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '8' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'judge',
      }),
    } as unknown as LLMProvider;
    const s = await scoreResponseLLM('answer', 'question', provider);
    expect(s.score).toBeCloseTo(0.8, 5);
  });

  it('falls back to heuristic when the judge errors', async () => {
    const provider = {
      name: 'judge',
      isAvailable: () => true,
      complete: vi.fn().mockRejectedValue(new Error('down')),
    } as unknown as LLMProvider;
    const s = await scoreResponseLLM('A clear answer about dogs.', 'tell me about dogs', provider);
    expect(s.score).toBeGreaterThan(0.5); // heuristic took over
  });
});
