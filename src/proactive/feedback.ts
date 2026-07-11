/**
 * Proactive engagement attribution (feedback loop).
 *
 * A user message must contain evidence that it relates to a recently delivered
 * proactive message. Proximity alone is deliberately insufficient: otherwise
 * an unrelated "hello" sent a few minutes later teaches the trust model that
 * every recent nudge was useful.
 */

import type { ScheduledItem } from '../memory/db.js';
import { parseUserIdPrefix } from '../triggers/types.js';
import { ACKNOWLEDGEMENT_WINDOW_MS, ENGAGEMENT_WINDOW_MS } from './proactive-config.js';

export const DEFAULT_ENGAGEMENT_WINDOW_MS = ENGAGEMENT_WINDOW_MS;

const ACKNOWLEDGEMENT_RE = /^(?:(?:yes|yeah|yep|sure|okay|ok|got it|done|thanks|thank you|helpful|perfect|great|nice|will do|i did|i have|sorted|fixed)[!.\s]*)$/i;
const OUTREACH_ACTION = String.raw`(?:remind(?:er|ers|ed|ing|s)?|messag(?:e|es|ed|ing)|check(?:ing)?[- ]?in|notif(?:y|ies|ied|ication|ications)|contact(?:ed|ing|s)?|send(?:ing)?|ask(?:ing|ed|s)?|ping(?:ed|ing|s)?|nudge(?:d|s|ing)?|follow(?:ing|ed)?[- ]?up|reach(?:ing|ed)?\s+out)`;
const DISMISSAL_RE = new RegExp(
  String.raw`(?:^\s*(?:please\s+)?stop\s*[.!?]*\s*$|\b(?:stop|no\s+more|don['\u2019]?t|do\s+not)\b.{0,40}\b${OUTREACH_ACTION}\b|\b(?:not\s+now|leave\s+me\s+alone|irrelevant|wrong\s+person|unsubscribe)\b)`,
  'i',
);
const NEGATIVE_FEEDBACK_RE = /\b(?:why are you asking|i (?:already|just) (?:said|told) you|you (?:already )?(?:knew|know) that|that (?:reminder|message) (?:was|is) (?:wrong|irrelevant))\b/i;
const NEUTRAL_UNCERTAINTY_RE = /\b(?:i\s+(?:do\s+not|don['\u2019]?t)\s+know|i(?:['\u2019]m|\s+am)\s+not\s+sure|i\s+(?:have\s+not|haven['\u2019]?t)\s+decided|i(?:['\u2019]m|\s+am)\s+undecided)\b/i;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'from',
  'have', 'just', 'more', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'very', 'want', 'what', 'when', 'where', 'which',
  'with', 'would', 'your', 'youre', 'into', 'some', 'than', 'will', 'shall',
  'the', 'and', 'for', 'are', 'but', 'not', 'was', 'were', 'has', 'had', 'its',
]);

export interface ProactiveEngagementContext {
  /** The text the user just sent. Without text, no semantic attribution occurs. */
  userMessage?: string;
  /** True only when the channel knows this is a reply to a bot message. */
  directReply?: boolean;
  /** Text of the message being replied to, when the channel provides it. */
  repliedToText?: string;
  /** Exact channel-local ID of the message being replied to, when available. */
  repliedToMessageId?: string;
  /**
   * Whether a standalone direct-reply command may mutate the linked source.
   * Channels set this to false when the message also carries media: the reply
   * is still engagement evidence, but the caption is not standalone intent.
   */
  allowSourceAction?: boolean;
  /** Explicit aliases resolved by the deployment's identity layer. */
  identityCandidates?: string[];
}

export interface ProactiveEngagementMatch {
  itemId: string;
  score: number;
  reason: 'direct_reply' | 'acknowledgement' | 'topic_overlap' | 'negative';
  /** Trusted, tightly parsed action from a direct reply to this exact nudge. */
  replyAction?: ProactiveReplyAction;
}

export type ProactiveReplyAction =
  | { type: 'archive' }
  | { type: 'done' }
  | { type: 'snooze'; delayMs: number };

export interface ProactiveSourceActionOutcome {
  action: ProactiveReplyAction['type'];
  title: string;
  applied: boolean;
}

export interface ProactiveFeedbackResult {
  matched: boolean;
  sourceAction?: ProactiveSourceActionOutcome;
}

const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse only explicit, standalone board actions. This intentionally rejects
 * conversational mentions such as "the archive is done" so reply routing
 * cannot mutate a linked source item on an ambiguous sentence.
 */
export function parseProactiveReplyAction(message: string): ProactiveReplyAction | null {
  const normalized = message.trim().toLowerCase().replace(/[.!]+$/, '').trim();
  if (/^(?:archive|archive (?:it|this)|move (?:it|this) to archive)$/.test(normalized)) {
    return { type: 'archive' };
  }
  if (/^(?:done|mark (?:it|this) done|finished|completed)$/.test(normalized)) {
    return { type: 'done' };
  }
  if (/^(?:snooze|snooze (?:it|this)|remind me later)$/.test(normalized)) {
    return { type: 'snooze', delayMs: DEFAULT_SNOOZE_MS };
  }
  if (/^snooze (?:until )?tomorrow$/.test(normalized)) {
    return { type: 'snooze', delayMs: DEFAULT_SNOOZE_MS };
  }

  const timed = normalized.match(
    /^snooze(?: (?:it|this))? (?:for |by |in )?(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)$/,
  );
  if (!timed) return null;
  const amount = Number.parseInt(timed[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = timed[2];
  const unitMs = unit.startsWith('min')
    ? 60_000
    : unit.startsWith('h')
      ? 60 * 60_000
      : unit.startsWith('w')
        ? 7 * 24 * 60 * 60_000
        : 24 * 60 * 60_000;
  const delayMs = amount * unitMs;
  if (delayMs > MAX_SNOOZE_MS) return null;
  return { type: 'snooze', delayMs };
}

/**
 * Candidate DB identities for a channel-prefixed user ID.
 *
 * Smartbot currently stores cognitive facts under the single-user canonical
 * identity `default`, while delivery records can be stored as `api:default`,
 * `telegram:123`, or their raw ID. Looking up all aliases fixes the feedback
 * loop without weakening the DB query itself. Exact identity remains first.
 */
export function proactiveIdentityCandidates(
  userId: string,
  canonicalSingleUserIds: readonly string[] = [],
): string[] {
  const trimmed = userId.trim();
  if (!trimmed) return [];
  const { channel, rawUserId } = parseUserIdPrefix(trimmed);
  const candidates = [trimmed];
  if (channel && rawUserId !== trimmed) candidates.push(rawUserId);
  // `default` is safe only when the deployment explicitly maps this identity
  // to its single owner (or the channel itself supplied api:default). Never map
  // every chat-platform user to one canonical record in a public deployment.
  const canonical = new Set(canonicalSingleUserIds);
  if (
    rawUserId === 'default' ||
    canonical.has(trimmed) ||
    canonical.has(rawUserId)
  ) {
    if (!candidates.includes('default')) candidates.push('default');
  }
  return [...new Set(candidates)];
}

function tokens(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’']/g, '')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(normalized.filter(word => word.length >= 3 && !STOP_WORDS.has(word)));
}

function topicOverlap(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }
  // An overlap coefficient works better than Jaccard for short replies such as
  // "what about the passport?" to a longer travel reminder.
  return shared / Math.min(left.size, right.size);
}

function itemText(item: ScheduledItem): string {
  return [item.message, item.taskConfig?.goal, item.result?.response]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

function matchesIdentity(
  userId: string,
  itemUserId: string,
  explicitCandidates?: string[],
): boolean {
  return (explicitCandidates ?? proactiveIdentityCandidates(userId)).includes(itemUserId);
}

/**
 * Attribute a reply to at most one proactive item.
 *
 * Attributing only the best/newest match avoids the previous behavior where a
 * single unrelated user message marked every nudge in the 15-minute window as
 * acted. Callers can persist the returned reason/score for measurement.
 */
export function attributeProactiveEngagement(
  userId: string,
  recentFiredItems: ScheduledItem[],
  context: ProactiveEngagementContext,
  engagementWindowMs: number = DEFAULT_ENGAGEMENT_WINDOW_MS,
  now: number = Date.now(),
): ProactiveEngagementMatch[] {
  const userMessage = context.userMessage?.trim() ?? '';
  if (!userMessage) return [];

  const eligible = recentFiredItems
    .filter(item =>
      matchesIdentity(userId, item.userId, context.identityCandidates) &&
      item.source === 'agent' &&
      item.status === 'fired' &&
      item.firedAt != null &&
      now >= item.firedAt &&
      (now - item.firedAt) < engagementWindowMs,
    )
    .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0));

  if (eligible.length === 0) return [];

  // A stop/criticism is feedback, but never positive engagement. Attribute it
  // to the best matching nudge (or the newest nudge when the user gives a
  // generic "stop") so the caller can persist the negative outcome.
  if (DISMISSAL_RE.test(userMessage) || NEGATIVE_FEEDBACK_RE.test(userMessage)) {
    let best = eligible[0];
    let bestOverlap = 0;
    for (const item of eligible) {
      const overlap = topicOverlap(userMessage, itemText(item));
      if (overlap > bestOverlap) {
        best = item;
        bestOverlap = overlap;
      }
    }
    return [{ itemId: best.id, score: -1, reason: 'negative' }];
  }

  // Uncertainty is neither approval nor rejection. In particular, a reply
  // such as "I don't know about the passport" shares a topic word with the
  // nudge, but it should not train the system that the outreach was useful.
  if (NEUTRAL_UNCERTAINTY_RE.test(userMessage)) return [];

  const acknowledgement = ACKNOWLEDGEMENT_RE.test(userMessage);
  let best: ProactiveEngagementMatch | null = null;

  for (const item of eligible) {
    const text = itemText(item);
    const replyOverlap = context.repliedToText
      ? topicOverlap(context.repliedToText, text)
      : 0;
    const messageOverlap = topicOverlap(userMessage, text);

    let candidate: ProactiveEngagementMatch | null = null;
    if (context.directReply && context.repliedToText && replyOverlap >= 0.34) {
      const replyAction = context.allowSourceAction === false
        ? null
        : parseProactiveReplyAction(userMessage);
      candidate = {
        itemId: item.id,
        score: 1 + replyOverlap,
        reason: 'direct_reply',
        ...(replyAction ? { replyAction } : {}),
      };
    } else if (messageOverlap >= 0.34) {
      candidate = { itemId: item.id, score: messageOverlap, reason: 'topic_overlap' };
    } else if (
      acknowledgement &&
      item === eligible[0] &&
      item.firedAt != null &&
      now - item.firedAt < ACKNOWLEDGEMENT_WINDOW_MS
    ) {
      // A terse acknowledgement contains no topic words, so recency is the
      // evidence. It may only attach to the single newest delivered nudge.
      candidate = { itemId: item.id, score: 0.5, reason: 'acknowledgement' };
    }

    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }

  return best ? [best] : [];
}

/** Backward-compatible ID-only wrapper. */
export function detectProactiveEngagement(
  userId: string,
  recentFiredItems: ScheduledItem[],
  engagementWindowMs: number = DEFAULT_ENGAGEMENT_WINDOW_MS,
  now: number = Date.now(),
  context: ProactiveEngagementContext = {},
): string[] {
  return attributeProactiveEngagement(
    userId,
    recentFiredItems,
    context,
    engagementWindowMs,
    now,
  ).filter(match => match.reason !== 'negative').map(match => match.itemId);
}
