/**
 * Unified Proactive Evaluator
 *
 * Merges the inner-thoughts (B7) and gap-scanner (C3) pipelines into
 * a single evaluation that runs during the deep tick (~72 min).
 *
 * Pipeline:
 * 1. Collect signals: session context + system gaps (deterministic, no LLM)
 * 2. Pre-filter: cooldown, distress, budget, signal quality (no LLM)
 * 3. One LLM call: triage all signals into skip/nudge decisions
 * 4. Dedup + schedule via timing model
 *
 * This replaces the previous two-path approach where inner-thoughts
 * evaluated session context (deep tick) and gap-scanner scanned system
 * state (sleep tick) — they couldn't see each other's context.
 */

import type { SessionSummaryRow, BehavioralPatterns } from './db.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';
import type { GapSignal, BoardItemForScan } from './gap-scanner.js';
import { scanForGaps } from './gap-scanner.js';
import { safeBehavioralPatterns } from './gardener-context.js';
import { isDuplicate, type ExistingItemForDedup, type GapScheduledItem } from './gap-pipeline.js';
import { extractResponseText, extractJSON } from '../proactive/proactive-utils.js';
import {
  PROACTIVE_COOLDOWN_MS,
  MIN_SESSION_MESSAGES,
  MAX_ITEMS_PER_EVAL,
  DIAL_BUDGETS,
} from '../proactive/proactive-config.js';

// ============ Types ============

export interface ProactiveEvalInput {
  /** Most recent session summary (if any within 6h) */
  sessionSummary: SessionSummaryRow | null;
  /** Behavioral patterns for the user */
  behavioralPatterns: BehavioralPatterns | null;
  /** Active goals for gap scanning */
  activeGoals: import('../goals/types.js').GoalItem[];
  /** Board items for stale/blocked detection */
  boardItems: BoardItemForScan[];
  /** All session summaries for thread scanning */
  allSessionSummaries: SessionSummaryRow[];
  /** Existing scheduled items for dedup */
  existingItems: ExistingItemForDedup[];
  /** Proactiveness dial */
  dial: 'conservative' | 'moderate' | 'eager';
  /** Smoothed affect */
  affect: SmoothedAffect | null;
  /** Last proactive timestamp */
  lastProactiveAt: number | null;
  /** Active hours */
  activeHours: number[];
  /** User ID */
  userId: string;
  /** Board summary for LLM context */
  boardSummary?: string;
  /** Number of agent-sourced items created today */
  todayItemCount?: number;
  /** Injectable now for testing */
  now?: number;
}

export interface ProactiveEvalResult {
  /** Items to schedule */
  items: GapScheduledItem[];
  /** Signals found (for logging) */
  signalsFound: number;
  /** Whether LLM was called */
  llmCalled: boolean;
  /** Skip reason if pre-filter rejected */
  skipReason?: string;
}

// ============ Pre-filter ============

/**
 * Pre-filter: determine if proactive evaluation should run.
 * Pure logic, no LLM call.
 *
 * Returns null if evaluation should proceed, or a skip reason string.
 */
export function shouldEvaluate(
  input: ProactiveEvalInput,
  now?: number,
): string | null {
  const currentTime = now ?? input.now ?? Date.now();

  // Cooldown: don't proact if last proactive was within 6 hours
  if (
    input.lastProactiveAt !== null &&
    currentTime - input.lastProactiveAt < PROACTIVE_COOLDOWN_MS
  ) {
    return 'cooldown';
  }

  // Distress suppression: never proact when user is distressed
  if (input.affect?.goalSignal === 'user_distressed') {
    return 'distress';
  }

  // Budget check: if we've already hit the daily budget, skip
  const budgetCap = DIAL_BUDGETS[input.dial];
  const remaining = Math.max(0, budgetCap - (input.todayItemCount ?? 0));
  if (remaining <= 0) {
    return 'budget_exhausted';
  }

  return null; // proceed
}

// ============ Prompt Builder ============

/**
 * Build a CompletionRequest for unified proactive evaluation.
 * Combines session context + gap signals into a single prompt.
 */
export function buildEvaluatorPrompt(
  input: ProactiveEvalInput,
  gapSignals: GapSignal[],
): CompletionRequest {
  const mood = input.affect?.emotion ?? 'unknown';

  const dialGuidance: Record<string, string> = {
    conservative: 'Only act on clearly stale, overdue, or critical items. Skip anything uncertain.',
    moderate: 'Act on items that are meaningfully stale or unresolved. Skip low-severity or uncertain signals.',
    eager: 'Act on most signals unless they are clearly noise. Be proactive.',
  };

  const system = `You are a proactive personal assistant deciding whether to send follow-up messages.

Rules:
- When in doubt, skip. False silence is better than false alarm.
- Proactiveness dial: ${input.dial}. ${dialGuidance[input.dial]}
- User's current mood: ${mood}
- Write nudge messages that feel natural and warm, like a helpful friend. 1-3 sentences max.
- Respond with JSON only. No additional text outside the JSON object.

Response format:
{"items": [{"index": <signal index, 1-based>, "action": "skip" | "nudge", "message": "<message for nudge>", "urgency": "low" | "medium" | "high"}]}

If no signals warrant action, return: {"items": []}`;

  const parts: string[] = [];

  // Session context
  if (input.sessionSummary) {
    const s = input.sessionSummary;
    parts.push(`SESSION CONTEXT (most recent):
Topics: ${s.topics.join(', ')}
Messages: ${s.messageCount}
Duration: ${Math.round(s.durationMs / 60_000)}min
Summary: ${s.summary}`);
  }

  // Gap signals
  if (gapSignals.length > 0) {
    const signalLines = gapSignals
      .map((s, i) => `${i + 1}. [${s.type}] (${s.severity}) ${s.description}`)
      .join('\n');
    parts.push(`SIGNALS TO EVALUATE:\n${signalLines}`);
  }

  // Board summary
  if (input.boardSummary) {
    parts.push(`TASK BOARD:\n${input.boardSummary}`);
  }

  const userMessage = parts.length > 0
    ? parts.join('\n\n') + '\n\nEvaluate each signal and respond with JSON only:'
    : 'No signals or session context. Return {"items": []}';

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.2,
    maxTokens: 500,
  };
}

// ============ Response Parser ============

interface RawEvalItem {
  index?: number;
  action?: string;
  message?: string;
  urgency?: string;
}

/**
 * Parse the unified evaluator LLM response into GapScheduledItems.
 * Returns empty array on parse failure (fail-safe).
 */
export function parseEvaluatorResponse(
  response: string,
  signals: GapSignal[],
): GapScheduledItem[] {
  const parsed = extractJSON<{ items?: RawEvalItem[] }>(response);
  if (!parsed || !Array.isArray(parsed.items)) return [];

  const results: GapScheduledItem[] = [];
  const validUrgencies = new Set(['low', 'medium', 'high']);

  for (const entry of parsed.items) {
    const index = typeof entry.index === 'number' ? entry.index - 1 : -1;
    if (index < 0 || index >= signals.length) continue;
    if (entry.action === 'skip' || entry.action !== 'nudge') continue;

    const signal = signals[index];
    const message = typeof entry.message === 'string' ? entry.message : signal.description;
    const urgency = typeof entry.urgency === 'string' && validUrgencies.has(entry.urgency)
      ? entry.urgency
      : signal.severity;

    results.push({
      kind: 'nudge',
      message,
      context: JSON.stringify({
        gapType: signal.type,
        sourceId: signal.sourceId,
        urgency,
        source: 'proactive_evaluator',
      }),
      taskConfig: null,
      gapType: signal.type,
      sourceId: signal.sourceId,
      severity: urgency as 'low' | 'medium' | 'high',
    });
  }

  return results;
}

// ============ Orchestrator ============

/**
 * Run the unified proactive evaluation.
 *
 * Pipeline:
 * 1. Collect gap signals (deterministic heuristics)
 * 2. Optionally include session context as a synthetic signal
 * 3. Pre-filter (cooldown, distress, budget)
 * 4. Single LLM call to triage all signals
 * 5. Dedup + budget enforcement
 */
export async function evaluateProactive(
  input: ProactiveEvalInput,
  provider: LLMProvider,
): Promise<ProactiveEvalResult> {
  const now = input.now ?? Date.now();

  // Pre-filter
  const skipReason = shouldEvaluate(input, now);
  if (skipReason) {
    return { items: [], signalsFound: 0, llmCalled: false, skipReason };
  }

  // Collect gap signals (deterministic, no LLM)
  const safeBehavioral = input.behavioralPatterns ?? safeBehavioralPatterns(input.userId);

  const gapSignals = scanForGaps({
    activeGoals: input.activeGoals,
    behavioralSignals: safeBehavioral,
    sessionSummaries: input.allSessionSummaries,
    boardItems: input.boardItems,
    now,
  });

  // If we have a recent session, add it as a synthetic signal
  // so the LLM can consider session follow-up alongside system gaps
  const allSignals = [...gapSignals];
  if (input.sessionSummary && input.sessionSummary.messageCount >= MIN_SESSION_MESSAGES) {
    allSignals.push({
      type: 'unresolved_thread' as const,
      severity: 'low',
      description: `Recent session ended: "${input.sessionSummary.topics.join(', ')}" (${input.sessionSummary.messageCount} messages, ${Math.round(input.sessionSummary.durationMs / 60_000)}min). Consider if follow-up would be helpful.`,
      context: {
        sessionId: input.sessionSummary.sessionId,
        topics: input.sessionSummary.topics,
        summary: input.sessionSummary.summary,
      },
      sourceId: input.sessionSummary.id,
    });
  }

  // Nothing to evaluate
  if (allSignals.length === 0) {
    // For non-conservative dials, still check if session warrants follow-up
    if (input.dial === 'conservative' || !input.sessionSummary) {
      return { items: [], signalsFound: 0, llmCalled: false, skipReason: 'no_signals' };
    }
  }

  // Single LLM call
  try {
    const prompt = buildEvaluatorPrompt(input, allSignals);
    const response = await provider.complete(prompt);
    const text = extractResponseText(response.content);
    const rawItems = parseEvaluatorResponse(text, allSignals);

    // Budget enforcement
    const budgetCap = DIAL_BUDGETS[input.dial];
    const remaining = Math.max(0, budgetCap - (input.todayItemCount ?? 0));
    const effectiveCap = Math.min(remaining, MAX_ITEMS_PER_EVAL);

    // Dedup + cap
    const filtered: GapScheduledItem[] = [];
    for (const item of rawItems) {
      if (filtered.length >= effectiveCap) break;
      if (isDuplicate(item.message, item.sourceId, input.existingItems)) continue;
      filtered.push(item);
    }

    return {
      items: filtered,
      signalsFound: allSignals.length,
      llmCalled: true,
    };
  } catch {
    return { items: [], signalsFound: allSignals.length, llmCalled: true, skipReason: 'llm_error' };
  }
}
