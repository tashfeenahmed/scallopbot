/**
 * Behavioral signal extractor functions.
 *
 * Pure functions that compute behavioral signals from message arrays
 * and existing signal state. No database access, no side effects.
 *
 * Signals: message frequency, session engagement, topic switching,
 * and response length evolution.
 */

import { cosineSimilarity } from './embeddings.js';

// ============ Constants ============

/** Default EMA half-life: 7 days in milliseconds */
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Milliseconds per day */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cosine similarity threshold below which consecutive messages are considered a topic switch */
const TOPIC_SWITCH_THRESHOLD = 0.3;

// ============ Interfaces ============

export interface MessageFrequencySignal {
  dailyRate: number;
  weeklyAvg: number;
  trend: string;
  lastComputed: number;
}

export interface SessionEngagementSignal {
  avgMessagesPerSession: number;
  avgDurationMs: number;
  trend: string;
  lastComputed: number;
}

export interface TopicSwitchSignal {
  switchRate: number;
  avgTopicDepth: number;
  totalSwitches: number;
  lastComputed: number;
}

export interface ResponseLengthSignal {
  avgLength: number;
  trend: string;
  lastComputed: number;
}

export interface BehavioralSignals {
  messageFrequency?: MessageFrequencySignal;
  sessionEngagement?: SessionEngagementSignal;
  topicSwitch?: TopicSwitchSignal;
  responseLength?: ResponseLengthSignal;
}

// ============ Helpers ============

/**
 * Compute an exponentially weighted moving average for irregular time series.
 *
 * weight = 1 - exp(-timeDelta / halfLife)
 * result = weight * currentValue + (1 - weight) * previousEMA
 *
 * When timeDelta is 0, weight is 0 and the result equals previousEMA.
 * When timeDelta >> halfLife, weight approaches 1 and the result approaches currentValue.
 */
export function updateEMA(
  currentValue: number,
  previousEMA: number,
  timeDeltaMs: number,
  halfLifeMs: number = DEFAULT_HALF_LIFE_MS,
): number {
  if (timeDeltaMs <= 0) {
    return previousEMA;
  }
  const weight = 1 - Math.exp(-timeDeltaMs / halfLifeMs);
  return weight * currentValue + (1 - weight) * previousEMA;
}

/**
 * Detect trend by splitting values in half and comparing averages.
 *
 * Returns 'stable' if fewer than 4 values.
 * Delta > 15% of first half average = 'increasing'.
 * Delta < -15% of first half average = 'decreasing'.
 * Otherwise 'stable'.
 */
export function detectTrend(values: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (values.length < 4) {
    return 'stable';
  }

  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((sum, v) => sum + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, v) => sum + v, 0) / secondHalf.length;

  // Avoid division by zero: if first half average is 0, compare absolute values
  if (firstAvg === 0) {
    if (secondAvg > 0) return 'increasing';
    if (secondAvg < 0) return 'decreasing';
    return 'stable';
  }

  const delta = (secondAvg - firstAvg) / Math.abs(firstAvg);

  if (delta > 0.15) return 'increasing';
  if (delta < -0.15) return 'decreasing';
  return 'stable';
}

// ============ Signal Extractors ============

/**
 * Compute message frequency signal from an array of timestamped messages.
 *
 * Groups messages into daily buckets, computes EMA-smoothed daily rate,
 * and detects trend via half-split comparison.
 *
 * Returns null if fewer than 10 messages (cold start protection).
 */
export function computeMessageFrequency(
  messages: { timestamp: number }[],
  _existing: MessageFrequencySignal | null,
): MessageFrequencySignal | null {
  if (messages.length < 10) {
    return null;
  }

  // Sort messages by timestamp ascending
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  // Group messages into daily buckets
  const dailyBuckets = new Map<number, number>();
  for (const msg of sorted) {
    const dayKey = Math.floor(msg.timestamp / DAY_MS);
    dailyBuckets.set(dayKey, (dailyBuckets.get(dayKey) || 0) + 1);
  }

  // Get sorted day keys to fill in gaps
  const dayKeys = Array.from(dailyBuckets.keys()).sort((a, b) => a - b);
  const minDay = dayKeys[0];
  const maxDay = dayKeys[dayKeys.length - 1];

  // Build array of daily counts including zero-days
  const dailyCounts: number[] = [];
  for (let day = minDay; day <= maxDay; day++) {
    dailyCounts.push(dailyBuckets.get(day) || 0);
  }

  // If all messages are in one day, dailyCounts has just one entry
  // EMA over daily counts
  let ema = dailyCounts[0];
  for (let i = 1; i < dailyCounts.length; i++) {
    ema = updateEMA(dailyCounts[i], ema, DAY_MS, DEFAULT_HALF_LIFE_MS);
  }

  const dailyRate = ema;
  const weeklyAvg = dailyRate * 7;
  const trend = detectTrend(dailyCounts);

  return {
    dailyRate,
    weeklyAvg,
    trend,
    lastComputed: Date.now(),
  };
}

/**
 * Compute session engagement signal from an array of session records.
 *
 * EMA-smooths average messages per session and session duration.
 * Detects trend from session durations.
 *
 * Returns null if fewer than 3 sessions (cold start protection).
 */
export function computeSessionEngagement(
  sessions: { messageCount: number; durationMs: number; startTime: number }[],
  _existing: SessionEngagementSignal | null,
): SessionEngagementSignal | null {
  if (sessions.length < 3) {
    return null;
  }

  // Sort sessions by startTime ascending
  const sorted = [...sessions].sort((a, b) => a.startTime - b.startTime);

  // EMA over message counts and durations
  let emaMsgCount = sorted[0].messageCount;
  let emaDuration = sorted[0].durationMs;
  const durations: number[] = [sorted[0].durationMs];

  for (let i = 1; i < sorted.length; i++) {
    const timeDelta = sorted[i].startTime - sorted[i - 1].startTime;
    emaMsgCount = updateEMA(sorted[i].messageCount, emaMsgCount, timeDelta, DEFAULT_HALF_LIFE_MS);
    emaDuration = updateEMA(sorted[i].durationMs, emaDuration, timeDelta, DEFAULT_HALF_LIFE_MS);
    durations.push(sorted[i].durationMs);
  }

  const trend = detectTrend(durations);

  return {
    avgMessagesPerSession: emaMsgCount,
    avgDurationMs: emaDuration,
    trend,
    lastComputed: Date.now(),
  };
}

/**
 * Compute topic switch rate from messages with optional embeddings.
 *
 * Filters to messages with embeddings, compares consecutive pairs via
 * cosine similarity. Similarity < 0.3 = topic switch.
 *
 * Returns null if fewer than 5 messages have embeddings (cold start protection).
 */
export function computeTopicSwitchRate(
  messages: { content: string; embedding?: number[] }[],
  _existing: TopicSwitchSignal | null,
): TopicSwitchSignal | null {
  // Filter to messages with embeddings
  const withEmbeddings = messages.filter(
    (m): m is { content: string; embedding: number[] } => m.embedding != null,
  );

  if (withEmbeddings.length < 5) {
    return null;
  }

  let totalSwitches = 0;
  let currentDepth = 1; // depth of current topic run
  const depths: number[] = [];

  for (let i = 1; i < withEmbeddings.length; i++) {
    const similarity = cosineSimilarity(withEmbeddings[i - 1].embedding, withEmbeddings[i].embedding);

    if (similarity < TOPIC_SWITCH_THRESHOLD) {
      // Topic switch detected
      totalSwitches++;
      depths.push(currentDepth);
      currentDepth = 1;
    } else {
      currentDepth++;
    }
  }
  // Push the final run depth
  depths.push(currentDepth);

  const transitions = withEmbeddings.length - 1;
  const switchRate = transitions > 0 ? totalSwitches / transitions : 0;
  const avgTopicDepth = depths.length > 0
    ? depths.reduce((sum, d) => sum + d, 0) / depths.length
    : 1;

  return {
    switchRate,
    avgTopicDepth,
    totalSwitches,
    lastComputed: Date.now(),
  };
}

/**
 * Compute response length evolution signal from timestamped content messages.
 *
 * EMA-smooths average message length over time, detects trend.
 *
 * Returns null if fewer than 10 messages (cold start protection).
 */
export function computeResponseLengthEvolution(
  messages: { content: string; timestamp: number }[],
  _existing: ResponseLengthSignal | null,
): ResponseLengthSignal | null {
  if (messages.length < 10) {
    return null;
  }

  // Sort by timestamp ascending
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  // EMA over message lengths
  const lengths: number[] = sorted.map((m) => m.content.length);
  let ema = lengths[0];

  for (let i = 1; i < sorted.length; i++) {
    const timeDelta = sorted[i].timestamp - sorted[i - 1].timestamp;
    ema = updateEMA(lengths[i], ema, timeDelta, DEFAULT_HALF_LIFE_MS);
  }

  const trend = detectTrend(lengths);

  return {
    avgLength: ema,
    trend,
    lastComputed: Date.now(),
  };
}
