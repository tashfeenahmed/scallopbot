/**
 * Self-Reflection Module
 *
 * Generates composite reflections from session summaries and re-distills
 * SOUL.md behavioral guidelines. Two sequential LLM calls:
 *
 * 1. Composite reflection (Renze & Guven): explanation + principles +
 *    procedures + advice → JSON with insights[] and principles[]
 * 2. SOUL re-distillation (MARS + EvolveR hybrid): merge old SOUL with
 *    new learnings → raw markdown, 400-600 word target
 *
 * Pure function — no file I/O, no database access.
 * Follows the same patterns as dream.ts, nrem-consolidation.ts, and
 * rem-exploration.ts.
 */

import type { SessionSummaryRow } from './db.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';

// ============ Types ============

/** Configuration for the self-reflection cycle */
export interface ReflectionConfig {
  /** Minimum qualifying sessions to proceed (default: 1) */
  minSessions: number;
  /** Minimum messages per session to qualify (default: 3) */
  minMessagesPerSession: number;
  /** Maximum word count for SOUL output before truncation (default: 600) */
  maxSoulWords: number;
}

/** A single reflection insight extracted from session analysis */
export interface ReflectionInsight {
  /** Description of the insight */
  content: string;
  /** Topics associated with this insight */
  topics: string[];
  /** Session IDs that contributed to this insight (all qualifying sessions) */
  sourceSessionIds: string[];
}

/** Result of the self-reflection cycle */
export interface ReflectionResult {
  /** Whether reflection was skipped (insufficient data) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
  /** Extracted insights from session analysis */
  insights: ReflectionInsight[];
  /** Updated SOUL content, or null if skipped/failed */
  updatedSoul: string | null;
}

// ============ Config ============

/** Default reflection configuration */
export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  minSessions: 1,
  minMessagesPerSession: 3,
  maxSoulWords: 600,
};

// ============ Prompt Builders ============

/**
 * Build a CompletionRequest for composite reflection from session summaries.
 *
 * Follows the Composite reflection type (Renze & Guven):
 * - Explanation: what went well and poorly
 * - Principles: do's and don'ts extracted from patterns
 * - Procedures: step-by-step patterns observed
 * - Advice: actionable guidance for future interactions
 *
 * Requests JSON output: { "insights": [...], "principles": [...] }
 *
 * @param summaries - Filtered session summaries with sufficient depth
 * @returns CompletionRequest ready for LLM call
 */
export function buildReflectionPrompt(summaries: SessionSummaryRow[]): CompletionRequest {
  const system = `You are a self-reflection engine analyzing recent conversation sessions. Perform a composite reflection following these dimensions:

1. EXPLANATION: What went well in these conversations? What could be improved?
2. PRINCIPLES: Extract do's and don'ts — recurring patterns of what works and what doesn't.
3. PROCEDURES: Identify step-by-step patterns or workflows that emerged across sessions.
4. ADVICE: Provide actionable guidance for improving future interactions based on observed patterns.

Respond with JSON only:
{"insights": [{"content": "description of insight", "topics": ["relevant", "topics"]}], "principles": ["principle 1", "principle 2"]}

Rules:
- Each insight should be a concrete, actionable observation
- Topics should be short phrases (1-3 words each)
- Principles should be imperative statements (do X, avoid Y)
- Focus on patterns across sessions, not individual events`;

  const sessionLines = summaries
    .map((s, i) => {
      const topicList = s.topics.join(', ');
      return `Session ${i + 1} (${s.messageCount} messages, topics: ${topicList}):\n${s.summary}`;
    })
    .join('\n\n');

  const userMessage = `RECENT SESSIONS TO REFLECT ON:

${sessionLines}

Analyze these sessions and extract insights and principles (JSON only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.3,
    maxTokens: 1000,
  };
}

/**
 * Build a CompletionRequest for SOUL re-distillation.
 *
 * If currentSoul is null, instructs the LLM to create initial behavioral
 * guidelines from scratch. If currentSoul exists, instructs the LLM to
 * merge old guidelines with new learnings.
 *
 * Output is raw markdown (NOT JSON). Enforces 400-600 word target.
 *
 * @param currentSoul - Existing SOUL content, or null for initial creation
 * @param insights - Reflection insights from the first LLM call
 * @param principles - Extracted principles from the first LLM call
 * @returns CompletionRequest ready for LLM call
 */
export function buildSoulDistillationPrompt(
  currentSoul: string | null,
  insights: ReflectionInsight[],
  principles: string[],
): CompletionRequest {
  const system = `You are a behavioral guidelines distiller. Your task is to ${currentSoul ? 're-distill and update' : 'create initial'} behavioral guidelines (called SOUL) for an AI assistant based on reflection insights.

Rules:
- Output raw markdown (NOT JSON)
- Target length: 400-600 words
- Write as instructions to the assistant (second person: "you should...", "always...", "never...")
- Organize into clear sections with markdown headers
- Preserve existing guidelines that are still relevant (if updating)
- Integrate new insights and principles naturally
- Be specific and actionable, not vague
- Prioritize the most impactful guidelines`;

  const insightLines = insights.length > 0
    ? insights.map((ins, i) => `${i + 1}. ${ins.content} (topics: ${ins.topics.join(', ')})`).join('\n')
    : 'No specific insights extracted.';

  const principleLines = principles.length > 0
    ? principles.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : 'No specific principles extracted.';

  const soulSection = currentSoul
    ? `CURRENT SOUL GUIDELINES (to update and merge with new learnings):\n${currentSoul}\n\n`
    : 'No existing guidelines — create initial SOUL from scratch.\n\n';

  const userMessage = `${soulSection}NEW INSIGHTS FROM RECENT SESSIONS:
${insightLines}

EXTRACTED PRINCIPLES:
${principleLines}

${currentSoul ? 'Re-distill the SOUL guidelines, merging existing content with new learnings.' : 'Create initial SOUL guidelines based on these insights and principles.'} Output raw markdown (400-600 words):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.4,
    maxTokens: 1500,
  };
}

// ============ Internal Helpers ============

/**
 * Parse the reflection LLM response to extract insights and principles.
 * Returns null if JSON parsing fails.
 */
function parseReflectionResponse(responseText: string): {
  insights: Array<{ content: string; topics: string[] }>;
  principles: string[];
} | null {
  if (!responseText || responseText.trim().length === 0) {
    return null;
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const insights = Array.isArray(parsed.insights)
      ? (parsed.insights as Array<Record<string, unknown>>)
          .filter(i => typeof i.content === 'string')
          .map(i => ({
            content: i.content as string,
            topics: Array.isArray(i.topics) ? (i.topics as string[]) : [],
          }))
      : [];

    const principles = Array.isArray(parsed.principles)
      ? (parsed.principles as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];

    if (insights.length === 0 && principles.length === 0) {
      return null;
    }

    return { insights, principles };
  } catch {
    return null;
  }
}

/**
 * Truncate text to a maximum word count, splitting at the last complete
 * sentence boundary within the limit.
 *
 * A sentence boundary is defined as a period, exclamation mark, or question
 * mark followed by a space or end of string.
 */
function truncateToWordLimit(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) {
    return text;
  }

  // Take maxWords words and join them
  const truncated = words.slice(0, maxWords).join(' ');

  // Find the last sentence boundary (., !, ?)
  const sentenceEndMatch = truncated.match(/^([\s\S]*[.!?])/);
  if (sentenceEndMatch) {
    return sentenceEndMatch[1].trim();
  }

  // No sentence boundary found — return truncated as-is with a period
  return truncated.trim() + '.';
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

// ============ Main Function ============

/**
 * Run self-reflection on session summaries and optionally re-distill SOUL.
 *
 * Pure async function. No DB access, no file I/O. Caller provides
 * session summaries, current SOUL content, and LLM provider.
 *
 * Pipeline:
 * 1. Filter summaries by minMessagesPerSession
 * 2. If insufficient qualifying sessions, return skipped
 * 3. LLM call 1: Composite reflection → insights + principles
 * 4. If JSON parse fails, create fallback raw insight from response text
 * 5. LLM call 2: SOUL re-distillation → raw markdown
 * 6. If SOUL response empty/malformed, set updatedSoul to null
 * 7. If SOUL word count > maxSoulWords, truncate at sentence boundary
 * 8. Attach sourceSessionIds to each insight
 *
 * @param summaries - Session summaries to reflect on
 * @param currentSoul - Current SOUL content, or null for initial creation
 * @param provider - LLM provider for generating reflections
 * @param config - Optional partial config overrides
 * @returns ReflectionResult with insights and optional updated SOUL
 */
export async function reflect(
  summaries: SessionSummaryRow[],
  currentSoul: string | null,
  provider: LLMProvider,
  config?: Partial<ReflectionConfig>,
): Promise<ReflectionResult> {
  const cfg = { ...DEFAULT_REFLECTION_CONFIG, ...config };

  // Step 1: Filter summaries by minMessagesPerSession
  const qualifying = summaries.filter(s => s.messageCount >= cfg.minMessagesPerSession);

  // Step 2: Check if we have enough qualifying sessions
  if (summaries.length === 0) {
    return {
      skipped: true,
      skipReason: 'No qualifying sessions',
      insights: [],
      updatedSoul: null,
    };
  }

  if (qualifying.length < cfg.minSessions) {
    return {
      skipped: true,
      skipReason: 'No sessions with sufficient depth',
      insights: [],
      updatedSoul: null,
    };
  }

  // Collect qualifying session IDs for insight attribution
  const qualifyingSessionIds = qualifying.map(s => s.sessionId);

  // Step 3: LLM call 1 — Composite reflection
  const reflectionRequest = buildReflectionPrompt(qualifying);
  const reflectionResponse = await provider.complete(reflectionRequest);
  const reflectionText = extractResponseText(reflectionResponse.content);

  // Step 4: Parse reflection response (with fallback)
  let insights: ReflectionInsight[];
  let principles: string[];

  const parsed = parseReflectionResponse(reflectionText);
  if (parsed) {
    insights = parsed.insights.map(i => ({
      content: i.content,
      topics: i.topics,
      sourceSessionIds: qualifyingSessionIds,
    }));
    principles = parsed.principles;
  } else {
    // Fallback: create single raw insight from response text
    insights = [{
      content: reflectionText,
      topics: [],
      sourceSessionIds: qualifyingSessionIds,
    }];
    principles = [];
  }

  // Step 5: LLM call 2 — SOUL re-distillation
  const soulRequest = buildSoulDistillationPrompt(currentSoul, insights, principles);
  const soulResponse = await provider.complete(soulRequest);
  const soulText = extractResponseText(soulResponse.content);

  // Step 6: Validate SOUL response
  let updatedSoul: string | null;
  if (!soulText || soulText.trim().length === 0) {
    updatedSoul = null;
  } else {
    // Step 7: Truncate if exceeds maxSoulWords
    updatedSoul = truncateToWordLimit(soulText.trim(), cfg.maxSoulWords);
  }

  return {
    skipped: false,
    insights,
    updatedSoul,
  };
}
