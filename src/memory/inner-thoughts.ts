/**
 * Inner Thoughts Evaluation Module
 *
 * Post-session LLM check of whether proactive follow-up is warranted.
 * Evaluates session context, gap signals, and affect to decide
 * whether to proactively reach out, wait, or skip.
 *
 * Four exported functions:
 * - shouldRunInnerThoughts: pure pre-filter (no LLM)
 * - buildInnerThoughtsPrompt: pure prompt builder
 * - parseInnerThoughtsResponse: pure JSON response parser
 * - evaluateInnerThoughts: async orchestrator (calls provider.complete)
 *
 * Fail-safe invariant: all error paths produce skip decision.
 */

import type { SessionSummaryRow } from './db.js';
import type { GapSignal } from './gap-scanner.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';

// ============ Types ============

export interface InnerThoughtsInput {
  sessionSummary: SessionSummaryRow;
  recentGapSignals: GapSignal[];
  affect: SmoothedAffect | null;
  dial: 'conservative' | 'moderate' | 'eager';
  lastProactiveAt: number | null;
  activeHours: number[];
}

export interface InnerThoughtsResult {
  decision: 'proact' | 'wait' | 'skip';
  reason: string;
  message: string | undefined;
  urgency: 'low' | 'medium' | 'high';
}

// ============ Constants ============

/** 6-hour cooldown between proactive messages to prevent fatigue */
const PROACTIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Minimum session length to warrant inner thoughts evaluation */
const MIN_SESSION_MESSAGES = 3;

/** Valid decision values for LLM response validation */
const VALID_DECISIONS = new Set(['proact', 'wait', 'skip']);

/** Valid urgency values for LLM response validation */
const VALID_URGENCIES = new Set(['low', 'medium', 'high']);

// ============ Pre-filter ============

/**
 * Pre-filter: determine if inner thoughts evaluation should run.
 * Pure logic, no LLM call.
 *
 * Returns false if:
 * - lastProactiveAt within 6 hours of now (cooldown)
 * - affect?.goalSignal === 'user_distressed' (distress suppression)
 * - sessionSummary.messageCount < 3 (too short)
 *
 * Returns true if:
 * - recentGapSignals.length > 0 (signals exist)
 * - dial !== 'conservative' (moderate/eager with no signals)
 *
 * Returns false otherwise (conservative with no signals).
 */
export function shouldRunInnerThoughts(
  input: InnerThoughtsInput,
  now?: number,
): boolean {
  const currentTime = now ?? Date.now();

  // Cooldown: don't proact if last proactive was within 6 hours
  if (
    input.lastProactiveAt !== null &&
    currentTime - input.lastProactiveAt < PROACTIVE_COOLDOWN_MS
  ) {
    return false;
  }

  // Distress suppression: never proact when user is distressed
  if (input.affect?.goalSignal === 'user_distressed') {
    return false;
  }

  // Session too short: not enough context to evaluate
  if (input.sessionSummary.messageCount < MIN_SESSION_MESSAGES) {
    return false;
  }

  // Gap signals exist: worth evaluating
  if (input.recentGapSignals.length > 0) {
    return true;
  }

  // Non-conservative dial: evaluate even without signals
  if (input.dial !== 'conservative') {
    return true;
  }

  // Conservative with no signals: skip
  return false;
}

// ============ Prompt Builder ============

/**
 * Build a CompletionRequest for inner thoughts evaluation.
 *
 * System prompt contains:
 * - Role: proactive personal assistant evaluating follow-up
 * - User's proactiveness dial
 * - User's current mood (emotion from affect or 'unknown')
 * - "When in doubt, recommend skip" rule
 * - JSON response format instruction
 *
 * User message: session summary, gap signals, affect info.
 *
 * @param input - Inner thoughts input with session context
 * @returns CompletionRequest ready for LLM call
 */
export function buildInnerThoughtsPrompt(
  input: InnerThoughtsInput,
): CompletionRequest {
  const mood = input.affect?.emotion ?? 'unknown';

  const system = `You are a proactive personal assistant evaluating whether to send a follow-up message to the user after their session ended. Your job is to decide if proactive outreach is warranted based on the session context.

Rules:
- When in doubt, recommend skip. False silence > false alarm.
- The user's proactiveness dial is set to: ${input.dial}
- The user's current mood is: ${mood}
- Respond with JSON only. No additional text outside the JSON object.

Response format:
{"decision": "proact|wait|skip", "reason": "brief explanation", "message": "suggested message if proact", "urgency": "low|medium|high"}`;

  const signalLines = input.recentGapSignals.length > 0
    ? input.recentGapSignals
        .map((s, i) => `${i + 1}. [${s.type}] (${s.severity}) ${s.description}`)
        .join('\n')
    : 'None';

  const affectLine = input.affect
    ? `Emotion: ${input.affect.emotion}, Valence: ${input.affect.valence}, Arousal: ${input.affect.arousal}`
    : 'Affect: unknown';

  const userMessage = `SESSION SUMMARY:
Topics: ${input.sessionSummary.topics.join(', ')}
Messages: ${input.sessionSummary.messageCount}
Duration: ${Math.round(input.sessionSummary.durationMs / 60_000)}min
Summary: ${input.sessionSummary.summary}

GAP SIGNALS:
${signalLines}

AFFECT:
${affectLine}

Evaluate whether proactive follow-up is warranted and respond with JSON only:`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.2,
    maxTokens: 200,
  };
}

// ============ Response Parser ============

/**
 * Parse the LLM inner thoughts response and extract decision.
 *
 * Fail-safe behavior:
 * - Invalid JSON -> skip with reason
 * - Invalid decision value -> skip with reason
 * - Missing urgency -> defaults to 'low'
 *
 * @param response - Raw LLM response text
 * @returns InnerThoughtsResult with validated fields
 */
export function parseInnerThoughtsResponse(
  response: string,
): InnerThoughtsResult {
  const failSafe: InnerThoughtsResult = {
    decision: 'skip',
    reason: 'Failed to parse LLM response',
    message: undefined,
    urgency: 'low',
  };

  if (!response || response.trim().length === 0) {
    return failSafe;
  }

  // Extract JSON from response (LLM may include markdown wrapping)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return failSafe;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate decision
    const decision = parsed.decision;
    if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision)) {
      return {
        decision: 'skip',
        reason: `Invalid decision value: ${String(decision)}`,
        message: undefined,
        urgency: 'low',
      };
    }

    // Validate urgency (default to 'low' if missing or invalid)
    const urgency = typeof parsed.urgency === 'string' && VALID_URGENCIES.has(parsed.urgency)
      ? parsed.urgency as 'low' | 'medium' | 'high'
      : 'low';

    return {
      decision: decision as 'proact' | 'wait' | 'skip',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      urgency,
    };
  } catch {
    return failSafe;
  }
}

// ============ Internal Helpers ============

/**
 * Extract response text from LLM CompletionResponse content blocks.
 * Handles both ContentBlock[] and string responses.
 */
function extractResponseText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => 'text' in block ? block.text : '')
      .join('');
  }
  return String(content);
}

// ============ Orchestrator ============

/**
 * Evaluate inner thoughts via pre-filter + LLM call.
 *
 * Pipeline:
 * 1. shouldRunInnerThoughts -> if false, return skip with reason
 * 2. buildInnerThoughtsPrompt -> call provider.complete -> parse
 * 3. On LLM error -> fail-safe: skip with error reason
 *
 * No retry logic. Single attempt, fail-safe on error.
 *
 * @param input - Inner thoughts input with session context
 * @param provider - LLM provider for generating evaluation
 * @returns InnerThoughtsResult with decision and reasoning
 */
export async function evaluateInnerThoughts(
  input: InnerThoughtsInput,
  provider: LLMProvider,
): Promise<InnerThoughtsResult> {
  if (!shouldRunInnerThoughts(input)) {
    return {
      decision: 'skip',
      reason: 'Pre-filter rejected: evaluation not warranted',
      message: undefined,
      urgency: 'low',
    };
  }

  try {
    const prompt = buildInnerThoughtsPrompt(input);
    const response = await provider.complete(prompt);
    const text = extractResponseText(response.content);
    return parseInnerThoughtsResponse(text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: 'skip',
      reason: `LLM error: ${message}`,
      message: undefined,
      urgency: 'low',
    };
  }
}
