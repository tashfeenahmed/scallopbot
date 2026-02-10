/**
 * Proactiveness-Gated Gap Actions (Stage 3)
 *
 * Takes DiagnosedGap[] from Stage 2 and produces GapAction[] — ready-to-insert
 * scheduled items filtered by the user's proactiveness dial, severity thresholds,
 * deduplication against existing items, and daily budget caps.
 *
 * Prevents notification fatigue: conservative users see only critical gaps,
 * eager users see more. Hard cap of 3 actions per call regardless of dial.
 *
 * Pure function — no database imports, no side effects. Caller provides
 * existingItems for dedup and handles insertion.
 */

import type { DiagnosedGap } from './gap-diagnosis.js';

// ============ Types ============

/** A diagnosed gap paired with its ready-to-insert scheduled item */
export interface GapAction {
  gap: DiagnosedGap;
  scheduledItem: {
    userId: string;
    source: 'agent';
    type: 'follow_up';
    message: string;
    context: string;
    triggerAt: number;
  };
}

/** Per-dial configuration for filtering gap actions */
export interface DialConfig {
  minSeverity: 'low' | 'medium' | 'high';
  minConfidence: number;
  maxDailyNotifications: number;
  allowedTypes: string[];
}

/** Options for createGapActions */
export interface GapActionsOptions {
  now?: number;
}

// ============ Constants ============

/** Hard cap: max actions per call regardless of dial */
const MAX_ACTIONS_PER_TICK = 3;

/** Trigger delay: 30 minutes in milliseconds */
const TRIGGER_DELAY_MS = 30 * 60 * 1000;

/** Word overlap threshold for deduplication */
const DEDUP_OVERLAP_THRESHOLD = 0.8;

/** Severity ranking for comparison */
const SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Proactiveness dial thresholds */
export const DIAL_THRESHOLDS: Record<
  'conservative' | 'moderate' | 'eager',
  DialConfig
> = {
  conservative: {
    minSeverity: 'high',
    minConfidence: 0.7,
    maxDailyNotifications: 1,
    allowedTypes: ['approaching_deadline', 'stale_goal'],
  },
  moderate: {
    minSeverity: 'medium',
    minConfidence: 0.5,
    maxDailyNotifications: 3,
    allowedTypes: ['approaching_deadline', 'stale_goal', 'unresolved_thread'],
  },
  eager: {
    minSeverity: 'low',
    minConfidence: 0.3,
    maxDailyNotifications: 5,
    allowedTypes: [
      'approaching_deadline',
      'stale_goal',
      'unresolved_thread',
      'behavioral_anomaly',
    ],
  },
};

// ============ Helpers ============

/**
 * Compute word overlap ratio between two messages.
 * Splits both into word sets (lowercase, filter length > 2),
 * computes |intersection| / |smaller set|.
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersectionCount = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionCount++;
  }

  const smallerSize = Math.min(wordsA.size, wordsB.size);
  return intersectionCount / smallerSize;
}

/**
 * Check if a message is a duplicate of any existing item
 * based on word overlap >= threshold.
 */
function isDuplicate(
  message: string,
  existingItems: Array<{ message: string }>,
): boolean {
  for (const item of existingItems) {
    if (wordOverlap(message, item.message) >= DEDUP_OVERLAP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/**
 * Get numeric severity rank for comparison.
 */
function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}

// ============ Main Function ============

/**
 * Create proactiveness-gated gap actions from diagnosed gaps.
 *
 * Filtering pipeline:
 * 1. Not actionable -> skip
 * 2. Confidence below dial minConfidence -> skip
 * 3. Type not in dial allowedTypes -> skip
 * 4. Severity below dial minSeverity -> skip
 * 5. Word overlap >= 0.8 with existing item -> skip (dedup)
 * 6. Budget: stop after maxDailyNotifications reached
 * 7. Hard cap: max 3 actions per call regardless of dial
 *
 * @param diagnosed - DiagnosedGap[] from Stage 2 LLM triage
 * @param dial - Proactiveness dial setting
 * @param existingItems - Existing scheduled items for deduplication
 * @param options - Optional config (injectable `now` for testing)
 * @returns GapAction[] ready for insertion
 */
export function createGapActions(
  diagnosed: DiagnosedGap[],
  dial: 'conservative' | 'moderate' | 'eager',
  existingItems: Array<{ message: string }>,
  options?: GapActionsOptions,
): GapAction[] {
  const now = options?.now ?? Date.now();
  const config = DIAL_THRESHOLDS[dial];
  const actions: GapAction[] = [];

  const minSeverityRank = severityRank(config.minSeverity);
  const effectiveCap = Math.min(config.maxDailyNotifications, MAX_ACTIONS_PER_TICK);

  for (const gap of diagnosed) {
    // Budget + hard cap check
    if (actions.length >= effectiveCap) break;

    // Filter: not actionable
    if (!gap.actionable) continue;

    // Filter: confidence below threshold
    if (gap.confidence < config.minConfidence) continue;

    // Filter: type not in allowed types
    if (!config.allowedTypes.includes(gap.signal.type)) continue;

    // Filter: severity below minimum
    if (severityRank(gap.signal.severity) < minSeverityRank) continue;

    // Dedup: word overlap with existing items
    if (isDuplicate(gap.suggestedAction, existingItems)) continue;

    // Build action
    actions.push({
      gap,
      scheduledItem: {
        userId: gap.signal.sourceId,
        source: 'agent',
        type: 'follow_up',
        message: gap.suggestedAction,
        context: JSON.stringify({
          gapType: gap.signal.type,
          sourceId: gap.signal.sourceId,
        }),
        triggerAt: now + TRIGGER_DELAY_MS,
      },
    });
  }

  return actions;
}
