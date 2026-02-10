/**
 * Gap Signal Heuristics (Stage 1)
 *
 * Pure functions that scan existing data for unresolved threads,
 * stale goals, and behavioral anomalies. Returns typed GapSignal[]
 * for downstream LLM triage.
 *
 * No LLM calls — all heuristics are deterministic computation.
 */

import type { GoalItem } from '../goals/types.js';
import type { BehavioralPatterns, SessionSummaryRow } from './db.js';

// ============ Types ============

export interface GapSignal {
  type: 'stale_goal' | 'behavioral_anomaly' | 'unresolved_thread';
  severity: 'low' | 'medium' | 'high';
  description: string;
  context: Record<string, unknown>;
  sourceId: string;
}

export interface GapScanInput {
  activeGoals: GoalItem[];
  behavioralSignals: BehavioralPatterns;
  sessionSummaries: SessionSummaryRow[];
  now?: number;
}

// ============ Sub-scanners (stubs) ============

export function scanStaleGoals(_goals: GoalItem[], _now: number): GapSignal[] {
  return [];
}

export function scanBehavioralAnomalies(
  _signals: BehavioralPatterns,
  _now: number,
): GapSignal[] {
  return [];
}

export function scanUnresolvedThreads(
  _summaries: SessionSummaryRow[],
  _now: number,
): GapSignal[] {
  return [];
}

// ============ Orchestrator (stub) ============

export function scanForGaps(input: GapScanInput): GapSignal[] {
  const now = input.now ?? Date.now();
  return [
    ...scanStaleGoals(input.activeGoals, now),
    ...scanBehavioralAnomalies(input.behavioralSignals, now),
    ...scanUnresolvedThreads(input.sessionSummaries, now),
  ];
}
