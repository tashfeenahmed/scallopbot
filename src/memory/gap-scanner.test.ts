/**
 * Tests for gap signal heuristics (Stage 1).
 *
 * Pure functions that scan existing data for:
 * - Stale goals (no updates, overdue, missed check-ins)
 * - Behavioral anomalies (frequency drops, disengagement)
 * - Unresolved threads (unanswered questions in recent sessions)
 *
 * Returns typed GapSignal[] for downstream LLM triage.
 */

import { describe, it, expect } from 'vitest';
import {
  scanStaleGoals,
  scanBehavioralAnomalies,
  scanUnresolvedThreads,
  scanForGaps,
  type GapSignal,
  type GapScanInput,
} from './gap-scanner.js';
import type { GoalItem } from '../goals/types.js';
import type { BehavioralPatterns, SessionSummaryRow } from './db.js';

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed "now" for deterministic tests */
const NOW = new Date('2026-02-10T12:00:00Z').getTime();

// ============ Test Helpers ============

/** Create a minimal GoalItem for testing */
function makeGoal(overrides: {
  id?: string;
  userId?: string;
  title?: string;
  status?: 'backlog' | 'active' | 'completed';
  dueDate?: number;
  checkinFrequency?: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  updatedAt?: number;
}): GoalItem {
  return {
    id: overrides.id ?? 'goal-1',
    userId: overrides.userId ?? 'user-1',
    content: overrides.title ?? 'Test Goal',
    category: 'preference',
    memoryType: 'semantic',
    importance: 5,
    confidence: 1.0,
    isLatest: true,
    documentDate: NOW - 30 * DAY_MS,
    eventDate: null,
    metadata: {
      goalType: 'goal',
      status: overrides.status ?? 'active',
      dueDate: overrides.dueDate,
      checkinFrequency: overrides.checkinFrequency,
    },
    updatedAt: overrides.updatedAt ?? NOW - 15 * DAY_MS,
  } as unknown as GoalItem;
}

/** Create a minimal BehavioralPatterns for testing */
function makeSignals(overrides?: {
  messageFrequency?: {
    dailyRate: number;
    weeklyAvg: number;
    trend: string;
    lastComputed: number;
  } | null;
  sessionEngagement?: {
    avgMessagesPerSession: number;
    avgDurationMs: number;
    trend: string;
    lastComputed: number;
  } | null;
  responseLength?: {
    avgLength: number;
    trend: string;
    lastComputed: number;
  } | null;
}): BehavioralPatterns {
  return {
    userId: 'user-1',
    communicationStyle: null,
    expertiseAreas: [],
    responsePreferences: {},
    activeHours: [],
    messageFrequency: overrides?.messageFrequency ?? null,
    sessionEngagement: overrides?.sessionEngagement ?? null,
    topicSwitch: null,
    responseLength: overrides?.responseLength ?? null,
    affectState: null,
    smoothedAffect: null,
    updatedAt: NOW,
  } as unknown as BehavioralPatterns;
}

/** Create a minimal SessionSummaryRow for testing */
function makeSummary(overrides: {
  id?: string;
  sessionId?: string;
  userId?: string;
  summary?: string;
  topics?: string[];
  messageCount?: number;
  durationMs?: number;
  createdAt?: number;
}): SessionSummaryRow {
  return {
    id: overrides.id ?? 'summary-1',
    sessionId: overrides.sessionId ?? 'session-1',
    userId: overrides.userId ?? 'user-1',
    summary: overrides.summary ?? 'Test session summary',
    topics: overrides.topics ?? ['general'],
    messageCount: overrides.messageCount ?? 10,
    durationMs: overrides.durationMs ?? 600000,
    embedding: null,
    createdAt: overrides.createdAt ?? NOW - 1 * DAY_MS,
  } as unknown as SessionSummaryRow;
}

// ============ scanStaleGoals ============

describe('scanStaleGoals', () => {
  it('returns empty array for empty goals', () => {
    const result = scanStaleGoals([], NOW);
    expect(result).toEqual([]);
  });

  it('returns empty array when goal was updated recently', () => {
    const goal = makeGoal({
      id: 'g1',
      title: 'Active Goal',
      updatedAt: NOW - 2 * DAY_MS, // 2 days ago — within 14-day window
    });
    const result = scanStaleGoals([goal], NOW);
    expect(result).toEqual([]);
  });

  it('detects stale goal with no dueDate and updatedAt > 14 days ago', () => {
    const goal = makeGoal({
      id: 'g2',
      title: 'Forgotten Goal',
      updatedAt: NOW - 15 * DAY_MS, // 15 days ago
    });
    const result = scanStaleGoals([goal], NOW);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_goal');
    expect(result[0].severity).toBe('medium');
    expect(result[0].sourceId).toBe('g2');
    expect(result[0].description).toContain('Forgotten Goal');
  });

  it('detects overdue goal with dueDate passed and status active', () => {
    const goal = makeGoal({
      id: 'g3',
      title: 'Overdue Goal',
      dueDate: NOW - 3 * DAY_MS, // 3 days past due
      status: 'active',
      updatedAt: NOW - 1 * DAY_MS, // recently updated, but overdue
    });
    const result = scanStaleGoals([goal], NOW);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_goal');
    expect(result[0].severity).toBe('high');
    expect(result[0].sourceId).toBe('g3');
    expect(result[0].description).toContain('Overdue Goal');
  });

  it('does not flag completed goal even if overdue', () => {
    const goal = makeGoal({
      id: 'g4',
      title: 'Done Goal',
      dueDate: NOW - 5 * DAY_MS,
      status: 'completed',
      updatedAt: NOW - 20 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    expect(result).toEqual([]);
  });

  it('detects missed check-in with ratio > 3.0', () => {
    // weekly check-in (7 days), last updated 22 days ago → ratio = 22/7 ≈ 3.14
    const goal = makeGoal({
      id: 'g5',
      title: 'Weekly Review',
      checkinFrequency: 'weekly',
      updatedAt: NOW - 22 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    // Should produce at least a stale_goal signal for missed check-in
    const checkinSignal = result.find(
      (s) => s.sourceId === 'g5' && s.description.toLowerCase().includes('check'),
    );
    expect(checkinSignal).toBeDefined();
    expect(checkinSignal!.type).toBe('stale_goal');
    expect(checkinSignal!.severity).toBe('medium');
  });

  it('does not flag check-in when ratio <= 3.0', () => {
    // weekly check-in (7 days), last updated 20 days ago → ratio = 20/7 ≈ 2.86
    const goal = makeGoal({
      id: 'g6',
      title: 'Weekly Review OK',
      checkinFrequency: 'weekly',
      updatedAt: NOW - 20 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    // May get a stale signal for >14 days, but should NOT have a check-in signal
    const checkinSignal = result.find(
      (s) => s.sourceId === 'g6' && s.description.toLowerCase().includes('check'),
    );
    expect(checkinSignal).toBeUndefined();
  });

  it('handles daily check-in frequency', () => {
    // daily check-in (1 day), last updated 4 days ago → ratio = 4/1 = 4.0 > 3.0
    const goal = makeGoal({
      id: 'g7',
      title: 'Daily Standup',
      checkinFrequency: 'daily',
      updatedAt: NOW - 4 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    const checkinSignal = result.find(
      (s) => s.sourceId === 'g7' && s.description.toLowerCase().includes('check'),
    );
    expect(checkinSignal).toBeDefined();
    expect(checkinSignal!.severity).toBe('medium');
  });

  it('handles monthly check-in frequency', () => {
    // monthly check-in (30 days), last updated 100 days ago → ratio = 100/30 ≈ 3.33 > 3.0
    const goal = makeGoal({
      id: 'g8',
      title: 'Monthly Review',
      checkinFrequency: 'monthly',
      updatedAt: NOW - 100 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    const checkinSignal = result.find(
      (s) => s.sourceId === 'g8' && s.description.toLowerCase().includes('check'),
    );
    expect(checkinSignal).toBeDefined();
  });

  it('handles biweekly check-in frequency', () => {
    // biweekly check-in (14 days), last updated 43 days ago → ratio = 43/14 ≈ 3.07 > 3.0
    const goal = makeGoal({
      id: 'g9',
      title: 'Biweekly Sync',
      checkinFrequency: 'biweekly',
      updatedAt: NOW - 43 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    const checkinSignal = result.find(
      (s) => s.sourceId === 'g9' && s.description.toLowerCase().includes('check'),
    );
    expect(checkinSignal).toBeDefined();
  });

  it('does not double-count: overdue goal also stale produces distinct signals', () => {
    const goal = makeGoal({
      id: 'g10',
      title: 'Double Trouble',
      dueDate: NOW - 5 * DAY_MS,
      status: 'active',
      updatedAt: NOW - 20 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    // Should have high severity for overdue, potentially also stale/checkin
    expect(result.length).toBeGreaterThanOrEqual(1);
    const highSignal = result.find((s) => s.severity === 'high');
    expect(highSignal).toBeDefined();
  });

  it('skips backlog goals for staleness (only active goals)', () => {
    const goal = makeGoal({
      id: 'g11',
      title: 'Backlog Goal',
      status: 'backlog',
      updatedAt: NOW - 30 * DAY_MS,
    });
    const result = scanStaleGoals([goal], NOW);
    expect(result).toEqual([]);
  });

  it('processes multiple goals and returns signals for each stale one', () => {
    const goals = [
      makeGoal({ id: 'fresh', title: 'Fresh Goal', updatedAt: NOW - 1 * DAY_MS }),
      makeGoal({ id: 'stale', title: 'Stale Goal', updatedAt: NOW - 16 * DAY_MS }),
      makeGoal({
        id: 'overdue',
        title: 'Overdue Goal',
        dueDate: NOW - 2 * DAY_MS,
        status: 'active',
        updatedAt: NOW - 1 * DAY_MS,
      }),
    ];
    const result = scanStaleGoals(goals, NOW);
    const sourceIds = result.map((s) => s.sourceId);
    expect(sourceIds).toContain('stale');
    expect(sourceIds).toContain('overdue');
    expect(sourceIds).not.toContain('fresh');
  });
});

// ============ scanBehavioralAnomalies ============

describe('scanBehavioralAnomalies', () => {
  it('returns empty array when messageFrequency is null (cold start)', () => {
    const signals = makeSignals({ messageFrequency: null });
    const result = scanBehavioralAnomalies(signals, NOW);
    expect(result).toEqual([]);
  });

  it('detects frequency drop: decreasing trend AND dailyRate < weeklyAvg * 0.5', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 2,
        weeklyAvg: 10, // 2 < 10 * 0.5 = 5
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('behavioral_anomaly');
    expect(result[0].severity).toBe('low');
    expect(result[0].description.toLowerCase()).toContain('frequency');
  });

  it('does not flag frequency when trend is not decreasing', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 2,
        weeklyAvg: 10,
        trend: 'stable',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    // Should not produce a frequency drop signal
    const freqSignal = result.find((s) =>
      s.description.toLowerCase().includes('frequency'),
    );
    expect(freqSignal).toBeUndefined();
  });

  it('does not flag frequency when dailyRate >= weeklyAvg * 0.5', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 6,
        weeklyAvg: 10, // 6 >= 10 * 0.5 = 5
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    const freqSignal = result.find((s) =>
      s.description.toLowerCase().includes('frequency'),
    );
    expect(freqSignal).toBeUndefined();
  });

  it('detects low session engagement: decreasing trend AND avgMessagesPerSession < 3', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 5,
        weeklyAvg: 5,
        trend: 'stable',
        lastComputed: NOW,
      },
      sessionEngagement: {
        avgMessagesPerSession: 2,
        avgDurationMs: 300000,
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    const engageSignal = result.find((s) =>
      s.description.toLowerCase().includes('engagement') ||
      s.description.toLowerCase().includes('session'),
    );
    expect(engageSignal).toBeDefined();
    expect(engageSignal!.type).toBe('behavioral_anomaly');
    expect(engageSignal!.severity).toBe('low');
  });

  it('does not flag engagement when avgMessagesPerSession >= 3', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 5,
        weeklyAvg: 5,
        trend: 'stable',
        lastComputed: NOW,
      },
      sessionEngagement: {
        avgMessagesPerSession: 5,
        avgDurationMs: 600000,
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    const engageSignal = result.find((s) =>
      s.description.toLowerCase().includes('engagement') ||
      s.description.toLowerCase().includes('session'),
    );
    expect(engageSignal).toBeUndefined();
  });

  it('detects declining response length: trend === decreasing', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 5,
        weeklyAvg: 5,
        trend: 'stable',
        lastComputed: NOW,
      },
      responseLength: {
        avgLength: 50,
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    const lengthSignal = result.find((s) =>
      s.description.toLowerCase().includes('response') ||
      s.description.toLowerCase().includes('length') ||
      s.description.toLowerCase().includes('shorter'),
    );
    expect(lengthSignal).toBeDefined();
    expect(lengthSignal!.type).toBe('behavioral_anomaly');
    expect(lengthSignal!.severity).toBe('low');
  });

  it('does not flag response length when trend is stable', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 5,
        weeklyAvg: 5,
        trend: 'stable',
        lastComputed: NOW,
      },
      responseLength: {
        avgLength: 50,
        trend: 'stable',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    const lengthSignal = result.find((s) =>
      s.description.toLowerCase().includes('response') ||
      s.description.toLowerCase().includes('length') ||
      s.description.toLowerCase().includes('shorter'),
    );
    expect(lengthSignal).toBeUndefined();
  });

  it('returns multiple anomalies when all conditions met', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 1,
        weeklyAvg: 10, // drop
        trend: 'decreasing',
        lastComputed: NOW,
      },
      sessionEngagement: {
        avgMessagesPerSession: 1,
        avgDurationMs: 60000,
        trend: 'decreasing',
        lastComputed: NOW,
      },
      responseLength: {
        avgLength: 20,
        trend: 'decreasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    expect(result.length).toBe(3);
    expect(result.every((s) => s.type === 'behavioral_anomaly')).toBe(true);
    expect(result.every((s) => s.severity === 'low')).toBe(true);
  });

  it('returns empty when no anomaly conditions met', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 8,
        weeklyAvg: 7,
        trend: 'increasing',
        lastComputed: NOW,
      },
      sessionEngagement: {
        avgMessagesPerSession: 10,
        avgDurationMs: 600000,
        trend: 'stable',
        lastComputed: NOW,
      },
      responseLength: {
        avgLength: 200,
        trend: 'increasing',
        lastComputed: NOW,
      },
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    expect(result).toEqual([]);
  });

  it('handles null sessionEngagement and responseLength gracefully', () => {
    const signals = makeSignals({
      messageFrequency: {
        dailyRate: 8,
        weeklyAvg: 7,
        trend: 'stable',
        lastComputed: NOW,
      },
      sessionEngagement: null,
      responseLength: null,
    });
    const result = scanBehavioralAnomalies(signals, NOW);
    expect(result).toEqual([]);
  });
});

// ============ scanUnresolvedThreads ============

describe('scanUnresolvedThreads', () => {
  it('returns empty array for empty summaries', () => {
    const result = scanUnresolvedThreads([], NOW);
    expect(result).toEqual([]);
  });

  it('detects unresolved question with no follow-up within 48h', () => {
    const summary = makeSummary({
      id: 's1',
      topics: ['How to deploy?', 'infrastructure'],
      createdAt: NOW - 3 * DAY_MS, // 3 days ago, within 7-day window
      messageCount: 5,
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unresolved_thread');
    expect(result[0].severity).toBe('medium');
    expect(result[0].sourceId).toBe('s1');
  });

  it('does not flag question when follow-up exists within 48h', () => {
    const summaries = [
      makeSummary({
        id: 's2',
        topics: ['How to deploy?'],
        createdAt: NOW - 3 * DAY_MS,
        messageCount: 5,
      }),
      makeSummary({
        id: 's3',
        topics: ['deployment setup'],
        createdAt: NOW - 3 * DAY_MS + 24 * 60 * 60 * 1000, // 24h after s2 (within 48h)
        messageCount: 8,
      }),
    ];
    const result = scanUnresolvedThreads(summaries, NOW);
    // s2 has a follow-up within 48h, so no unresolved signal
    const s2Signal = result.find((s) => s.sourceId === 's2');
    expect(s2Signal).toBeUndefined();
  });

  it('skips summary with messageCount < 3 AND age < 48h (too fresh/short)', () => {
    const summary = makeSummary({
      id: 's4',
      topics: ['What is this?'],
      createdAt: NOW - 1 * DAY_MS, // 1 day ago
      messageCount: 2, // < 3
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toEqual([]);
  });

  it('does not skip summary with messageCount < 3 but age >= 48h', () => {
    const summary = makeSummary({
      id: 's5',
      topics: ['What is happening?'],
      createdAt: NOW - 3 * DAY_MS, // 3 days ago (>= 48h)
      messageCount: 2, // < 3 but old enough
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('s5');
  });

  it('does not flag topics without question marks', () => {
    const summary = makeSummary({
      id: 's6',
      topics: ['deployment', 'infrastructure'],
      createdAt: NOW - 3 * DAY_MS,
      messageCount: 10,
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toEqual([]);
  });

  it('does not flag summaries older than 7 days', () => {
    const summary = makeSummary({
      id: 's7',
      topics: ['How to fix this?'],
      createdAt: NOW - 8 * DAY_MS, // 8 days ago
      messageCount: 10,
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toEqual([]);
  });

  it('handles multiple summaries with mixed resolution states', () => {
    const summaries = [
      // Unresolved: question, no follow-up, 4 days old
      makeSummary({
        id: 'unresolved',
        topics: ['Should we migrate?'],
        createdAt: NOW - 4 * DAY_MS,
        messageCount: 6,
      }),
      // Resolved: question with follow-up within 48h
      makeSummary({
        id: 'resolved-q',
        topics: ['How to configure?'],
        createdAt: NOW - 5 * DAY_MS,
        messageCount: 5,
      }),
      makeSummary({
        id: 'resolved-followup',
        topics: ['configuration details'],
        createdAt: NOW - 5 * DAY_MS + 12 * 60 * 60 * 1000, // 12h later
        messageCount: 8,
      }),
      // No question: no signal
      makeSummary({
        id: 'no-question',
        topics: ['general chat'],
        createdAt: NOW - 2 * DAY_MS,
        messageCount: 10,
      }),
    ];
    const result = scanUnresolvedThreads(summaries, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('unresolved');
  });

  it('detects question mark anywhere in topics array', () => {
    const summary = makeSummary({
      id: 's8',
      topics: ['general', 'is this working?', 'setup'],
      createdAt: NOW - 3 * DAY_MS,
      messageCount: 5,
    });
    const result = scanUnresolvedThreads([summary], NOW);
    expect(result).toHaveLength(1);
  });
});

// ============ scanForGaps (orchestrator) ============

describe('scanForGaps', () => {
  it('returns empty array when all inputs are clean', () => {
    const input: GapScanInput = {
      activeGoals: [
        makeGoal({ id: 'g1', updatedAt: NOW - 1 * DAY_MS }),
      ],
      behavioralSignals: makeSignals({
        messageFrequency: {
          dailyRate: 8,
          weeklyAvg: 7,
          trend: 'stable',
          lastComputed: NOW,
        },
      }),
      sessionSummaries: [
        makeSummary({ id: 's1', topics: ['general'], createdAt: NOW - 1 * DAY_MS }),
      ],
      now: NOW,
    };
    const result = scanForGaps(input);
    expect(result).toEqual([]);
  });

  it('combines signals from all sub-scanners', () => {
    const input: GapScanInput = {
      activeGoals: [
        makeGoal({
          id: 'stale-goal',
          title: 'Stale Goal',
          updatedAt: NOW - 20 * DAY_MS,
        }),
      ],
      behavioralSignals: makeSignals({
        messageFrequency: {
          dailyRate: 1,
          weeklyAvg: 10,
          trend: 'decreasing',
          lastComputed: NOW,
        },
      }),
      sessionSummaries: [
        makeSummary({
          id: 'unresolved-q',
          topics: ['How to fix this?'],
          createdAt: NOW - 3 * DAY_MS,
          messageCount: 5,
        }),
      ],
      now: NOW,
    };
    const result = scanForGaps(input);
    const types = result.map((s) => s.type);
    expect(types).toContain('stale_goal');
    expect(types).toContain('behavioral_anomaly');
    expect(types).toContain('unresolved_thread');
  });

  it('uses Date.now() when now is not provided', () => {
    const input: GapScanInput = {
      activeGoals: [],
      behavioralSignals: makeSignals(),
      sessionSummaries: [],
      // now not provided — should default to Date.now()
    };
    // Should not throw
    const result = scanForGaps(input);
    expect(result).toEqual([]);
  });

  it('returns GapSignal[] with correct shape', () => {
    const input: GapScanInput = {
      activeGoals: [
        makeGoal({
          id: 'g1',
          title: 'Overdue',
          dueDate: NOW - 2 * DAY_MS,
          status: 'active',
          updatedAt: NOW - 1 * DAY_MS,
        }),
      ],
      behavioralSignals: makeSignals(),
      sessionSummaries: [],
      now: NOW,
    };
    const result = scanForGaps(input);
    expect(result).toHaveLength(1);
    const signal = result[0];
    expect(signal).toHaveProperty('type');
    expect(signal).toHaveProperty('severity');
    expect(signal).toHaveProperty('description');
    expect(signal).toHaveProperty('context');
    expect(signal).toHaveProperty('sourceId');
    expect(typeof signal.type).toBe('string');
    expect(typeof signal.severity).toBe('string');
    expect(typeof signal.description).toBe('string');
    expect(typeof signal.context).toBe('object');
    expect(typeof signal.sourceId).toBe('string');
  });
});
