/**
 * Tests for behavioral signal extractor functions.
 *
 * Covers message frequency, session engagement, topic switching,
 * and response length evolution. All functions are pure and stateless.
 */

import { describe, it, expect } from 'vitest';
import {
  updateEMA,
  detectTrend,
  computeMessageFrequency,
  computeSessionEngagement,
  computeTopicSwitchRate,
  computeResponseLengthEvolution,
  type MessageFrequencySignal,
  type SessionEngagementSignal,
  type TopicSwitchSignal,
  type ResponseLengthSignal,
  type BehavioralSignals,
} from './behavioral-signals.js';

// ============ Test Helpers ============

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Create a message with timestamp */
function makeTimestampMessage(timestamp: number): { timestamp: number } {
  return { timestamp };
}

/** Create N messages spread across a given number of days, starting from baseTime */
function makeMessagesSpread(count: number, days: number, baseTime: number = Date.now()): { timestamp: number }[] {
  const messages: { timestamp: number }[] = [];
  const intervalMs = (days * DAY_MS) / count;
  for (let i = 0; i < count; i++) {
    messages.push({ timestamp: baseTime - (count - 1 - i) * intervalMs });
  }
  return messages;
}

/** Create a session entry */
function makeSession(messageCount: number, durationMs: number, startTime: number): {
  messageCount: number;
  durationMs: number;
  startTime: number;
} {
  return { messageCount, durationMs, startTime };
}

/** Create a message with content and optional embedding */
function makeEmbeddedMessage(
  content: string,
  embedding?: number[],
): { content: string; embedding?: number[] } {
  return embedding ? { content, embedding } : { content };
}

/** Create a message with content and timestamp */
function makeContentMessage(content: string, timestamp: number): { content: string; timestamp: number } {
  return { content, timestamp };
}

/**
 * Generate an embedding vector. Similar topics produce similar vectors.
 * topic=0..N, dimension determines vector size.
 */
function makeEmbedding(topic: number, dimension: number = 64): number[] {
  const vec = new Array(dimension).fill(0);
  // Set a few dimensions based on topic to create distinct vectors
  const baseIdx = (topic * 7) % dimension;
  vec[baseIdx] = 1.0;
  vec[(baseIdx + 1) % dimension] = 0.8;
  vec[(baseIdx + 2) % dimension] = 0.5;
  return vec;
}

/** Generate a similar embedding (small perturbation of the base) */
function makeSimilarEmbedding(base: number[], noise: number = 0.05): number[] {
  return base.map((v) => v + (Math.random() - 0.5) * noise);
}

// ============ updateEMA ============

describe('updateEMA', () => {
  const HALF_LIFE_MS = 7 * DAY_MS;

  it('returns currentValue when previousEMA is 0 and timeDelta is large', () => {
    const result = updateEMA(10, 0, 30 * DAY_MS, HALF_LIFE_MS);
    // With large timeDelta relative to halfLife, weight approaches 1
    expect(result).toBeCloseTo(10, 0);
  });

  it('returns value between current and previous for moderate timeDelta', () => {
    const result = updateEMA(20, 10, 3.5 * DAY_MS, HALF_LIFE_MS);
    // At half the halfLife, weight = 1 - exp(-0.5) ~ 0.393
    // result ~ 0.393 * 20 + 0.607 * 10 ~ 13.93
    expect(result).toBeGreaterThan(10);
    expect(result).toBeLessThan(20);
  });

  it('stays close to previous when timeDelta is very small', () => {
    const result = updateEMA(100, 10, 1000, HALF_LIFE_MS); // 1 second vs 7-day halfLife
    // Weight is nearly 0, so result stays close to previous
    expect(result).toBeCloseTo(10, 0);
  });

  it('handles zero timeDelta by returning previousEMA', () => {
    const result = updateEMA(100, 50, 0, HALF_LIFE_MS);
    // weight = 1 - exp(0) = 0, so result = 0*100 + 1*50 = 50
    expect(result).toBeCloseTo(50, 5);
  });
});

// ============ detectTrend ============

describe('detectTrend', () => {
  it('returns "stable" for fewer than 4 values', () => {
    expect(detectTrend([1, 2, 3])).toBe('stable');
    expect(detectTrend([1])).toBe('stable');
    expect(detectTrend([])).toBe('stable');
  });

  it('returns "increasing" when second half average exceeds first half by >15%', () => {
    // First half avg: 10, Second half avg: 20 => delta = 100% > 15%
    expect(detectTrend([10, 10, 20, 20])).toBe('increasing');
    expect(detectTrend([5, 5, 5, 5, 10, 10, 10, 10])).toBe('increasing');
  });

  it('returns "decreasing" when second half average is <-15% of first half', () => {
    // First half avg: 20, Second half avg: 10 => delta = -50% < -15%
    expect(detectTrend([20, 20, 10, 10])).toBe('decreasing');
    expect(detectTrend([10, 10, 10, 10, 5, 5, 5, 5])).toBe('decreasing');
  });

  it('returns "stable" when halves are within 15%', () => {
    // First half avg: 10, Second half avg: 11 => delta = 10% < 15%
    expect(detectTrend([10, 10, 11, 11])).toBe('stable');
    // First half avg: 10, Second half avg: 9 => delta = -10% > -15%
    expect(detectTrend([10, 10, 9, 9])).toBe('stable');
  });

  it('handles odd-length arrays by splitting at midpoint', () => {
    // [5, 5, 5, 15, 15] => first half [5, 5], second half [5, 15, 15]
    // first avg: 5, second avg: ~11.67 => delta = 133% > 15%
    expect(detectTrend([5, 5, 5, 15, 15])).toBe('increasing');
  });
});

// ============ computeMessageFrequency ============

describe('computeMessageFrequency', () => {
  it('returns null for empty array', () => {
    expect(computeMessageFrequency([], null)).toBeNull();
  });

  it('returns null for fewer than 10 messages (cold start)', () => {
    const messages = makeMessagesSpread(9, 5);
    expect(computeMessageFrequency(messages, null)).toBeNull();
  });

  it('returns a signal for exactly 10 messages', () => {
    const messages = makeMessagesSpread(10, 7);
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    expect(result!.dailyRate).toBeGreaterThan(0);
    expect(result!.weeklyAvg).toBeGreaterThan(0);
    expect(result!.lastComputed).toBeGreaterThan(0);
  });

  it('computes reasonable daily rate for single-day messages', () => {
    const baseTime = Date.now();
    const messages: { timestamp: number }[] = [];
    // 15 messages all within the same day
    for (let i = 0; i < 15; i++) {
      messages.push({ timestamp: baseTime - i * HOUR_MS });
    }
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    // All messages in one day, so daily rate should be high (EMA smoothing may reduce slightly below count)
    expect(result!.dailyRate).toBeGreaterThan(4.0);
  });

  it('computes EMA-smoothed daily rate for multi-day spread', () => {
    // 20 messages spread across 14 days
    const messages = makeMessagesSpread(20, 14);
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    // ~1.4 messages/day on average
    expect(result!.dailyRate).toBeGreaterThan(0.5);
    expect(result!.dailyRate).toBeLessThan(5);
    expect(result!.weeklyAvg).toBeCloseTo(result!.dailyRate * 7, 0);
  });

  it('detects increasing trend when more messages in second half', () => {
    const baseTime = Date.now();
    const messages: { timestamp: number }[] = [];
    // First 7 days: 1 message/day
    for (let d = 0; d < 7; d++) {
      messages.push({ timestamp: baseTime - (13 - d) * DAY_MS });
    }
    // Last 7 days: 5 messages/day
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 5; m++) {
        messages.push({ timestamp: baseTime - (6 - d) * DAY_MS + m * HOUR_MS });
      }
    }
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('increasing');
  });

  it('detects decreasing trend when fewer messages in second half', () => {
    const baseTime = Date.now();
    const messages: { timestamp: number }[] = [];
    // First 7 days: 5 messages/day
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 5; m++) {
        messages.push({ timestamp: baseTime - (13 - d) * DAY_MS + m * HOUR_MS });
      }
    }
    // Last 7 days: 1 message/day
    for (let d = 0; d < 7; d++) {
      messages.push({ timestamp: baseTime - (6 - d) * DAY_MS });
    }
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('decreasing');
  });

  it('detects stable trend when messages are evenly distributed', () => {
    // 28 messages spread evenly across 14 days = 2/day uniform
    const messages = makeMessagesSpread(28, 14);
    const result = computeMessageFrequency(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('stable');
  });

  it('handles all messages at same timestamp gracefully', () => {
    const t = Date.now();
    const messages = Array.from({ length: 15 }, () => ({ timestamp: t }));
    const result = computeMessageFrequency(messages, null);
    // Should not throw; may return a signal with all messages in one bucket
    expect(result).not.toBeNull();
    expect(result!.dailyRate).toBeGreaterThan(0);
  });
});

// ============ computeSessionEngagement ============

describe('computeSessionEngagement', () => {
  it('returns null for empty sessions array', () => {
    expect(computeSessionEngagement([], null)).toBeNull();
  });

  it('returns null for fewer than 3 sessions (cold start)', () => {
    const sessions = [
      makeSession(5, 10 * 60 * 1000, Date.now() - DAY_MS),
      makeSession(3, 5 * 60 * 1000, Date.now()),
    ];
    expect(computeSessionEngagement(sessions, null)).toBeNull();
  });

  it('computes correct averages for 3 uniform sessions', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(10, 20 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(10, 20 * 60 * 1000, baseTime - DAY_MS),
      makeSession(10, 20 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.avgMessagesPerSession).toBeCloseTo(10, 0);
    expect(result!.avgDurationMs).toBeCloseTo(20 * 60 * 1000, -3);
  });

  it('reflects short sessions with low averages', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(2, 1 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(1, 30 * 1000, baseTime - DAY_MS),
      makeSession(3, 2 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.avgMessagesPerSession).toBeLessThan(5);
    expect(result!.avgDurationMs).toBeLessThan(5 * 60 * 1000);
  });

  it('reflects long sessions with high averages', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(50, 60 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(40, 45 * 60 * 1000, baseTime - DAY_MS),
      makeSession(60, 90 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.avgMessagesPerSession).toBeGreaterThan(30);
    expect(result!.avgDurationMs).toBeGreaterThan(30 * 60 * 1000);
  });

  it('detects increasing engagement trend', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(2, 2 * 60 * 1000, baseTime - 6 * DAY_MS),
      makeSession(3, 3 * 60 * 1000, baseTime - 5 * DAY_MS),
      makeSession(10, 15 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(15, 20 * 60 * 1000, baseTime - DAY_MS),
      makeSession(20, 30 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('increasing');
  });

  it('detects decreasing engagement trend', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(20, 30 * 60 * 1000, baseTime - 6 * DAY_MS),
      makeSession(15, 20 * 60 * 1000, baseTime - 5 * DAY_MS),
      makeSession(3, 3 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(2, 2 * 60 * 1000, baseTime - DAY_MS),
      makeSession(1, 1 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('decreasing');
  });

  it('sets lastComputed to a recent timestamp', () => {
    const baseTime = Date.now();
    const sessions = [
      makeSession(5, 10 * 60 * 1000, baseTime - 2 * DAY_MS),
      makeSession(5, 10 * 60 * 1000, baseTime - DAY_MS),
      makeSession(5, 10 * 60 * 1000, baseTime),
    ];
    const result = computeSessionEngagement(sessions, null);
    expect(result).not.toBeNull();
    expect(result!.lastComputed).toBeGreaterThan(0);
  });
});

// ============ computeTopicSwitchRate ============

describe('computeTopicSwitchRate', () => {
  it('returns null for empty messages array', () => {
    expect(computeTopicSwitchRate([], null)).toBeNull();
  });

  it('returns null when fewer than 5 messages have embeddings', () => {
    const messages = [
      makeEmbeddedMessage('hello', makeEmbedding(0)),
      makeEmbeddedMessage('world', makeEmbedding(0)),
      makeEmbeddedMessage('test', makeEmbedding(1)),
      makeEmbeddedMessage('no embedding'),
      makeEmbeddedMessage('also no embedding'),
    ];
    // Only 3 have embeddings
    expect(computeTopicSwitchRate(messages, null)).toBeNull();
  });

  it('returns null when fewer than 5 messages have embeddings (mixed)', () => {
    const messages = [
      makeEmbeddedMessage('a', makeEmbedding(0)),
      makeEmbeddedMessage('b'), // no embedding
      makeEmbeddedMessage('c', makeEmbedding(1)),
      makeEmbeddedMessage('d', makeEmbedding(2)),
      makeEmbeddedMessage('e', makeEmbedding(3)),
    ];
    // Only 4 have embeddings
    expect(computeTopicSwitchRate(messages, null)).toBeNull();
  });

  it('detects high switch rate with dissimilar embeddings', () => {
    // 6 messages, each on a different topic
    const messages = [
      makeEmbeddedMessage('topic A', makeEmbedding(0)),
      makeEmbeddedMessage('topic B', makeEmbedding(1)),
      makeEmbeddedMessage('topic C', makeEmbedding(2)),
      makeEmbeddedMessage('topic D', makeEmbedding(3)),
      makeEmbeddedMessage('topic E', makeEmbedding(4)),
      makeEmbeddedMessage('topic F', makeEmbedding(5)),
    ];
    const result = computeTopicSwitchRate(messages, null);
    expect(result).not.toBeNull();
    // Every consecutive pair is dissimilar => switch rate should be high
    expect(result!.switchRate).toBeGreaterThan(0.5);
    expect(result!.totalSwitches).toBeGreaterThanOrEqual(4);
    expect(result!.avgTopicDepth).toBeLessThanOrEqual(2);
  });

  it('detects low switch rate with similar embeddings (topic continuity)', () => {
    const baseTopic = makeEmbedding(0);
    const messages = [
      makeEmbeddedMessage('msg 1', makeSimilarEmbedding(baseTopic)),
      makeEmbeddedMessage('msg 2', makeSimilarEmbedding(baseTopic)),
      makeEmbeddedMessage('msg 3', makeSimilarEmbedding(baseTopic)),
      makeEmbeddedMessage('msg 4', makeSimilarEmbedding(baseTopic)),
      makeEmbeddedMessage('msg 5', makeSimilarEmbedding(baseTopic)),
      makeEmbeddedMessage('msg 6', makeSimilarEmbedding(baseTopic)),
    ];
    const result = computeTopicSwitchRate(messages, null);
    expect(result).not.toBeNull();
    // All similar => switch rate should be low
    expect(result!.switchRate).toBeLessThan(0.3);
    expect(result!.avgTopicDepth).toBeGreaterThan(3);
  });

  it('filters out messages without embeddings before computing', () => {
    const messages = [
      makeEmbeddedMessage('a', makeEmbedding(0)),
      makeEmbeddedMessage('no embed 1'),
      makeEmbeddedMessage('b', makeEmbedding(0)),
      makeEmbeddedMessage('no embed 2'),
      makeEmbeddedMessage('c', makeEmbedding(0)),
      makeEmbeddedMessage('d', makeEmbedding(0)),
      makeEmbeddedMessage('e', makeEmbedding(0)),
    ];
    // 5 messages with embeddings, all similar topic
    const result = computeTopicSwitchRate(messages, null);
    expect(result).not.toBeNull();
    expect(result!.switchRate).toBeLessThan(0.3);
  });

  it('sets lastComputed timestamp', () => {
    const messages = [
      makeEmbeddedMessage('a', makeEmbedding(0)),
      makeEmbeddedMessage('b', makeEmbedding(1)),
      makeEmbeddedMessage('c', makeEmbedding(2)),
      makeEmbeddedMessage('d', makeEmbedding(3)),
      makeEmbeddedMessage('e', makeEmbedding(4)),
    ];
    const result = computeTopicSwitchRate(messages, null);
    expect(result).not.toBeNull();
    expect(result!.lastComputed).toBeGreaterThan(0);
  });
});

// ============ computeResponseLengthEvolution ============

describe('computeResponseLengthEvolution', () => {
  it('returns null for empty array', () => {
    expect(computeResponseLengthEvolution([], null)).toBeNull();
  });

  it('returns null for fewer than 10 messages (cold start)', () => {
    const messages = Array.from({ length: 9 }, (_, i) =>
      makeContentMessage('short', Date.now() - i * DAY_MS),
    );
    expect(computeResponseLengthEvolution(messages, null)).toBeNull();
  });

  it('computes average length for 10 equal-length messages', () => {
    const content = 'x'.repeat(50); // 50 chars each
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeContentMessage(content, Date.now() - (9 - i) * DAY_MS),
    );
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.avgLength).toBeCloseTo(50, -1); // within ~10
  });

  it('detects increasing trend when messages get longer over time', () => {
    const baseTime = Date.now();
    const messages: { content: string; timestamp: number }[] = [];
    // First 7 messages: short (20 chars)
    for (let i = 0; i < 7; i++) {
      messages.push(makeContentMessage('x'.repeat(20), baseTime - (13 - i) * DAY_MS));
    }
    // Last 7 messages: long (200 chars)
    for (let i = 0; i < 7; i++) {
      messages.push(makeContentMessage('x'.repeat(200), baseTime - (6 - i) * DAY_MS));
    }
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('increasing');
  });

  it('detects decreasing trend when messages get shorter over time', () => {
    const baseTime = Date.now();
    const messages: { content: string; timestamp: number }[] = [];
    // First 7 messages: long (200 chars)
    for (let i = 0; i < 7; i++) {
      messages.push(makeContentMessage('x'.repeat(200), baseTime - (13 - i) * DAY_MS));
    }
    // Last 7 messages: short (20 chars)
    for (let i = 0; i < 7; i++) {
      messages.push(makeContentMessage('x'.repeat(20), baseTime - (6 - i) * DAY_MS));
    }
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('decreasing');
  });

  it('detects stable trend when message lengths are consistent', () => {
    const messages = Array.from({ length: 14 }, (_, i) =>
      makeContentMessage('x'.repeat(100), Date.now() - (13 - i) * DAY_MS),
    );
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('stable');
  });

  it('handles all messages at same timestamp gracefully', () => {
    const t = Date.now();
    const messages = Array.from({ length: 12 }, () =>
      makeContentMessage('hello world testing', t),
    );
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.avgLength).toBeGreaterThan(0);
  });

  it('sets lastComputed to a recent timestamp', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeContentMessage('test message content', Date.now() - (9 - i) * DAY_MS),
    );
    const result = computeResponseLengthEvolution(messages, null);
    expect(result).not.toBeNull();
    expect(result!.lastComputed).toBeGreaterThan(0);
  });
});

// ============ BehavioralSignals type check ============

describe('BehavioralSignals container type', () => {
  it('accepts all signal types as optional fields', () => {
    const signals: BehavioralSignals = {};
    expect(signals).toBeDefined();

    const fullSignals: BehavioralSignals = {
      messageFrequency: {
        dailyRate: 5,
        weeklyAvg: 35,
        trend: 'stable',
        lastComputed: Date.now(),
      },
      sessionEngagement: {
        avgMessagesPerSession: 10,
        avgDurationMs: 600000,
        trend: 'increasing',
        lastComputed: Date.now(),
      },
      topicSwitch: {
        switchRate: 0.3,
        avgTopicDepth: 4,
        totalSwitches: 12,
        lastComputed: Date.now(),
      },
      responseLength: {
        avgLength: 150,
        trend: 'stable',
        lastComputed: Date.now(),
      },
    };
    expect(fullSignals.messageFrequency).toBeDefined();
    expect(fullSignals.sessionEngagement).toBeDefined();
    expect(fullSignals.topicSwitch).toBeDefined();
    expect(fullSignals.responseLength).toBeDefined();
  });
});
