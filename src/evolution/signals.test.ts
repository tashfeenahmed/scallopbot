import { describe, it, expect, beforeEach } from 'vitest';
import { EvolutionRecorder, type EvolutionSignalSink, type TurnOutcome } from './signals.js';
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig } from './config.js';
import type { EvolutionSignal } from './types.js';

class FakeSink implements EvolutionSignalSink {
  signals: Omit<EvolutionSignal, 'id'>[] = [];
  recordEvolutionSignal(signal: Omit<EvolutionSignal, 'id'>): void {
    this.signals.push(signal);
  }
}

const baseTurn: TurnOutcome = {
  userId: 'u1',
  sessionId: 's1',
  userMessage: 'please scrape these 4 sites and summarize',
  finalResponse: 'Done — here is a clean, thorough summary of all four sites with the key points.',
  toolCallCount: 0,
  failedSkills: [],
  complexityTier: 'capable',
  criticScore: 0.95,
};

function recorder(sink: EvolutionSignalSink, overrides: Partial<EvolutionConfig> = {}) {
  return new EvolutionRecorder(sink, { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, ...overrides });
}

describe('EvolutionRecorder', () => {
  let sink: FakeSink;
  beforeEach(() => {
    sink = new FakeSink();
  });

  it('captures a reusable_task on a clean, tool-heavy success', () => {
    recorder(sink, { includeSessionContent: true }).recordTurn({ ...baseTurn, toolCallCount: 6, criticScore: 0.9 });
    const types = sink.signals.map(s => s.type);
    expect(types).toContain('reusable_task');
    const sig = sink.signals.find(s => s.type === 'reusable_task')!;
    expect(sig.toolCallCount).toBe(6);
    expect(sig.detail?.preview).toContain('scrape');
  });

  it('does not persist a conversation preview without explicit content consent', () => {
    recorder(sink).recordTurn({ ...baseTurn, toolCallCount: 6, criticScore: 0.9 });
    expect(sink.signals[0].detail).not.toHaveProperty('preview');
    expect(JSON.stringify(sink.signals)).not.toContain('scrape these 4 sites');
  });

  it('does NOT capture reusable_task below the tool-call threshold', () => {
    recorder(sink).recordTurn({ ...baseTurn, toolCallCount: 2, criticScore: 0.95 });
    expect(sink.signals.some(s => s.type === 'reusable_task')).toBe(false);
  });

  it('does NOT capture reusable_task when the answer scored poorly', () => {
    recorder(sink).recordTurn({ ...baseTurn, toolCallCount: 8, criticScore: 0.4 });
    expect(sink.signals.some(s => s.type === 'reusable_task')).toBe(false);
  });

  it('captures one skill_failure per distinct failing skill', () => {
    recorder(sink).recordTurn({
      ...baseTurn,
      failedSkills: ['web_search', 'web_search', 'read_file'],
    });
    const failures = sink.signals.filter(s => s.type === 'skill_failure');
    expect(failures).toHaveLength(2);
    expect(failures.map(f => f.targetSkill).sort()).toEqual(['read_file', 'web_search']);
  });

  it('captures low_quality only on capable-tier weak answers', () => {
    recorder(sink).recordTurn({ ...baseTurn, criticScore: 0.3, complexityTier: 'capable' });
    expect(sink.signals.some(s => s.type === 'low_quality')).toBe(true);

    sink.signals = [];
    recorder(sink).recordTurn({ ...baseTurn, criticScore: 0.3, complexityTier: 'fast' });
    expect(sink.signals.some(s => s.type === 'low_quality')).toBe(false);
  });

  it('computes a critic score when none is supplied', () => {
    const r = recorder(sink);
    r.recordTurn({ ...baseTurn, toolCallCount: 6, criticScore: undefined });
    // A clean response should score high enough to register the reusable_task.
    expect(sink.signals.some(s => s.type === 'reusable_task')).toBe(true);
    expect(typeof sink.signals[0].criticScore).toBe('number');
  });

  it('captures nothing when disabled', () => {
    recorder(sink, { enabled: false }).recordTurn({ ...baseTurn, toolCallCount: 9, failedSkills: ['x'] });
    expect(sink.signals).toHaveLength(0);
  });

  it('never throws if the sink fails', () => {
    const throwingSink: EvolutionSignalSink = {
      recordEvolutionSignal: () => {
        throw new Error('db down');
      },
    };
    expect(() =>
      recorder(throwingSink).recordTurn({ ...baseTurn, toolCallCount: 9 }),
    ).not.toThrow();
  });
});
