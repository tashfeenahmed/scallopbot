import { describe, expect, it, vi } from 'vitest';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { evaluateArtifactFitness } from './fitness.js';
import { MAX_EVOLUTION_ARTIFACT_BYTES } from './verify.js';

function provider(payload: unknown, reject = false): LLMProvider {
  return {
    name: 'fitness-test',
    isAvailable: () => true,
    complete: reject
      ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'fitness-test',
        } as CompletionResponse),
  };
}

const artifact = { kind: 'skill' as const, target: 'research', baseline: 'old', candidate: 'new' };
const cases = [
  { id: 'a', task: 'Find a primary source.' },
  { id: 'b', task: 'Report uncertainty.' },
];

describe('evaluateArtifactFitness', () => {
  it('passes only a measured holdout improvement', async () => {
    const evaluator = provider({
      safe: true,
      cases: [
        { id: 'a', baseline: 0.4, candidate: 0.8 },
        { id: 'b', baseline: 0.6, candidate: 0.7 },
      ],
    });
    const result = await evaluateArtifactFitness(artifact, cases, evaluator, 0.2);
    expect(result.passed).toBe(true);
    expect(result.baseline).toBeCloseTo(0.5);
    expect(result.candidate).toBeCloseTo(0.75);
    expect(result.delta).toBeCloseTo(0.25);
    expect(result.samples).toBe(2);
    expect(result.executionCalls).toBe(4);
    expect(evaluator.complete).toHaveBeenCalledTimes(5);
  });

  it('rejects a candidate below the configured improvement margin', async () => {
    const result = await evaluateArtifactFitness(artifact, cases, provider({
      safe: true,
      cases: [
        { id: 'a', baseline: 0.6, candidate: 0.65 },
        { id: 'b', baseline: 0.6, candidate: 0.64 },
      ],
    }), 0.1);
    expect(result.passed).toBe(false);
    expect(result.delta).toBeCloseTo(0.045);
  });

  it('fails closed on missing provider, errors, unsafe output, or incomplete scores', async () => {
    expect((await evaluateArtifactFitness(artifact, cases, undefined, 0)).passed).toBe(false);
    expect((await evaluateArtifactFitness(artifact, cases, provider({}, true), 0)).passed).toBe(false);
    expect((await evaluateArtifactFitness(artifact, cases, provider({ safe: false, reason: 'unsafe' }), 0)).passed).toBe(false);
    expect((await evaluateArtifactFitness(artifact, cases, provider({
      safe: true,
      cases: [{ id: 'a', baseline: 0, candidate: 1 }],
    }), 0)).passed).toBe(false);
  });

  it('replays the complete capped procedure without a hidden 6k truncation', async () => {
    const trailing = 'TRAILING_PROCEDURE_REQUIREMENT';
    const candidate = `${'procedure step\n'.repeat(500)}${trailing}`;
    const calls: Array<{ system?: string }> = [];
    const evaluator: LLMProvider = {
      name: 'complete-procedure-test',
      isAvailable: () => true,
      complete: vi.fn(async request => {
        calls.push({ system: typeof request.system === 'string' ? request.system : undefined });
        const judging = typeof request.system === 'string' && /fitness evaluator/i.test(request.system);
        const text = judging
          ? JSON.stringify({ safe: true, cases: [{ id: 'a', baseline: 0.2, candidate: 0.8 }] })
          : 'replayed output';
        return {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'complete-procedure-test',
        } as CompletionResponse;
      }),
    };
    const result = await evaluateArtifactFitness(
      { kind: 'skill', target: 'complete', baseline: 'old', candidate },
      [{ id: 'a', task: 'Follow the procedure.' }],
      evaluator,
      0.1,
    );
    expect(result.passed).toBe(true);
    expect(Buffer.byteLength(candidate)).toBeGreaterThan(6_000);
    expect(calls.some(call => call.system?.includes(trailing))).toBe(true);
  });

  it('rejects an over-cap procedure before sending any partial artifact', async () => {
    const evaluator = provider({ safe: true, cases: [] });
    const result = await evaluateArtifactFitness(
      {
        kind: 'skill', target: 'oversized', baseline: '',
        candidate: 'x'.repeat(MAX_EVOLUTION_ARTIFACT_BYTES + 1),
      },
      [{ id: 'a', task: 'Evaluate.' }],
      evaluator,
      0,
    );
    expect(result).toMatchObject({ passed: false, executionCalls: 0 });
    expect(result.reason).toContain('review cap');
    expect(evaluator.complete).not.toHaveBeenCalled();
  });
});
