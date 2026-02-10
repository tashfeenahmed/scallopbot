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

// ============ Stubs (RED phase — all return wrong values) ============

export function shouldRunInnerThoughts(
  _input: InnerThoughtsInput,
  _now?: number,
): boolean {
  throw new Error('Not implemented'); // stub
}

export function buildInnerThoughtsPrompt(
  _input: InnerThoughtsInput,
): CompletionRequest {
  return {
    messages: [],
    temperature: 0,
    maxTokens: 0,
  }; // stub: wrong structure
}

export function parseInnerThoughtsResponse(
  _response: string,
): InnerThoughtsResult {
  return {
    decision: 'wait',
    reason: '',
    message: undefined,
    urgency: 'high',
  }; // stub: wrong values
}

export async function evaluateInnerThoughts(
  _input: InnerThoughtsInput,
  _provider: LLMProvider,
): Promise<InnerThoughtsResult> {
  return {
    decision: 'wait',
    reason: '',
    message: undefined,
    urgency: 'high',
  }; // stub: wrong values
}
