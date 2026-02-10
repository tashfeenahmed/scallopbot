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
import type { CheckinFrequency } from '../goals/types.js';

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

// ============ Constants ============

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 14;
const CHECKIN_RATIO_THRESHOLD = 3.0;
const UNRESOLVED_MAX_AGE_DAYS = 7;
const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h

/** Convert checkinFrequency to days */
const CHECKIN_FREQUENCY_DAYS: Record<CheckinFrequency, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

// ============ scanStaleGoals ============

/**
 * Scan active goals for staleness signals:
 * - No dueDate and not updated in 14+ days
 * - DueDate passed with status still 'active'
 * - Check-in frequency missed by ratio > 3.0
 *
 * Only scans goals with status 'active'.
 */
export function scanStaleGoals(goals: GoalItem[], now: number): GapSignal[] {
  const signals: GapSignal[] = [];

  for (const goal of goals) {
    const { metadata } = goal;

    // Only scan active goals
    if (metadata.status !== 'active') continue;

    const updatedAt = (goal as unknown as { updatedAt: number }).updatedAt ?? goal.documentDate;
    const daysSinceUpdate = (now - updatedAt) / DAY_MS;

    // Check 1: Overdue — dueDate passed and still active (HIGH severity)
    if (metadata.dueDate && metadata.dueDate < now) {
      signals.push({
        type: 'stale_goal',
        severity: 'high',
        description: `Goal "${goal.content}" is past its due date and still active`,
        context: {
          goalTitle: goal.content,
          dueDate: metadata.dueDate,
          daysPastDue: Math.floor((now - metadata.dueDate) / DAY_MS),
        },
        sourceId: goal.id,
      });
      continue; // overdue is the strongest signal, skip weaker checks
    }

    // Check 2: Missed check-in — ratio of days since update to checkin frequency > 3.0
    if (metadata.checkinFrequency) {
      const frequencyDays =
        CHECKIN_FREQUENCY_DAYS[metadata.checkinFrequency as CheckinFrequency];
      if (frequencyDays && daysSinceUpdate / frequencyDays > CHECKIN_RATIO_THRESHOLD) {
        signals.push({
          type: 'stale_goal',
          severity: 'medium',
          description: `Goal "${goal.content}" has missed its ${metadata.checkinFrequency} check-in (${Math.floor(daysSinceUpdate)} days since last update)`,
          context: {
            goalTitle: goal.content,
            checkinFrequency: metadata.checkinFrequency,
            daysSinceUpdate: Math.floor(daysSinceUpdate),
            ratio: daysSinceUpdate / frequencyDays,
          },
          sourceId: goal.id,
        });
        continue; // check-in signal is more specific than generic stale
      }
    }

    // Check 3: Generic stale — no dueDate and not updated in 14+ days
    if (!metadata.dueDate && daysSinceUpdate > STALE_THRESHOLD_DAYS) {
      signals.push({
        type: 'stale_goal',
        severity: 'medium',
        description: `Goal "${goal.content}" has not been updated in ${Math.floor(daysSinceUpdate)} days`,
        context: {
          goalTitle: goal.content,
          daysSinceUpdate: Math.floor(daysSinceUpdate),
        },
        sourceId: goal.id,
      });
    }
  }

  return signals;
}

// ============ scanBehavioralAnomalies ============

/**
 * Scan behavioral signals for anomalies:
 * - Message frequency drop (decreasing trend + dailyRate < weeklyAvg * 0.5)
 * - Session engagement drop (decreasing trend + avgMessagesPerSession < 3)
 * - Response length decline (decreasing trend)
 *
 * Returns empty array on cold start (null messageFrequency).
 */
export function scanBehavioralAnomalies(
  signals: BehavioralPatterns,
  _now: number,
): GapSignal[] {
  const results: GapSignal[] = [];

  // Cold start guard: if no message frequency data, skip all checks
  if (!signals.messageFrequency) return [];

  // Check 1: Message frequency drop
  const mf = signals.messageFrequency;
  if (mf.trend === 'decreasing' && mf.dailyRate < mf.weeklyAvg * 0.5) {
    results.push({
      type: 'behavioral_anomaly',
      severity: 'low',
      description: `Message frequency has dropped significantly (${mf.dailyRate.toFixed(1)}/day vs ${mf.weeklyAvg.toFixed(1)}/week avg)`,
      context: {
        dailyRate: mf.dailyRate,
        weeklyAvg: mf.weeklyAvg,
        trend: mf.trend,
      },
      sourceId: signals.userId,
    });
  }

  // Check 2: Session engagement drop
  const se = signals.sessionEngagement;
  if (se && se.trend === 'decreasing' && se.avgMessagesPerSession < 3) {
    results.push({
      type: 'behavioral_anomaly',
      severity: 'low',
      description: `Session engagement is declining (avg ${se.avgMessagesPerSession.toFixed(1)} messages per session)`,
      context: {
        avgMessagesPerSession: se.avgMessagesPerSession,
        avgDurationMs: se.avgDurationMs,
        trend: se.trend,
      },
      sourceId: signals.userId,
    });
  }

  // Check 3: Response length decline
  const rl = signals.responseLength;
  if (rl && rl.trend === 'decreasing') {
    results.push({
      type: 'behavioral_anomaly',
      severity: 'low',
      description: `Response length is trending shorter (avg ${rl.avgLength.toFixed(0)} chars)`,
      context: {
        avgLength: rl.avgLength,
        trend: rl.trend,
      },
      sourceId: signals.userId,
    });
  }

  return results;
}

// ============ scanUnresolvedThreads ============

/**
 * Scan session summaries for unresolved threads:
 * - Topics containing "?" with no follow-up session within 48h
 * - Only considers summaries within the last 7 days
 * - Skips summaries with messageCount < 3 AND age < 48h (too fresh/short)
 */
export function scanUnresolvedThreads(
  summaries: SessionSummaryRow[],
  now: number,
): GapSignal[] {
  const results: GapSignal[] = [];

  // Sort summaries by createdAt for follow-up detection
  const sorted = [...summaries].sort((a, b) => a.createdAt - b.createdAt);

  for (let i = 0; i < sorted.length; i++) {
    const summary = sorted[i];
    const ageMs = now - summary.createdAt;
    const ageDays = ageMs / DAY_MS;

    // Skip summaries older than 7 days
    if (ageDays > UNRESOLVED_MAX_AGE_DAYS) continue;

    // Skip too fresh/short summaries (messageCount < 3 AND age < 48h)
    if (summary.messageCount < 3 && ageMs < FOLLOW_UP_WINDOW_MS) continue;

    // Check if any topic contains a question mark
    const hasQuestion = summary.topics.some((t) => t.includes('?'));
    if (!hasQuestion) continue;

    // Check if there is a follow-up summary within 48h after this one
    const hasFollowUp = sorted.some(
      (other) =>
        other.id !== summary.id &&
        other.createdAt > summary.createdAt &&
        other.createdAt - summary.createdAt < FOLLOW_UP_WINDOW_MS,
    );
    if (hasFollowUp) continue;

    // Unresolved thread detected
    const questionTopics = summary.topics.filter((t) => t.includes('?'));
    results.push({
      type: 'unresolved_thread',
      severity: 'medium',
      description: `Unresolved question from ${Math.floor(ageDays)} days ago: ${questionTopics.join(', ')}`,
      context: {
        topics: summary.topics,
        questionTopics,
        messageCount: summary.messageCount,
        ageDays: Math.floor(ageDays),
        sessionId: summary.sessionId,
      },
      sourceId: summary.id,
    });
  }

  return results;
}

// ============ Orchestrator ============

/**
 * Orchestrator that calls all sub-scanners and concatenates results.
 * Returns GapSignal[] for downstream LLM triage.
 */
export function scanForGaps(input: GapScanInput): GapSignal[] {
  const now = input.now ?? Date.now();
  return [
    ...scanStaleGoals(input.activeGoals, now),
    ...scanBehavioralAnomalies(input.behavioralSignals, now),
    ...scanUnresolvedThreads(input.sessionSummaries, now),
  ];
}
