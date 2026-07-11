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
import { assessProactiveMessage } from '../proactive/message-quality.js';
import {
  PROACTIVE_COOLDOWN_MS,
  MAX_ITEMS_PER_EVAL,
  DIAL_BUDGETS,
} from '../proactive/proactive-config.js';
import { createHash } from 'node:crypto';

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
  /** Most recent no-action evaluation, used for durable change-driven caching. */
  priorEvaluation?: {
    signalFingerprint: string;
    at: number;
    reason?: string | null;
    outcome?: string;
  };
  /** Re-evaluate unchanged state after this interval (default: 7 days). */
  unchangedEvaluationWindowMs?: number;
  /** Durable provider-route health shared across restarts (normally ScallopDatabase). */
  circuitStore?: ProactiveCircuitStore;
  /** Total wall-clock budget for this unattended JSON call (default: 10s). */
  requestTimeoutMs?: number;
}

export interface ProactiveCircuitStore {
  getStructuredRouteCircuit(route: string): { nextRetryAt: number } | null;
  recordStructuredRouteFailure(route: string, errorCode: string, now?: number): unknown;
  clearStructuredRouteCircuit(route: string): void;
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
  /** Stable hash of the grounded state evaluated during this run. */
  signalFingerprint?: string;
}

const DEFAULT_UNCHANGED_EVALUATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export const PROACTIVE_EVALUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'action', 'userFacingMessage', 'urgency'],
        properties: {
          index: { type: 'integer' },
          action: { type: 'string', enum: ['skip', 'nudge'] },
          userFacingMessage: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
};
const RECENT_RESOLUTION_RE = /\b(?:already|now|just)?\s*(?:done|completed|finished|resolved|fixed|cancelled|canceled|closed|handled|sorted)\b|\bno (?:longer|more|further) (?:needed|required|relevant)\b/i;
const FINGERPRINT_STOP_WORDS = new Set([
  'about', 'after', 'already', 'been', 'from', 'have', 'item', 'recent',
  'still', 'task', 'that', 'this', 'user', 'with', 'without',
]);

function signalTopicTokens(signal: GapSignal): Set<string> {
  const topics = Array.isArray(signal.context.topics)
    ? signal.context.topics.filter((topic): topic is string => typeof topic === 'string').join(' ')
    : '';
  const text = `${topics} ${signal.description}`.toLowerCase();
  return new Set((text.match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    .filter(token => !FINGERPRINT_STOP_WORDS.has(token)));
}

const SENSITIVE_OPEN_LOOP_RE = /\b(?:health|medical|medication|doctor|therapy|diagnos|salary|bank|legal|pregnan|mental health)\b/i;

/**
 * A fresh direct statement such as "I still need to run the release test" is
 * stronger evidence than an LLM's willingness to send a follow-up. Realize
 * only when it overlaps a current deterministic gap signal; vague pronouns,
 * sensitive topics and unrelated chat remain model-gated or suppressed.
 */
function explicitRecentOpenLoop(
  signals: GapSignal[],
  recentChatContext?: string,
): GapScheduledItem | null {
  if (!recentChatContext) return null;
  const userLines = recentChatContext.split('\n')
    .filter(line => line.startsWith('User:'))
    .map(line => line.slice('User:'.length).trim())
    .reverse();
  for (const line of userLines) {
    const match = line.match(/\bI\s+(?:still\s+)?(?:need|have)\s+to\s+([^.!?\n]{3,160})/i);
    const action = match?.[1]?.trim().replace(/^(?:just\s+)?/, '').replace(/\s+/g, ' ');
    if (!action || /^(?:it|that|this|something|anything)$/i.test(action)
      || SENSITIVE_OPEN_LOOP_RE.test(action)) continue;
    const actionTokens = new Set((action.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
      .filter(token => !FINGERPRINT_STOP_WORDS.has(token)));
    const signal = signals.find(candidate => {
      const tokens = signalTopicTokens(candidate);
      return [...actionTokens].some(token => tokens.has(token));
    });
    if (!signal) continue;
    const message = `Did you get a chance to ${action.replace(/[.!?]+$/, '')}?`;
    if (!assessProactiveMessage(message).acceptable) continue;
    return {
      kind: 'nudge',
      message,
      context: JSON.stringify({
        gapType: signal.type,
        sourceId: signal.sourceId,
        sourceSessionId: typeof signal.context.sessionId === 'string'
          ? signal.context.sessionId
          : undefined,
        evidence: signal.description,
        urgency: signal.severity,
        source: 'explicit_recent_open_loop',
      }),
      taskConfig: null,
      gapType: signal.type,
      sourceId: signal.sourceId,
      severity: signal.severity,
    };
  }
  return null;
}

/** Suppress an old signal when a newer direct user message explicitly resolves its topic. */
export function recentChatResolvesSignal(signal: GapSignal, recentChatContext?: string): boolean {
  if (!recentChatContext) return false;
  const directUserLines = recentChatContext.split('\n')
    .filter(line => line.startsWith('User:'))
    .map(line => line.slice('User:'.length).trim());
  const relevantTokens = signalTopicTokens(signal);
  if (relevantTokens.size === 0) return false;
  return directUserLines.some(line => {
    if (!RECENT_RESOLUTION_RE.test(line)) return false;
    const lineTokens = new Set(line.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    return [...relevantTokens].some(token => lineTokens.has(token));
  });
}

/** Hash meaningful proactive state so unchanged skipped inputs do not call an LLM repeatedly. */
export function buildProactiveSignalFingerprint(input: ProactiveEvalInput, signals: GapSignal[]): string {
  const stableState = {
    signals: signals.map(signal => ({
      type: signal.type,
      severity: signal.severity,
      sourceId: signal.sourceId,
    })).sort((a, b) => `${a.type}:${a.sourceId}`.localeCompare(`${b.type}:${b.sourceId}`)),
    sessionSummary: input.sessionSummary
      ? { id: input.sessionSummary.id, createdAt: input.sessionSummary.createdAt, summary: input.sessionSummary.summary }
      : null,
    recentChatContext: input.recentChatContext ?? '',
    goals: input.activeGoals.map(goal => ({
      id: goal.id,
      status: goal.metadata.status,
      updatedAt: (goal as unknown as { updatedAt?: number }).updatedAt ?? goal.documentDate,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    board: input.boardItems.map(item => ({ id: item.id, status: item.status, boardStatus: item.boardStatus, updatedAt: item.updatedAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    preferences: [...(input.userPreferences ?? [])].sort(),
    affect: input.affect ? { emotion: input.affect.emotion, goalSignal: input.affect.goalSignal } : null,
  };
  return createHash('sha256').update(JSON.stringify(stableState)).digest('hex').slice(0, 24);
}

export type ProactivePreferencePolarity = 'positive' | 'negative';
export type ProactivePreferenceScope = 'global' | 'topic';

/** A deterministic interpretation of one user-stated proactive preference. */
export interface ProactivePreferenceRule {
  text: string;
  polarity: ProactivePreferencePolarity;
  scope: ProactivePreferenceScope;
  /** Topic or condition that limits the rule (for example, "medication" or "after 9pm"). */
  topic?: string;
  /** True only for an unqualified request to stop autonomous outreach altogether. */
  isGlobalOptOut: boolean;
}

/** Aggregate preference state. Negative rules deliberately win over positive ones. */
export interface ProactivePreferenceProfile {
  rules: ProactivePreferenceRule[];
  positive: ProactivePreferenceRule[];
  negative: ProactivePreferenceRule[];
  hasPositive: boolean;
  hasNegative: boolean;
  globalOptOut: boolean;
  /** Safe signal for dial elevation: at least one explicit opt-in and no negative rule. */
  shouldElevate: boolean;
}

const CORE_PROACTIVE_ACTION = String.raw`(?:proactive(?:ly|ness)?|check(?:ing)?[- ]?ins?|remind(?:er|ers|ed|ing|s)?|follow(?:ing|ed)?[- ]?ups?|ping(?:ed|ing|s)?\s+me|nudge(?:d|ing)?\s+me|nudges|prompt(?:ed|ing)?\s+me|notif(?:y|ies|ied)\s+me|notifications?|initiat(?:e|es|ed|ing)\s+(?:a\s+)?conversation|reach(?:ing|ed)?\s+out|(?:message|text|contact)(?:ed|ing|s)?\s+me\s+first)`;
const NEGATIVE_CONTACT_ACTION = String.raw`(?:${CORE_PROACTIVE_ACTION}|(?:message|text|contact)(?:ed|ing|s)?\s+me|unsolicited\s+(?:messages?|notifications?|texts?))`;

const CORE_PROACTIVE_ACTION_RE = new RegExp(`\\b${CORE_PROACTIVE_ACTION}\\b`, 'i');
const NEGATIVE_CONTACT_ACTION_RE = new RegExp(`\\b${NEGATIVE_CONTACT_ACTION}\\b`, 'i');
const NEGATIVE_DIRECTIVE_RE = new RegExp(
  String.raw`(?:\b(?:do\s+not|don't|never|stop|avoid|disable|turn\s+off|opt\s+out\s+of)\b.{0,80}\b${NEGATIVE_CONTACT_ACTION}\b|\b(?:no|not\s+any|not\s+more)\s+(?:more\s+)?${NEGATIVE_CONTACT_ACTION}\b|\b(?:prefer(?:s|red)?|ask(?:s|ed)?|want(?:s|ed)?)\b.{0,60}\bnot\s+to\b.{0,60}\b${NEGATIVE_CONTACT_ACTION}\b|\b(?:do\s+not|does\s+not|don't|doesn't)\s+want\b.{0,80}\b${NEGATIVE_CONTACT_ACTION}\b|\b${NEGATIVE_CONTACT_ACTION}\b.{0,50}\b(?:is|are|be)\s+(?:disabled|off|unwanted|not\s+wanted)\b|\b${CORE_PROACTIVE_ACTION}\b.{0,40}\b(?:less\s+often|not\s+so\s+often|too\s+(?:often|many|frequent))\b)`,
  'i',
);
const NEGATIVE_SENTIMENT_RE = new RegExp(
  String.raw`(?:\b(?:i\s+)?(?:hate|dislike|resent)\b.{0,60}\b${NEGATIVE_CONTACT_ACTION}\b|\b${NEGATIVE_CONTACT_ACTION}\b.{0,60}\b(?:annoy(?:s|ed|ing)?|irritat(?:es|ed|ing)|bother(?:s|ed|ing)?|stress(?:es|ed|ing)?\s+me\s+out|overwhelm(?:s|ed|ing)?|intrusive|unwelcome)\b)`,
  'i',
);
const POSITIVE_PREFERENCE_RE = new RegExp(
  // An action noun at the start of a note (for example, "Reminder: buy
  // milk") is content, not blanket consent. Positive classification therefore
  // requires a request, stated preference, permission, or an imperative that
  // explicitly names the recipient.
  String.raw`(?:^(?:please\s+)?be\s+(?:more\s+)?proactive(?:ly)?\b|^(?:more\s+)?(?:reminders?|check[- ]?ins?|nudges?)\s+please\s*[.!]?\s*$|^(?:please\s+)?(?:remind|ping|nudge|prompt|notify)\s+me\b|^(?:please\s+)?check[- ]?in\s+with\s+me\b|^(?:please\s+)?(?:message|text|contact)\s+me\s+first\b|\b(?:please|can\s+you|could\s+you|would\s+you|i(?:'d|\s+would)\s+like|i\s+want|user\s+(?:wants?|likes?|prefers?)|(?:i|user)\s+(?:like|prefer|appreciate)s?|ask(?:s|ed)?\s+(?:you|the\s+(?:assistant|agent|bot))?\s*to|(?:assistant|agent|bot)\s+should|enable|turn\s+on)\b.{0,100}\b${CORE_PROACTIVE_ACTION}\b|\b${CORE_PROACTIVE_ACTION}\b.{0,50}\b(?:welcome|welcomed|okay|ok|allowed|helpful|preferred)\b)`,
  'i',
);
const WAIT_FOR_USER_RE = /\b(?:only\s+(?:respond|reply|answer)\s+when\s+i\s+(?:message|ask|contact)|(?:wait\s+for\s+me\s+to|let\s+me)\s+(?:message|ask\s+you|reach\s+out|contact\s+you|start\s+(?:the\s+)?(?:conversation|chat))|(?:message|text|contact|check[- ]?in\s+with|reach\s+out\s+to)\s+me\s+only\s+(?:when|if)\s+i\s+(?:ask|request))\b/i;
const PROTECTED_POSITIVE_RE = /\b(?:do\s+not|don't)\s+(?:forget|fail)\s+to\s+(?:check[- ]?in|remind|follow[- ]?up|ping|nudge|prompt|notify|reach\s+out)\b/i;
const REDUCTION_RE = /\b(?:less|fewer|reduce|limit|not\s+so|too\s+(?:often|many|frequent)|not\s+every)\b/i;
const HARD_STOP_RE = /\b(?:do\s+not|don't|never|stop|disable|turn\s+off|opt\s+out|no\s+(?:more\s+)?|not\s+any|not\s+to|does\s+not\s+want|doesn't\s+want|do\s+not\s+want|don't\s+want)\b/i;

function normalizePreferenceText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTopicTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019]/g, "'")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Match a preference topic as whole normalized tokens rather than a raw
 * substring. This keeps short topics useful ("IT") without letting them match
 * unrelated words such as "waiting".
 */
export function proactiveTopicMatchesText(topic: string, text: string): boolean {
  const needle = normalizedTopicTokens(topic);
  const haystack = normalizedTopicTokens(text);
  if (needle.length === 0 || haystack.length < needle.length) return false;

  // Two-letter topics are usually acronyms. Preserve their case boundary so
  // an opt-out for "IT" does not match the pronoun "it" in an unrelated
  // sentence. Longer topics remain case-insensitive.
  if (needle.length === 1 && needle[0].length <= 2) {
    const rawTopic = topic.trim();
    if (rawTopic === rawTopic.toLocaleUpperCase('en-US')) {
      const rawTokens: string[] = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
      return rawTokens.includes(rawTopic);
    }
    return false;
  }

  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((token, index) => haystack[start + index] === token)) return true;
  }
  return false;
}

function cleanPreferenceTopic(topic: string): string | undefined {
  const cleaned = topic
    .replace(/^[\s:,-]+/, '')
    .replace(/[.!?;]+$/, '')
    .replace(/\s+(?:please|thanks|thank you)$/i, '')
    .trim();

  if (
    !cleaned ||
    (cleaned !== 'IT' && /^(?:me|it|this|that|the user|anything|everything|things?|stuff|in general)$/i.test(cleaned))
  ) {
    return undefined;
  }
  return cleaned.slice(0, 160);
}

function extractPreferenceTopic(text: string): string | undefined {
  const patterns = [
    /\b(?:about|regarding|concerning)\s+(.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
    /\bproactive(?:ly)?\s+(?:in|with|on)\s+(.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
    /\b(?:remind(?:ed|ing|s)?|nudge(?:d|s|ing)?|prompt(?:ed|s|ing)?|notif(?:y|ies|ied))\s+(?:me\s+)?(?:not\s+)?to\s+(.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
    /\breach(?:ing|ed)?\s+out\s+to\s+(.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
    /\b(?:reminders?|notifications?|check[- ]?ins?|nudges?|follow[- ]?ups?)\s+for\s+(.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
    /\b((?:after|before|during|between|at|every)\s+.+?)(?=\s+but\b|\s+except\b|[.;!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanPreferenceTopic(match[1]);
  }
  return undefined;
}

/**
 * Classify a single preference without an LLM. Mere mentions such as
 * "we discussed proactive messaging" are intentionally neutral.
 */
export function classifyProactivePreference(text: string): ProactivePreferenceRule | null {
  const normalized = normalizePreferenceText(text);
  if (!normalized) return null;

  const waitForUser = WAIT_FOR_USER_RE.test(normalized);
  const hasCoreAction = CORE_PROACTIVE_ACTION_RE.test(normalized);
  const hasNegativeContactAction = NEGATIVE_CONTACT_ACTION_RE.test(normalized);
  if (!waitForUser && !hasCoreAction && !hasNegativeContactAction) return null;

  // "Don't forget to remind me" is an opt-in, not a negation. Remove that
  // idiom before checking for any remaining negative directive.
  const protectedPositive = PROTECTED_POSITIVE_RE.test(normalized);
  const negativeCandidate = normalized.replace(
    new RegExp(PROTECTED_POSITIVE_RE.source, 'gi'),
    'requested proactive action',
  );
  const isNegative = waitForUser ||
    NEGATIVE_DIRECTIVE_RE.test(negativeCandidate) ||
    NEGATIVE_SENTIMENT_RE.test(negativeCandidate);
  const isPositive = !isNegative && (
    protectedPositive ||
    POSITIVE_PREFERENCE_RE.test(normalized)
  );

  if (!isNegative && !isPositive) return null;

  const topic = extractPreferenceTopic(normalized);
  const scope: ProactivePreferenceScope = topic ? 'topic' : 'global';
  const isGlobalOptOut = isNegative && scope === 'global' && !REDUCTION_RE.test(normalized) && (
    waitForUser || HARD_STOP_RE.test(normalized) || NEGATIVE_SENTIMENT_RE.test(normalized)
  );

  return {
    text: normalized,
    polarity: isNegative ? 'negative' : 'positive',
    scope,
    ...(topic ? { topic } : {}),
    isGlobalOptOut,
  };
}

/** Aggregate proactive preferences, with negative rules taking precedence. */
export function parseProactivePreferences(preferences: string[]): ProactivePreferenceProfile {
  const rules = preferences
    .map(classifyProactivePreference)
    .filter((rule): rule is ProactivePreferenceRule => rule !== null);
  const positive = rules.filter(rule => rule.polarity === 'positive');
  const negative = rules.filter(rule => rule.polarity === 'negative');

  return {
    rules,
    positive,
    negative,
    hasPositive: positive.length > 0,
    hasNegative: negative.length > 0,
    globalOptOut: negative.some(rule => rule.isGlobalOptOut),
    // A single negative or limiting preference prevents an automatic jump to
    // eager. A topic-only opt-in is honored by the evaluator prompt, but does
    // not grant broad permission to increase outreach on unrelated topics.
    shouldElevate: positive.some(rule => rule.scope === 'global') && negative.length === 0,
  };
}

export function resolveProactiveDial(
  storedDial: ProactiveEvalInput['dial'],
  profile: ProactivePreferenceProfile,
): ProactiveEvalInput['dial'] {
  if (profile.globalOptOut) return 'conservative';
  if (storedDial === 'eager' && profile.negative.some(rule => rule.scope === 'global')) {
    return 'moderate';
  }
  return profile.shouldElevate ? 'eager' : storedDial;
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

  // Explicit global opt-out is the strongest gate. Topic-specific boundaries
  // continue to the evaluator so unrelated, useful nudges can still be sent.
  if (parseProactivePreferences(input.userPreferences ?? []).globalOptOut) {
    return 'preference_opt_out';
  }

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
  const preferenceProfile = parseProactivePreferences(input.userPreferences ?? []);
  const prefsWantProactive = preferenceProfile.shouldElevate;

  const dialGuidance: Record<string, string> = prefsWantProactive
    ? {
        conservative: 'Act on clearly stale, overdue, or critical items. Also act on low-severity signals when the user has explicitly asked for more proactive check-ins (see STATED PREFERENCES below).',
        moderate: 'Act on items that are meaningfully stale or unresolved. Act on low-severity signals too when the user has asked for more proactive check-ins (see STATED PREFERENCES below).',
        eager: 'Act on useful, grounded signals, including lower-severity ones the user explicitly welcomed. Still skip weak, stale, generic, or already-resolved reasons.',
      }
    : {
        conservative: 'Only act on clearly stale, overdue, or critical items. Skip anything uncertain.',
        moderate: 'Act on items that are meaningfully stale or unresolved. For low-severity or uncertain signals, use judgment: act when there is a clear, specific way a brief nudge would genuinely help; otherwise skip. Do not blanket-skip every low-severity signal.',
        eager: 'Act on useful, grounded signals more readily, but skip weak, generic, stale, or already-resolved reasons.',
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
- Stated negative preferences override positive ones. Skip any signal covered by a topic-specific boundary; never reinterpret a request for fewer or no check-ins as permission to send more.
- User's current mood: ${mood}. Do not diagnose it, mention hidden behavioral telemetry, or invent concern.
- A nudge is a natural, respectful AI-assistant message: one concrete focus, normally 1-2 sentences, and at most one optional question.
- Do not imitate friendship or human feelings. Never say you missed the user, were worried, or noticed they were quiet/less active.
- Avoid canned openings such as "Hey", "just checking in", "wanted to check in", "hope you're well", and generic "how are things?" messages.
- Prefer a useful reminder/update/offer over asking the user to produce a recap. Avoid guilt, pressure, shame, or artificial urgency.
- Silence is correct unless there is a concrete, current reason to interrupt and a clear benefit now.
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
    temperature: 0.1,
    // This is a strict extraction/triage route, not an open-ended reasoning
    // turn. Disable hidden reasoning so the whole budget remains available for
    // the bounded JSON object.
    enableThinking: false,
    maxTokens: 1500,
    structuredOutput: {
      name: 'proactive_evaluation',
      schema: PROACTIVE_EVALUATION_SCHEMA,
      strict: true,
    },
    purpose: 'proactive_evaluation',
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
    if (!message || !assessProactiveMessage(message).acceptable) continue;
    const urgency = typeof entry.urgency === 'string' && validUrgencies.has(entry.urgency)
      ? entry.urgency
      : signal.severity;

    results.push({
      kind: 'nudge',
      message,
      context: JSON.stringify({
        gapType: signal.type,
        sourceId: signal.sourceId,
        sourceSessionId: typeof signal.context.sessionId === 'string' ? signal.context.sessionId : undefined,
        evidence: signal.description,
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

// ============ Bounded structured route ============

async function completeWithinDeadline(
  provider: LLMProvider,
  prompt: CompletionRequest,
  timeoutMs: number,
): Promise<Awaited<ReturnType<LLMProvider['complete']>>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.complete({ ...prompt, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error('proactive_evaluator_timeout'));
          reject(new Error('proactive_evaluator_timeout'));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function responseMatchesEvaluatorSchema(text: string): boolean {
  const parsed = extractJSON<{ items?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.items)) return false;
  return parsed.items.every(item => {
    if (!item || typeof item !== 'object') return false;
    const value = item as RawEvalItem;
    return Number.isInteger(value.index)
      && (value.action === 'skip' || value.action === 'nudge')
      && typeof value.userFacingMessage === 'string'
      && (value.urgency === 'low' || value.urgency === 'medium' || value.urgency === 'high');
  });
}

function proactiveRoute(provider: LLMProvider): string {
  return `proactive_evaluator:${provider.name}`;
}

function recordRouteFailure(
  store: ProactiveCircuitStore | undefined,
  route: string,
  errorCode: string,
  now: number,
): void {
  try {
    store?.recordStructuredRouteFailure(route, errorCode, now);
  } catch {
    // Observability persistence must never crash the gardener tick.
  }
}

function clearRouteFailure(store: ProactiveCircuitStore | undefined, route: string): void {
  try {
    store?.clearStructuredRouteCircuit(route);
  } catch {
    // The valid result is still safe to use; the next run may retry clearing.
  }
}

// ============ Orchestrator ============

/**
 * Run the unified proactive evaluation.
 *
 * Pipeline:
 * 1. Collect gap signals (deterministic heuristics)
 * 2. Enforce preference boundaries and pre-filters
 * 3. Single LLM call to triage grounded signals
 * 4. Dedup + budget enforcement
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

  const scannedSignals = scanForGaps({
    activeGoals: input.activeGoals,
    behavioralSignals: safeBehavioral,
    sessionSummaries: input.allSessionSummaries,
    boardItems: input.boardItems,
    now,
  });

  const preferenceProfile = parseProactivePreferences(input.userPreferences ?? []);
  const blockedTopics = preferenceProfile.negative
    .filter(rule => rule.scope === 'topic' && rule.topic)
    .map(rule => rule.topic!);
  const preferenceFilteredSignals = scannedSignals.filter(signal => {
    if (blockedTopics.length === 0) return true;
    const haystack = `${signal.description} ${JSON.stringify(signal.context)}`;
    return !blockedTopics.some(topic => proactiveTopicMatchesText(topic, haystack));
  });
  const allSignals = preferenceFilteredSignals.filter(
    signal => !recentChatResolvesSignal(signal, input.recentChatContext),
  );
  const signalFingerprint = buildProactiveSignalFingerprint(input, allSignals);

  // Nothing to evaluate
  if (allSignals.length === 0) {
    return {
      items: [], signalsFound: 0, llmCalled: false,
      skipReason: preferenceFilteredSignals.length > 0 ? 'resolved_in_recent_chat' : 'no_signals',
      signalFingerprint,
    };
  }

  const prior = input.priorEvaluation;
  const unchangedWindow = input.unchangedEvaluationWindowMs
    ?? DEFAULT_UNCHANGED_EVALUATION_WINDOW_MS;
  const priorCreated = prior?.outcome === 'created';
  const cacheablePriorReasons = new Set([
    'llm_skipped_all', 'unchanged_signals', 'unchanged_after_create',
  ]);
  if (
    prior
    && prior.signalFingerprint === signalFingerprint
    && (priorCreated || cacheablePriorReasons.has(prior.reason ?? ''))
    && now - prior.at >= 0
    && now - prior.at < unchangedWindow
  ) {
    return {
      items: [], signalsFound: allSignals.length, llmCalled: false,
      skipReason: priorCreated ? 'unchanged_after_create' : 'unchanged_signals',
      signalFingerprint,
    };
  }

  const explicitOpenLoop = explicitRecentOpenLoop(allSignals, input.recentChatContext);
  const availableBudget = Math.max(0, DIAL_BUDGETS[input.dial] - (input.todayItemCount ?? 0));
  if (
    explicitOpenLoop
    && availableBudget > 0
    && !isDuplicate(explicitOpenLoop.message, explicitOpenLoop.sourceId, input.existingItems)
  ) {
    return {
      items: [explicitOpenLoop],
      signalsFound: allSignals.length,
      llmCalled: false,
      signalFingerprint,
    };
  }

  const route = proactiveRoute(provider);
  try {
    if ((input.circuitStore?.getStructuredRouteCircuit(route)?.nextRetryAt ?? 0) > now) {
      return {
        items: [], signalsFound: allSignals.length, llmCalled: false,
        skipReason: 'provider_backoff', signalFingerprint,
      };
    }
  } catch {
    // Fall through to one bounded attempt if health persistence is unavailable.
  }

  // Single LLM call
  try {
    const prompt = buildEvaluatorPrompt(input, allSignals);
    const response = await completeWithinDeadline(
      provider,
      prompt,
      input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const text = extractResponseText(response.content);
    if (!responseMatchesEvaluatorSchema(text)) {
      recordRouteFailure(input.circuitStore, route, 'invalid_json', now);
      return {
        items: [],
        signalsFound: allSignals.length,
        llmCalled: true,
        skipReason: 'parse_failed',
        unparsedResponseLength: text.length,
        signalFingerprint,
      };
    }
    clearRouteFailure(input.circuitStore, route);
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
      signalFingerprint,
    };
  } catch (err) {
    const errorMessage = (err as Error).message;
    recordRouteFailure(
      input.circuitStore,
      route,
      errorMessage.includes('timeout') ? 'timeout' : 'provider_error',
      now,
    );
    return {
      items: [],
      signalsFound: allSignals.length,
      llmCalled: true,
      skipReason: 'llm_error',
      errorMessage,
      signalFingerprint,
    };
  }
}
