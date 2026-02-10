/**
 * Tests for Proactiveness-Gated Gap Actions (Stage 3).
 *
 * Covers:
 * - GapAction type shape
 * - DIAL_THRESHOLDS constant (conservative, moderate, eager)
 * - createGapActions filtering, dedup, budget caps, hard cap
 * - Edge cases: empty input, all filtered, all duplicates, over budget
 */

import { describe, it, expect } from 'vitest';
import type { GapSignal } from './gap-scanner.js';
import type { DiagnosedGap } from './gap-diagnosis.js';
import {
  createGapActions,
  DIAL_THRESHOLDS,
  type GapAction,
  type DialConfig,
} from './gap-actions.js';

// ============ Test Helpers ============

const NOW = 1_700_000_000_000; // fixed timestamp for deterministic tests
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/** Create a minimal GapSignal for testing */
function makeSignal(overrides?: Partial<GapSignal>): GapSignal {
  return {
    type: 'stale_goal',
    severity: 'medium',
    description: 'Goal "Learn Rust" has not been updated in 20 days',
    context: { goalTitle: 'Learn Rust', daysSinceUpdate: 20 },
    sourceId: 'goal-1',
    ...overrides,
  };
}

/** Create a minimal DiagnosedGap for testing */
function makeDiagnosed(overrides?: Partial<DiagnosedGap>): DiagnosedGap {
  return {
    signal: makeSignal(),
    diagnosis: 'This goal needs attention',
    actionable: true,
    suggestedAction: 'Ask about progress on Learn Rust',
    confidence: 0.8,
    ...overrides,
  };
}

// ============ DIAL_THRESHOLDS ============

describe('DIAL_THRESHOLDS', () => {
  it('has conservative, moderate, and eager configs', () => {
    expect(DIAL_THRESHOLDS).toHaveProperty('conservative');
    expect(DIAL_THRESHOLDS).toHaveProperty('moderate');
    expect(DIAL_THRESHOLDS).toHaveProperty('eager');
  });

  it('conservative: minSeverity=high, minConfidence=0.7, maxDailyNotifications=1', () => {
    const c = DIAL_THRESHOLDS.conservative;
    expect(c.minSeverity).toBe('high');
    expect(c.minConfidence).toBe(0.7);
    expect(c.maxDailyNotifications).toBe(1);
    expect(c.allowedTypes).toEqual(['approaching_deadline', 'stale_goal']);
  });

  it('moderate: minSeverity=medium, minConfidence=0.5, maxDailyNotifications=3', () => {
    const m = DIAL_THRESHOLDS.moderate;
    expect(m.minSeverity).toBe('medium');
    expect(m.minConfidence).toBe(0.5);
    expect(m.maxDailyNotifications).toBe(3);
    expect(m.allowedTypes).toEqual([
      'approaching_deadline',
      'stale_goal',
      'unresolved_thread',
    ]);
  });

  it('eager: minSeverity=low, minConfidence=0.3, maxDailyNotifications=5', () => {
    const e = DIAL_THRESHOLDS.eager;
    expect(e.minSeverity).toBe('low');
    expect(e.minConfidence).toBe(0.3);
    expect(e.maxDailyNotifications).toBe(5);
    expect(e.allowedTypes).toEqual([
      'approaching_deadline',
      'stale_goal',
      'unresolved_thread',
      'behavioral_anomaly',
    ]);
  });
});

// ============ createGapActions — filtering ============

describe('createGapActions — filtering', () => {
  it('skips gaps that are not actionable', () => {
    const diagnosed = [
      makeDiagnosed({ actionable: false, confidence: 0.9 }),
    ];
    const result = createGapActions(diagnosed, 'moderate', [], { now: NOW });
    expect(result).toEqual([]);
  });

  it('skips gaps with confidence below minConfidence', () => {
    const diagnosed = [
      makeDiagnosed({ confidence: 0.4 }), // moderate minConfidence=0.5
    ];
    const result = createGapActions(diagnosed, 'moderate', [], { now: NOW });
    expect(result).toEqual([]);
  });

  it('skips gaps whose type is not in allowedTypes', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ type: 'behavioral_anomaly' }),
        confidence: 0.8,
      }),
    ];
    // conservative only allows approaching_deadline and stale_goal
    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('skips gaps with severity below minSeverity', () => {
    // conservative requires severity='high', this gap is 'medium'
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'medium' }),
        confidence: 0.9,
      }),
    ];
    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('passes gaps that meet all filter criteria', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'high', type: 'stale_goal' }),
        confidence: 0.9,
        actionable: true,
        suggestedAction: 'Follow up on goal progress',
      }),
    ];
    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it('severity rank: low=0, medium=1, high=2 — moderate (medium) allows medium and high', () => {
    const lowSeverity = makeDiagnosed({
      signal: makeSignal({ severity: 'low' }),
      confidence: 0.8,
    });
    const mediumSeverity = makeDiagnosed({
      signal: makeSignal({ severity: 'medium', sourceId: 'goal-2' }),
      confidence: 0.8,
      suggestedAction: 'Different action for medium severity goal',
    });

    const result = createGapActions(
      [lowSeverity, mediumSeverity],
      'moderate',
      [],
      { now: NOW },
    );
    // low severity should be filtered out by moderate (minSeverity=medium)
    expect(result).toHaveLength(1);
    expect(result[0].gap.signal.severity).toBe('medium');
  });
});

// ============ createGapActions — dedup ============

describe('createGapActions — deduplication', () => {
  it('skips gaps whose suggestedAction has >= 0.8 word overlap with existing items', () => {
    const diagnosed = [
      makeDiagnosed({
        suggestedAction: 'Ask about progress on Learn Rust goal',
        confidence: 0.8,
      }),
    ];
    const existingItems = [
      { message: 'Ask about progress on Learn Rust goal soon' },
    ];

    const result = createGapActions(diagnosed, 'moderate', existingItems, {
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('allows gaps with low word overlap against existing items', () => {
    const diagnosed = [
      makeDiagnosed({
        suggestedAction: 'Check the weather forecast for tomorrow',
        confidence: 0.8,
      }),
    ];
    const existingItems = [
      { message: 'Ask about progress on Learn Rust goal' },
    ];

    const result = createGapActions(diagnosed, 'moderate', existingItems, {
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });
});

// ============ createGapActions — budget & hard cap ============

describe('createGapActions — budget and hard cap', () => {
  it('stops after maxDailyNotifications reached', () => {
    // conservative: maxDailyNotifications=1
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'high', sourceId: 'g1' }),
        confidence: 0.9,
        suggestedAction: 'First action for first gap',
      }),
      makeDiagnosed({
        signal: makeSignal({ severity: 'high', sourceId: 'g2' }),
        confidence: 0.9,
        suggestedAction: 'Second action for second gap',
      }),
    ];

    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it('hard cap: max 3 actions per call regardless of dial', () => {
    // eager: maxDailyNotifications=5, but hard cap is 3
    const diagnosed = Array.from({ length: 6 }, (_, i) =>
      makeDiagnosed({
        signal: makeSignal({ severity: 'medium', sourceId: `g${i}` }),
        confidence: 0.8,
        suggestedAction: `Unique action number ${i} for gap ${i}`,
      }),
    );

    const result = createGapActions(diagnosed, 'eager', [], { now: NOW });
    expect(result).toHaveLength(3);
  });

  it('budget limit applies even when hard cap is higher', () => {
    // moderate: maxDailyNotifications=3, hard cap=3 (equal here)
    const diagnosed = Array.from({ length: 5 }, (_, i) =>
      makeDiagnosed({
        signal: makeSignal({ severity: 'medium', sourceId: `g${i}` }),
        confidence: 0.8,
        suggestedAction: `Unique moderate action number ${i} for gap ${i}`,
      }),
    );

    const result = createGapActions(diagnosed, 'moderate', [], { now: NOW });
    expect(result).toHaveLength(3);
  });
});

// ============ createGapActions — output shape ============

describe('createGapActions — output shape', () => {
  it('each action has correct scheduledItem shape', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({
          severity: 'high',
          type: 'stale_goal',
          sourceId: 'goal-42',
        }),
        confidence: 0.9,
        suggestedAction: 'Follow up on goal progress for Rust',
      }),
    ];

    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });

    expect(result).toHaveLength(1);
    const action = result[0];

    // GapAction shape
    expect(action).toHaveProperty('gap');
    expect(action).toHaveProperty('scheduledItem');

    // scheduledItem shape
    const item = action.scheduledItem;
    expect(item.source).toBe('agent');
    expect(item.type).toBe('follow_up');
    expect(item.message).toBe('Follow up on goal progress for Rust');
    expect(typeof item.userId).toBe('string');
    expect(item.triggerAt).toBe(NOW + THIRTY_MINUTES_MS);

    // context is JSON string with gapType and sourceId
    const ctx = JSON.parse(item.context);
    expect(ctx.gapType).toBe('stale_goal');
    expect(ctx.sourceId).toBe('goal-42');
  });

  it('triggerAt is now + 30 minutes', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'high' }),
        confidence: 0.9,
      }),
    ];

    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result[0].scheduledItem.triggerAt).toBe(NOW + THIRTY_MINUTES_MS);
  });

  it('message is the suggestedAction from the diagnosed gap', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'high' }),
        confidence: 0.9,
        suggestedAction: 'Check in about your Rust learning progress',
      }),
    ];

    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result[0].scheduledItem.message).toBe(
      'Check in about your Rust learning progress',
    );
  });
});

// ============ createGapActions — edge cases ============

describe('createGapActions — edge cases', () => {
  it('returns empty array for empty diagnosed input', () => {
    const result = createGapActions([], 'moderate', [], { now: NOW });
    expect(result).toEqual([]);
  });

  it('returns empty array when all gaps are filtered out', () => {
    const diagnosed = [
      makeDiagnosed({ actionable: false }),
      makeDiagnosed({
        confidence: 0.1,
        signal: makeSignal({ sourceId: 'g2' }),
      }),
      makeDiagnosed({
        signal: makeSignal({
          type: 'behavioral_anomaly',
          sourceId: 'g3',
        }),
      }),
    ];

    // conservative filters all: not actionable, low confidence, wrong type
    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('returns empty array when all gaps are duplicates', () => {
    const diagnosed = [
      makeDiagnosed({
        suggestedAction: 'Ask about progress on Learn Rust goal',
        confidence: 0.8,
      }),
    ];
    const existingItems = [
      { message: 'Ask about progress on Learn Rust goal' },
    ];

    const result = createGapActions(diagnosed, 'moderate', existingItems, {
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('returns up to budget limit when more gaps than budget', () => {
    // conservative: maxDailyNotifications=1
    const diagnosed = Array.from({ length: 5 }, (_, i) =>
      makeDiagnosed({
        signal: makeSignal({ severity: 'high', sourceId: `g${i}` }),
        confidence: 0.9,
        suggestedAction: `Unique high priority action ${i} for gap ${i}`,
      }),
    );

    const result = createGapActions(diagnosed, 'conservative', [], {
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it('uses Date.now() when no now option provided', () => {
    const diagnosed = [
      makeDiagnosed({
        signal: makeSignal({ severity: 'high' }),
        confidence: 0.9,
      }),
    ];

    const before = Date.now();
    const result = createGapActions(diagnosed, 'conservative', []);
    const after = Date.now();

    expect(result).toHaveLength(1);
    const triggerAt = result[0].scheduledItem.triggerAt;
    expect(triggerAt).toBeGreaterThanOrEqual(before + THIRTY_MINUTES_MS);
    expect(triggerAt).toBeLessThanOrEqual(after + THIRTY_MINUTES_MS);
  });
});
