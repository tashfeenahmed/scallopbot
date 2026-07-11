/**
 * Gap Signal Heuristics (Stage 1)
 *
 * Pure functions that scan existing data for explicitly unresolved threads,
 * stale goals, and stale board items. Returns typed GapSignal[]
 * for downstream LLM triage.
 *
 * No LLM calls — all heuristics are deterministic computation.
 */

import type { GoalItem, CheckinFrequency } from '../goals/types.js';
import type { BehavioralPatterns, SessionSummaryRow } from './db.js';

// ============ Types ============

export interface GapSignal {
  type: 'stale_goal' | 'behavioral_anomaly' | 'unresolved_thread' | 'stale_board_item' | 'blocked_item';
  severity: 'low' | 'medium' | 'high';
  description: string;
  context: Record<string, unknown>;
  sourceId: string;
}

/** Minimal board item info for gap scanning */
export interface BoardItemForScan {
  id: string;
  title: string;
  boardStatus: string;
  updatedAt: number;
  priority: string;
}

export interface GapScanInput {
  activeGoals: GoalItem[];
  behavioralSignals: BehavioralPatterns;
  sessionSummaries: SessionSummaryRow[];
  boardItems?: BoardItemForScan[];
  now?: number;
}

import {
  STALE_GOAL_DAYS,
  CHECKIN_RATIO_THRESHOLD,
  UNRESOLVED_MAX_AGE_DAYS,
  FOLLOW_UP_WINDOW_MS,
  STALE_IN_PROGRESS_HOURS,
  STALE_WAITING_HOURS,
} from '../proactive/proactive-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
    if (!metadata.dueDate && daysSinceUpdate > STALE_GOAL_DAYS) {
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
 * Passive usage changes are not permission to contact someone.
 *
 * Behavioral patterns remain useful for adapting response style and timing, but
 * fewer messages, shorter replies, or shorter sessions are ambiguous: the user
 * may simply be busy or finished. Turning those observations into outreach can
 * feel surveillant and creates a feedback loop where disengagement causes more
 * notifications. Keep this exported no-op for API compatibility while ensuring
 * the gap pipeline only acts on user-grounded commitments and tasks.
 */
export function scanBehavioralAnomalies(
  _signals: BehavioralPatterns,
  _now: number,
): GapSignal[] {
  return [];
}

// ============ scanUnresolvedThreads ============

type OpenLoopKind = 'follow_up' | 'pending' | 'commitment';

interface OpenLoopEvidence {
  kind: OpenLoopKind;
  text: string;
}

/**
 * Markers that describe a still-open action rather than merely a topic that was
 * discussed. These intentionally do not include a bare question mark: session
 * topics often preserve the user's original question even when it was answered.
 */
const OPEN_LOOP_PATTERNS: ReadonlyArray<{
  kind: OpenLoopKind;
  pattern: RegExp;
}> = [
  {
    kind: 'follow_up',
    pattern: /\b(?:user|they|we|assistant|bot|i)\s+(?:asked|requested|agreed|planned|plans?|intends?|wanted|wants?|needed|needs?|will|would|should|must)\b[^.!?\n]{0,100}\b(?:follow[\s-]?up|check[\s-]?(?:in|back)|circle back|revisit|return to|pick (?:this|it) up|continue (?:this|it)|remind)\b/i,
  },
  {
    kind: 'follow_up',
    pattern: /\b(?:follow[\s-]?up|check[\s-]?(?:in|back)|circle back|revisit|return to (?:this|it)|pick (?:this|it) up|reminder)\b[^.!?\n]{0,80}\b(?:needed|required|requested|planned|pending|due|later|tomorrow|next (?:day|week|time|session)|after|when)\b/i,
  },
  {
    kind: 'pending',
    pattern: /\b(?:pending|unresolved|unfinished|outstanding|awaiting|waiting for|blocked (?:by|on)|left (?:open|to do)|remains? (?:open|pending|unresolved|unfinished|to be)|not yet (?:done|resolved|completed|confirmed|decided|answered)|still (?:needs?|waiting|blocked|open|pending|unresolved|deciding|working))\b/i,
  },
  {
    kind: 'pending',
    pattern: /\b(?:open question|open loop|next steps? (?:is|are|remain|remains|include)|needs? (?:a |an )?(?:decision|confirmation|response|update|action)|action item(?:s)? (?:is|are|remain|remains|pending|open))\b/i,
  },
  {
    kind: 'commitment',
    pattern: /\b(?:user|they|we|assistant|bot|i)\s+(?:will|would|plans? to|intends? to|agreed to|promised to|needs? to|has to|must)\s+(?:follow[\s-]?up|check back|return|revisit|send|share|provide|confirm|decide|update|test|try|finish|complete|continue)\b/i,
  },
  {
    kind: 'commitment',
    pattern: /\b(?:come back to (?:this|it)|pick (?:this|it) up|continue (?:this|it))\s+(?:later|tomorrow|next (?:time|session|day|week))\b/i,
  },
];

/** Explicit statements that a superficially similar follow-up is not wanted. */
const NEGATED_OPEN_LOOP_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:no|not|never|without)\s+(?:further\s+)?(?:follow[\s-]?up|check[\s-]?in|reminder|action|response|decision|update)\s+(?:is\s+|was\s+)?(?:needed|required|pending)?\b/i,
  /\b(?:follow[\s-]?up|check[\s-]?in|reminder|action item)\s+(?:is|was|has been)?\s*(?:not needed|no longer needed|unnecessary|completed|done|resolved|cancelled|canceled)\b/i,
];

const RESOLUTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:task|issue|question|decision|follow[\s-]?up|work|deployment|problem|request)\s+(?:is|was|has been|had been)\s+(?:complete|completed|resolved|finished|done|answered|confirmed|decided|closed|settled|cancelled|canceled|fixed)\b/i,
  /\b(?:is|was|were|has been|had been)\s+(?:(?:now|then|already|successfully)\s+)?(?:completed|resolved|finished|done|answered|confirmed|decided|closed|settled|cancelled|canceled|fixed)\b/i,
  /\b(?:no (?:further )?(?:follow[\s-]?up|action|work|response|decision|reminder) (?:is |was )?(?:needed|required)|all (?:set|done)|nothing (?:else|further) (?:is )?(?:needed|required))\b/i,
];

const TOPIC_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'assistant', 'from', 'general', 'into',
  'session', 'that', 'their', 'there', 'these', 'they', 'this', 'topic', 'user',
  'were', 'what', 'when', 'where', 'which', 'with', 'would',
]);

function evidenceSegments(summary: SessionSummaryRow): string[] {
  return [
    ...summary.summary.split(/(?<=[.!?])\s+|[\n;]/),
    ...summary.topics,
  ]
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function findOpenLoopEvidence(summary: SessionSummaryRow): OpenLoopEvidence | null {
  for (const segment of evidenceSegments(summary)) {
    if (NEGATED_OPEN_LOOP_PATTERNS.some((pattern) => pattern.test(segment))) continue;

    for (const candidate of OPEN_LOOP_PATTERNS) {
      const openMatch = candidate.pattern.exec(segment);
      if (!openMatch) continue;

      // "Follow-up was pending, then completed" is a closed loop. A resolution
      // before the open marker can describe a different completed prerequisite,
      // so only a later resolution cancels this evidence.
      const laterResolution = RESOLUTION_PATTERNS.some((pattern) => {
        const resolutionMatch = pattern.exec(segment);
        return resolutionMatch !== null && resolutionMatch.index > openMatch.index;
      });
      if (laterResolution) continue;

      return { kind: candidate.kind, text: openMatch[0].trim() };
    }
  }

  return null;
}

function topicTokens(summary: SessionSummaryRow): Set<string> {
  const text = summary.topics.join(' ').toLowerCase();
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(tokens.filter((token) => !TOPIC_STOP_WORDS.has(token)));
}

function hasTopicOverlap(left: SessionSummaryRow, right: SessionSummaryRow): boolean {
  const leftTokens = topicTokens(left);
  if (leftTokens.size === 0) return false;
  return [...topicTokens(right)].some((token) => leftTokens.has(token));
}

function hasExplicitResolution(summary: SessionSummaryRow): boolean {
  return evidenceSegments(summary).some((segment) =>
    RESOLUTION_PATTERNS.some((pattern) => pattern.test(segment)),
  );
}

/**
 * Scan session summaries for unresolved threads:
 * - Requires explicit language describing a pending action, commitment, or
 *   requested follow-up in the generated summary/topics.
 * - A bare question or the absence of a later session is not evidence that the
 *   conversation remains unresolved.
 * - Waits for FOLLOW_UP_WINDOW_MS before surfacing the open loop.
 * - Suppresses a loop if a later, topically related summary explicitly says it
 *   was resolved.
 * - Only considers summaries within the last 7 days.
 */
export function scanUnresolvedThreads(
  summaries: SessionSummaryRow[],
  now: number,
): GapSignal[] {
  const results: GapSignal[] = [];

  // Sort summaries by createdAt for follow-up detection
  const sorted = [...summaries].sort((a, b) => a.createdAt - b.createdAt);

  for (const summary of sorted) {
    const ageMs = now - summary.createdAt;
    const ageDays = ageMs / DAY_MS;

    // Exclude future timestamps, fresh sessions, and stale historical context.
    if (ageMs < FOLLOW_UP_WINDOW_MS || ageDays > UNRESOLVED_MAX_AGE_DAYS) continue;

    const evidence = findOpenLoopEvidence(summary);
    if (!evidence) continue;

    const wasResolvedLater = sorted.some(
      (other) =>
        other.id !== summary.id &&
        other.createdAt > summary.createdAt &&
        hasTopicOverlap(summary, other) &&
        hasExplicitResolution(other),
    );
    if (wasResolvedLater) continue;

    const questionTopics = summary.topics.filter((t) => t.includes('?'));
    const severity = 'medium' as const;
    const topicBlurb = summary.topics.slice(0, 3).join(', ') || evidence.text.slice(0, 80);

    results.push({
      type: 'unresolved_thread',
      severity,
      description: `Explicit open loop from ${Math.floor(ageDays)} days ago: ${topicBlurb}`,
      context: {
        topics: summary.topics,
        questionTopics,
        openLoopKind: evidence.kind,
        openLoopEvidence: evidence.text,
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

// ============ scanStaleBoardItems ============

/**
 * Scan board items for stale/blocked signals:
 * - in_progress items not updated for 48h+
 * - waiting items older than 72h
 */
export function scanStaleBoardItems(items: BoardItemForScan[], now: number): GapSignal[] {
  const signals: GapSignal[] = [];

  for (const item of items) {
    const ageMs = now - item.updatedAt;
    const ageHours = ageMs / (60 * 60 * 1000);

    if (item.boardStatus === 'in_progress' && ageHours > STALE_IN_PROGRESS_HOURS) {
      signals.push({
        type: 'stale_board_item',
        severity: item.priority === 'urgent' || item.priority === 'high' ? 'high' : 'medium',
        description: `Task "${item.title}" has been in progress for ${Math.round(ageHours)}h without updates`,
        context: { boardStatus: item.boardStatus, ageHours: Math.round(ageHours), priority: item.priority },
        sourceId: item.id,
      });
    }

    if (item.boardStatus === 'waiting' && ageHours > STALE_WAITING_HOURS) {
      signals.push({
        type: 'blocked_item',
        severity: item.priority === 'urgent' ? 'high' : 'medium',
        description: `Task "${item.title}" has been blocked for ${Math.round(ageHours)}h`,
        context: { boardStatus: item.boardStatus, ageHours: Math.round(ageHours), priority: item.priority },
        sourceId: item.id,
      });
    }
  }

  return signals;
}

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
    ...(input.boardItems ? scanStaleBoardItems(input.boardItems, now) : []),
  ];
}
