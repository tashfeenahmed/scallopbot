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
import { ENGAGEMENT_WINDOW_MS } from './proactive-config.js';

export const DEFAULT_ENGAGEMENT_WINDOW_MS = ENGAGEMENT_WINDOW_MS;

const ACKNOWLEDGEMENT_RE = /^(?:(?:yes|yeah|yep|sure|okay|ok|got it|done|thanks|thank you|helpful|perfect|great|nice|will do|i did|i have|sorted|fixed)[!.\s]*)$/i;
const DISMISSAL_RE = /\b(?:stop|unsubscribe|don't|do not|not now|leave me alone|no more|irrelevant|wrong person)\b/i;
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
  /** Explicit aliases resolved by the deployment's identity layer. */
  identityCandidates?: string[];
}

export interface ProactiveEngagementMatch {
  itemId: string;
  score: number;
  reason: 'direct_reply' | 'acknowledgement' | 'topic_overlap';
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
  if (!userMessage || DISMISSAL_RE.test(userMessage)) return [];

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
      candidate = { itemId: item.id, score: 1 + replyOverlap, reason: 'direct_reply' };
    } else if (messageOverlap >= 0.34) {
      candidate = { itemId: item.id, score: messageOverlap, reason: 'topic_overlap' };
    } else if (acknowledgement && item === eligible[0]) {
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
  ).map(match => match.itemId);
}
