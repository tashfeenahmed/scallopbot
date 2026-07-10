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
import { sanitizeProactiveMessage } from '../proactive/message-safety.js';
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
  /** Recent user-scoped transcript; it lets the evaluator avoid stale or already-resolved nudges. */
  recentChatContext?: string;
  /** Number of agent-sourced items created today */
  todayItemCount?: number;
  /** User-stated preferences relevant to proactiveness (e.g. "agent should check in frequently") */
  userPreferences?: string[];
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
  /** Error message when skipReason === 'llm_error' (for observability) */
  errorMessage?: string;
  /** Raw response length when the LLM replied but parsing yielded zero items */
  unparsedResponseLength?: number;
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

  // If the user has explicitly asked for proactive behavior, loosen the skip
  // guidance across all dials — otherwise the evaluator will reject every
  // low-severity signal and never generate any items, even when that's
  // exactly what the user wants.
  const prefsWantProactive = (input.userPreferences ?? []).some(p =>
    /\b(proactive|check in|remind|follow[- ]?up|ping me|nudge|initiate)\b/i.test(p)
  );

  const dialGuidance: Record<string, string> = prefsWantProactive
    ? {
        conservative: 'Act on clearly stale, overdue, or critical items. Also act on low-severity signals when the user has explicitly asked for more proactive check-ins (see STATED PREFERENCES below).',
        moderate: 'Act on items that are meaningfully stale or unresolved. Act on low-severity signals too when the user has asked for more proactive check-ins (see STATED PREFERENCES below).',
        eager: 'Act on most signals unless they are clearly noise. The user has explicitly asked for proactive behavior — err toward sending a nudge rather than staying silent.',
      }
    : {
        conservative: 'Only act on clearly stale, overdue, or critical items. Skip anything uncertain.',
        moderate: 'Act on items that are meaningfully stale or unresolved. For low-severity or uncertain signals, use judgment: act when there is a clear, specific way a brief nudge would genuinely help; otherwise skip. Do not blanket-skip every low-severity signal.',
        eager: 'Act on most signals unless they are clearly noise. Be proactive.',
      };

  const prefsBlock = (input.userPreferences ?? []).length > 0
    ? `\n\nSTATED PREFERENCES (the user has told the assistant these things — honor them):\n${(input.userPreferences ?? []).map(p => `- ${p}`).join('\n')}`
    : '';

  const system = `You are the background proactive reasoning agent for a personal assistant. Deliberate privately before deciding whether a follow-up would add genuine value.

Your working approach:
- Reconstruct the user's situation from the recent transcript, earlier conversation history, session summary, stated preferences, task board, and the candidate signals. Treat the newest direct conversation as the most current source of truth.
- Use older chats as context, not as isolated triggers. Reconcile them with what the user has said most recently, including outcomes, corrections, changed plans, and requests to stop or defer something.
- Consider the assistant's next helpful action internally. The user should receive a warm, self-contained message only when it is timely and useful; otherwise represent the decision as "skip".
- Proactiveness dial: ${input.dial}. ${dialGuidance[input.dial]}
- User's current mood: ${mood}
- A nudge is a natural, friendly 1-3 sentence message, as if casually texting a helpful friend.
- The "userFacingMessage" field is the final text addressed to the user. It must never describe the assistant's reasoning, plan, tools, or a task it needs to perform.
- Return JSON only. Keep all deliberation private.${prefsBlock}

Response format:
{"items": [{"index": <signal index, 1-based>, "action": "skip" | "nudge", "userFacingMessage": "<exact recipient-facing text for nudge>", "urgency": "low" | "medium" | "high"}]}

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

  if (input.recentChatContext) {
    parts.push(`RECENT CHAT TRANSCRIPT (most current; use it to avoid stale follow-ups):\n${input.recentChatContext}`);
  }

  const earlierSessions = input.allSessionSummaries
    .filter((summary) => summary.id !== input.sessionSummary?.id)
    .slice(0, 4);
  if (earlierSessions.length > 0) {
    const history = earlierSessions
      .map((summary, index) => `${index + 1}. Topics: ${summary.topics.join(', ') || 'general'}\n   Summary: ${summary.summary}`)
      .join('\n');
    parts.push(`EARLIER CONVERSATION HISTORY (context for the current decision):\n${history}`);
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
    // 1500, not 500: thinking-heavy models (qwen3.6, kimi-thinking) burn budget
    // on reasoning before emitting the JSON. At 500 the visible output came back
    // empty/truncated, every parse failed, and proactivity silently died.
    maxTokens: 1500,
  };
}

// ============ Response Parser ============

interface RawEvalItem {
  index?: number;
  action?: string;
  userFacingMessage?: string;
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
    // Deliberately reject legacy/free-form `message` output. The dedicated
    // field is a generation-time contract; regex filtering is defense-in-depth.
    const message = sanitizeProactiveMessage(
      typeof entry.userFacingMessage === 'string' ? entry.userFacingMessage : '',
    );
    if (!message) continue;
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

// ============ LLM call with retry ============

/**
 * Call the provider with one retry on a transient failure.
 *
 * The evaluator runs unattended (~every 72 min). A single network/timeout
 * blip used to mark the whole tick 'llm_error' and skip silently until the
 * next cycle. One retry with a short backoff absorbs transient provider
 * errors so a momentary blip doesn't cost a full proactive cycle. A genuine
 * outage still surfaces as 'llm_error' after the retries are exhausted.
 */
async function completeWithRetry(
  provider: LLMProvider,
  prompt: CompletionRequest,
  retries = 1,
  backoffMs = 1000,
): Promise<Awaited<ReturnType<LLMProvider['complete']>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await provider.complete(prompt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
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
    const response = await completeWithRetry(provider, prompt);
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
      // Distinguish "LLM said skip" from "we couldn't parse the reply" — the
      // latter looked identical in logs for weeks while proactivity was dead.
      ...(rawItems.length === 0 && extractJSON(text) === null
        ? { skipReason: 'parse_failed', unparsedResponseLength: text.length }
        : {}),
    };
  } catch (err) {
    return {
      items: [],
      signalsFound: allSignals.length,
      llmCalled: true,
      skipReason: 'llm_error',
      errorMessage: (err as Error).message,
    };
  }
}
