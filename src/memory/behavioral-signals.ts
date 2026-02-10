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

// ============ Helpers (stubs) ============

export function updateEMA(
  _currentValue: number,
  _previousEMA: number,
  _timeDeltaMs: number,
  _halfLifeMs?: number,
): number {
  throw new Error('Not implemented');
}

export function detectTrend(_values: number[]): 'increasing' | 'decreasing' | 'stable' {
  throw new Error('Not implemented');
}

// ============ Signal Extractors (stubs) ============

export function computeMessageFrequency(
  _messages: { timestamp: number }[],
  _existing: MessageFrequencySignal | null,
): MessageFrequencySignal | null {
  throw new Error('Not implemented');
}

export function computeSessionEngagement(
  _sessions: { messageCount: number; durationMs: number; startTime: number }[],
  _existing: SessionEngagementSignal | null,
): SessionEngagementSignal | null {
  throw new Error('Not implemented');
}

export function computeTopicSwitchRate(
  _messages: { content: string; embedding?: number[] }[],
  _existing: TopicSwitchSignal | null,
): TopicSwitchSignal | null {
  throw new Error('Not implemented');
}

export function computeResponseLengthEvolution(
  _messages: { content: string; timestamp: number }[],
  _existing: ResponseLengthSignal | null,
): ResponseLengthSignal | null {
  throw new Error('Not implemented');
}
