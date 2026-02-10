/**
 * LLM Gap Diagnosis (Stage 2)
 *
 * Takes GapSignal[] from Stage 1 heuristics and produces DiagnosedGap[]
 * via a single batched LLM triage call. The LLM adds human judgment to
 * raw signals — filtering noise, explaining gaps, and scoring confidence.
 *
 * Three exported functions:
 * - buildGapDiagnosisPrompt: pure prompt builder (testable without LLM)
 * - parseGapDiagnosis: pure JSON response parser (testable without LLM)
 * - diagnoseGaps: async orchestrator (calls provider.complete)
 *
 * Fail-safe invariant: all error paths produce not-actionable gaps.
 * No retry logic — single attempt, fail-safe to not-actionable.
 */

import type { GapSignal } from './gap-scanner.js';
import type { SmoothedAffect } from './affect-smoothing.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';

// ============ Types ============

/** A gap signal enriched with LLM diagnosis */
export interface DiagnosedGap {
  signal: GapSignal;
  diagnosis: string;
  actionable: boolean;
  suggestedAction: string;
  confidence: number;
}

/** Context about the user for LLM calibration */
export interface UserContext {
  affect: SmoothedAffect | null;
  dial: 'conservative' | 'moderate' | 'eager';
  recentTopics: string[];
}

// ============ Prompt Builder ============

/**
 * Build a CompletionRequest for gap diagnosis from signals and user context.
 *
 * System prompt contains:
 * - Role: proactive personal assistant analyzing signals
 * - Rule: "When in doubt, mark as NOT actionable"
 * - User's proactiveness dial
 * - User's current mood (emotion from affect or 'unknown')
 * - JSON-only response format instruction
 *
 * User message: numbered signal list with type, severity, description.
 *
 * @param signals - Gap signals from Stage 1 heuristics
 * @param userContext - User context for LLM calibration
 * @returns CompletionRequest ready for LLM call
 */
export function buildGapDiagnosisPrompt(
  signals: GapSignal[],
  userContext: UserContext,
): CompletionRequest {
  const mood = userContext.affect?.emotion ?? 'unknown';
  const topicsLine = userContext.recentTopics.length > 0
    ? `\nRecent topics the user has discussed: ${userContext.recentTopics.join(', ')}`
    : '';

  const system = `You are a proactive personal assistant analyzing gap signals detected in a user's data. Your job is to triage each signal: decide if it is actionable, provide a brief diagnosis, suggest an action, and rate your confidence.

Rules:
- When in doubt, mark as NOT actionable. False silence is better than false alarm.
- The user's proactiveness dial is set to: ${userContext.dial}
- The user's current mood is: ${mood}${topicsLine}
- Respond with JSON only. No additional text outside the JSON object.

Response format:
{"gaps": [{"index": <signal index>, "actionable": <boolean>, "confidence": <0-1>, "diagnosis": "<brief explanation>", "suggestedAction": "<what to do>"}]}`;

  const signalLines = signals.length > 0
    ? signals
        .map((s, i) => `${i + 1}. [${s.type}] (${s.severity}) ${s.description}`)
        .join('\n')
    : '(no signals)';

  const userMessage = `SIGNALS TO TRIAGE:\n\n${signalLines}\n\nAnalyze each signal and respond with JSON only:`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.2,
    maxTokens: 800,
  };
}

// ============ Response Parser ============

/**
 * Parse the LLM gap diagnosis response and map gaps back to source signals.
 *
 * Fail-safe behavior:
 * - Invalid JSON → all signals returned as not-actionable
 * - Missing fields → default: actionable=false, confidence=0
 * - Index out of range → skip that entry
 *
 * @param response - Raw LLM response text
 * @param signals - Original GapSignal[] for index mapping
 * @returns DiagnosedGap[] with each gap mapped to its source signal
 */
export function parseGapDiagnosis(
  response: string,
  signals: GapSignal[],
): DiagnosedGap[] {
  if (!response || response.trim().length === 0) {
    return failSafe(signals);
  }

  // Extract JSON from response (LLM may include surrounding text)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return failSafe(signals);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    if (!Array.isArray(parsed.gaps)) {
      return failSafe(signals);
    }

    const diagnosedGaps: DiagnosedGap[] = [];

    for (const entry of parsed.gaps as Array<Record<string, unknown>>) {
      const index = typeof entry.index === 'number' ? entry.index : -1;

      // Skip out-of-range indices
      if (index < 0 || index >= signals.length) continue;

      diagnosedGaps.push({
        signal: signals[index],
        actionable: typeof entry.actionable === 'boolean' ? entry.actionable : false,
        confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
        diagnosis: typeof entry.diagnosis === 'string' ? entry.diagnosis : '',
        suggestedAction: typeof entry.suggestedAction === 'string' ? entry.suggestedAction : '',
      });
    }

    return diagnosedGaps;
  } catch {
    return failSafe(signals);
  }
}

// ============ Internal Helpers ============

/**
 * Fail-safe: return all signals as not-actionable with confidence 0.
 * Used when JSON parsing fails or LLM call errors.
 */
function failSafe(signals: GapSignal[]): DiagnosedGap[] {
  return signals.map(signal => ({
    signal,
    diagnosis: '',
    actionable: false,
    suggestedAction: '',
    confidence: 0,
  }));
}

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
 * Diagnose gap signals via a single LLM triage call.
 *
 * Pipeline:
 * 1. If signals empty → return []
 * 2. Build prompt → call provider.complete() → extract text → parse
 * 3. On LLM error → fail-safe: all signals not-actionable, confidence 0
 *
 * No retry logic. Single attempt, fail-safe on error.
 *
 * @param signals - Gap signals from Stage 1 heuristics
 * @param userContext - User context for LLM calibration
 * @param provider - LLM provider for generating diagnosis
 * @returns DiagnosedGap[] with LLM-enriched triage results
 */
export async function diagnoseGaps(
  signals: GapSignal[],
  userContext: UserContext,
  provider: LLMProvider,
): Promise<DiagnosedGap[]> {
  if (signals.length === 0) return [];

  try {
    const prompt = buildGapDiagnosisPrompt(signals, userContext);
    const response = await provider.complete(prompt);
    const text = extractResponseText(response.content);
    return parseGapDiagnosis(text, signals);
  } catch {
    return failSafe(signals);
  }
}
