/**
 * Unified Gap Pipeline (replaces gap-diagnosis + gap-actions)
 *
 * Single LLM call that receives gap signals + user context and outputs
 * ready-to-use scheduled items. Each output item specifies: skip, nudge
 * (with pre-written message), or task (with goal + tools).
 *
 * Code-level post-processing: dedup against existing items, enforce
 * daily budget cap, hard cap of 3 per tick.
 */

import type { GapSignal } from './gap-scanner.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';
import type { ScheduledItemKind, TaskConfig } from './db.js';
import { wordOverlap, DEDUP_OVERLAP_THRESHOLD } from '../utils/text-similarity.js';
import { extractResponseText } from '../proactive/proactive-utils.js';

// Re-export for backward compatibility
export { wordOverlap } from '../utils/text-similarity.js';

// ============ Types ============

/** An existing item for deduplication (message + optional context) */
export interface ExistingItemForDedup {
  message: string;
  context?: string | null;
}

/** A ready-to-schedule gap item output from the pipeline */
export interface GapScheduledItem {
  kind: ScheduledItemKind;
  message: string;
  context: string;
  taskConfig: TaskConfig | null;
  gapType: string;
  sourceId: string;
  severity: 'low' | 'medium' | 'high';
}

/** Input for the gap pipeline */
export interface GapPipelineInput {
  signals: GapSignal[];
  dial: 'conservative' | 'moderate' | 'eager';
  affect: SmoothedAffect | null;
  recentTopics: string[];
  existingItems: ExistingItemForDedup[];
  userId: string;
  now?: number;
  /** Number of agent-sourced items already created today (for daily budget enforcement) */
  todayItemCount?: number;
}

import { MAX_ITEMS_PER_EVAL, DIAL_BUDGETS } from '../proactive/proactive-config.js';

/** Per-dial budget caps (re-exported for backward compatibility) */
export const DIAL_THRESHOLDS: Record<
  'conservative' | 'moderate' | 'eager',
  { maxDailyNotifications: number }
> = {
  conservative: { maxDailyNotifications: DIAL_BUDGETS.conservative },
  moderate: { maxDailyNotifications: DIAL_BUDGETS.moderate },
  eager: { maxDailyNotifications: DIAL_BUDGETS.eager },
};

// ============ Helpers ============

/**
 * Extract sourceIds from an existing item's context JSON.
 */
function extractSourceIds(context: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!context) return ids;
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    if (typeof parsed.sourceId === 'string') {
      ids.add(parsed.sourceId);
    }
    if (Array.isArray(parsed.gapSourceIds)) {
      for (const id of parsed.gapSourceIds) {
        if (typeof id === 'string') ids.add(id);
      }
    }
  } catch {
    // Not valid JSON
  }
  return ids;
}

/**
 * Check if an item is a duplicate of any existing item.
 */
export function isDuplicate(
  message: string,
  sourceId: string,
  existingItems: ExistingItemForDedup[],
): boolean {
  for (const item of existingItems) {
    if (wordOverlap(message, item.message) >= DEDUP_OVERLAP_THRESHOLD) {
      return true;
    }
    const existingIds = extractSourceIds(item.context);
    if (existingIds.has(sourceId)) {
      return true;
    }
  }
  return false;
}

// ============ Prompt Builder ============

/**
 * Build a CompletionRequest for the unified gap pipeline.
 */
export function buildGapPipelinePrompt(
  signals: GapSignal[],
  dial: 'conservative' | 'moderate' | 'eager',
  affect: SmoothedAffect | null,
  recentTopics: string[],
): CompletionRequest {
  const mood = affect?.emotion ?? 'unknown';
  const topicsLine = recentTopics.length > 0
    ? `\nRecent topics the user has discussed: ${recentTopics.join(', ')}`
    : '';

  const dialGuidance: Record<string, string> = {
    conservative: 'Only act on clearly stale, overdue, or critical items. Skip anything uncertain.',
    moderate: 'Act on items that are meaningfully stale or unresolved. Skip low-severity or uncertain signals.',
    eager: 'Act on most signals unless they are clearly noise. Be proactive.',
  };

  const system = `You are a proactive personal assistant deciding which gap signals to act on.

For each signal, decide: skip it, send a nudge (pre-written message), or dispatch a task (background work).

Rules:
- Proactiveness dial: ${dial}. ${dialGuidance[dial]}
- When in doubt, skip. False silence is better than false alarm.
- User's current mood: ${mood}${topicsLine}
- Nudge: A short, friendly message delivered directly. Use for check-ins, reminders, encouragement.
- Task: Background research the bot does before messaging. Use when info lookup would help (flight status, weather, etc).
- Write nudge messages that feel natural and warm, like a helpful friend. 1-3 sentences max.
- For tasks, describe the goal clearly so a sub-agent can execute it.

Response format (JSON only, no other text):
{"items": [{"index": <signal index (1-based)>, "action": "skip" | "nudge" | "task", "message": "<pre-written message for nudge, or fallback message for task>", "goal": "<what to research/do — only for task>", "tools": ["optional tool names — only for task"]}]}`;

  const signalLines = signals.length > 0
    ? signals
        .map((s, i) => `${i + 1}. [${s.type}] (${s.severity}) ${s.description}`)
        .join('\n')
    : '(no signals)';

  const userMessage = `SIGNALS TO TRIAGE:\n\n${signalLines}\n\nAnalyze each signal and respond with JSON only:`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.3,
    maxTokens: 800,
  };
}

// ============ Response Parser ============

/**
 * Parse the LLM gap pipeline response into GapScheduledItems.
 * Returns empty array on parse failure (fail-safe).
 */
export function parseGapPipelineResponse(
  response: string,
  signals: GapSignal[],
): GapScheduledItem[] {
  if (!response || response.trim().length === 0) return [];

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (!Array.isArray(parsed.items)) return [];

    const results: GapScheduledItem[] = [];

    for (const entry of parsed.items as Array<Record<string, unknown>>) {
      const index = typeof entry.index === 'number' ? entry.index - 1 : -1; // 1-based to 0-based
      if (index < 0 || index >= signals.length) continue;

      const action = entry.action as string;
      if (action === 'skip') continue;

      const signal = signals[index];
      const message = typeof entry.message === 'string' ? entry.message : signal.description;

      if (action === 'task') {
        const goal = typeof entry.goal === 'string' ? entry.goal : message;
        const tools = Array.isArray(entry.tools)
          ? (entry.tools as string[]).filter(t => typeof t === 'string')
          : undefined;

        results.push({
          kind: 'task',
          message,
          context: JSON.stringify({ gapType: signal.type, sourceId: signal.sourceId }),
          taskConfig: { goal, tools },
          gapType: signal.type,
          sourceId: signal.sourceId,
          severity: signal.severity,
        });
      } else {
        // nudge (default for non-skip, non-task)
        results.push({
          kind: 'nudge',
          message,
          context: JSON.stringify({ gapType: signal.type, sourceId: signal.sourceId }),
          taskConfig: null,
          gapType: signal.type,
          sourceId: signal.sourceId,
          severity: signal.severity,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ============ Orchestrator ============

/**
 * Run the unified gap pipeline: signals → single LLM call → ready-to-schedule items.
 *
 * Post-processing (code-level, not LLM-controlled):
 * - Dedup against existing items (word overlap + sourceId)
 * - Enforce daily budget cap per dial setting
 * - Hard cap of 3 items per tick
 */
export async function runGapPipeline(
  input: GapPipelineInput,
  provider: LLMProvider,
): Promise<GapScheduledItem[]> {
  if (input.signals.length === 0) return [];

  try {
    const prompt = buildGapPipelinePrompt(
      input.signals,
      input.dial,
      input.affect,
      input.recentTopics,
    );

    const response = await provider.complete(prompt);
    const text = extractResponseText(response.content);
    const items = parseGapPipelineResponse(text, input.signals);

    // Code-level post-processing
    const budgetCap = DIAL_THRESHOLDS[input.dial].maxDailyNotifications;
    const remainingBudget = Math.max(0, budgetCap - (input.todayItemCount ?? 0));
    const effectiveCap = Math.min(remainingBudget, MAX_ITEMS_PER_EVAL);
    const filtered: GapScheduledItem[] = [];

    for (const item of items) {
      if (filtered.length >= effectiveCap) break;

      // Dedup against existing items
      if (isDuplicate(item.message, item.sourceId, input.existingItems)) continue;

      filtered.push(item);
    }

    return filtered;
  } catch {
    return [];
  }
}

