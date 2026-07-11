/**
 * Tests for proactive engagement detection (feedback loop).
 *
 * detectProactiveEngagement is a pure function that identifies which
 * recently-fired agent items should be marked as 'acted' because the
 * user engaged within the engagement window.
 *
 * All tests use injectable `now` for deterministic timing.
 */

import { describe, it, expect } from 'vitest';
import {
  attributeProactiveEngagement,
  detectProactiveEngagement,
  parseProactiveReplyAction,
  proactiveIdentityCandidates,
} from './feedback.js';
import type { ScheduledItem } from '../memory/db.js';

// ============ Constants for test readability ============

const MIN_MS = 60 * 1000;

/**
 * Fixed "now" for deterministic tests.
 * 2024-01-15T12:00:00.000Z (Monday noon UTC)
 */
const NOW = 1_705_320_000_000;

// ============ Test Helpers ============

/** Create a ScheduledItem with sensible defaults for agent-fired items */
function makeItem(overrides?: Partial<ScheduledItem>): ScheduledItem {
  return {
    id: 'item-1',
    userId: 'user-1',
    sessionId: null,
    source: 'agent',
    type: 'goal_checkin',
    message: 'How is your project going?',
    context: null,
    triggerAt: NOW - 30 * MIN_MS,
    recurring: null,
    status: 'fired',
    firedAt: NOW - 10 * MIN_MS,
    sourceMemoryId: null,
    createdAt: NOW - 60 * MIN_MS,
    updatedAt: NOW - 10 * MIN_MS,
    ...overrides,
  };
}

// ============ detectProactiveEngagement ============

describe('detectProactiveEngagement', () => {
  it('parses only explicit standalone source-item reply actions', () => {
    expect(parseProactiveReplyAction('Archive')).toEqual({ type: 'archive' });
    expect(parseProactiveReplyAction('Mark it done.')).toEqual({ type: 'done' });
    expect(parseProactiveReplyAction('Snooze')).toEqual({ type: 'snooze', delayMs: 24 * 60 * 60 * 1000 });
    expect(parseProactiveReplyAction('Snooze for 2 hours')).toEqual({ type: 'snooze', delayMs: 2 * 60 * 60 * 1000 });
    expect(parseProactiveReplyAction('The archive is done')).toBeNull();
    expect(parseProactiveReplyAction('Do not archive this')).toBeNull();
    expect(parseProactiveReplyAction('Snooze for 90 days')).toBeNull();
  });

  it('attaches a parsed action only to trusted direct-reply attribution', () => {
    const item = makeItem({ message: 'Should I keep the Project Atlas launch task open?' });
    expect(attributeProactiveEngagement('user-1', [item], {
      userMessage: 'Archive',
      directReply: true,
      repliedToText: item.message,
    }, undefined, NOW)).toEqual([expect.objectContaining({
      itemId: item.id,
      reason: 'direct_reply',
      replyAction: { type: 'archive' },
    })]);
    expect(attributeProactiveEngagement('user-1', [item], {
      userMessage: 'Archive',
    }, undefined, NOW)).toEqual([]);
  });

  it('records a media-caption direct reply without authorizing its standalone action', () => {
    const item = makeItem({ message: 'Should I keep the Project Atlas launch task open?' });

    const [match] = attributeProactiveEngagement('user-1', [item], {
      userMessage: 'Archive',
      directReply: true,
      repliedToText: item.message,
      allowSourceAction: false,
    }, undefined, NOW);
    expect(match).toEqual(expect.objectContaining({
      itemId: item.id,
      reason: 'direct_reply',
    }));
    expect(match).not.toHaveProperty('replyAction');
  });

  it('returns empty array when no fired items', () => {
    const result = detectProactiveEngagement('user-1', [], undefined, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual([]);
  });

  it('returns empty array when all items outside engagement window', () => {
    const items = [
      makeItem({ id: 'old-1', firedAt: NOW - 180 * MIN_MS }),
      makeItem({ id: 'old-2', firedAt: NOW - 240 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual([]);
  });

  it('attributes a reply to only the best recent item, not every item in the window', () => {
    const items = [
      makeItem({ id: 'recent-1', message: 'Did you finish the TypeScript project?', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'recent-2', message: 'Have you booked the dentist?', firedAt: NOW - 10 * MIN_MS }),
      makeItem({ id: 'old-1', firedAt: NOW - 20 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW, {
      userMessage: 'The TypeScript project is finished now',
    });
    expect(result).toEqual(['recent-1']);
  });

  it('ignores items with source !== agent', () => {
    const items = [
      makeItem({ id: 'user-item', source: 'user', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'agent-item', source: 'agent', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual(['agent-item']);
  });

  it('ignores items with status !== fired', () => {
    const items = [
      makeItem({ id: 'pending-item', status: 'pending', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'dismissed-item', status: 'dismissed', firedAt: NOW - 5 * MIN_MS }),
      makeItem({ id: 'fired-item', status: 'fired', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual(['fired-item']);
  });

  it('ignores items without firedAt', () => {
    const items = [
      makeItem({ id: 'no-fired-at', firedAt: null }),
      makeItem({ id: 'has-fired-at', firedAt: NOW - 5 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual(['has-fired-at']);
  });

  it('respects custom engagementWindowMs', () => {
    const customWindow = 5 * MIN_MS; // 5 minutes instead of default 15
    const items = [
      makeItem({ id: 'within-custom', firedAt: NOW - 3 * MIN_MS }),
      makeItem({ id: 'outside-custom', firedAt: NOW - 7 * MIN_MS }),
    ];
    const result = detectProactiveEngagement('user-1', items, customWindow, NOW, { userMessage: 'How is the project?' });
    expect(result).toEqual(['within-custom']);
  });

  it('uses injectable now parameter', () => {
    const customNow = NOW + 60 * MIN_MS; // 1 hour later
    const items = [
      makeItem({ id: 'item-1', firedAt: NOW - 5 * MIN_MS }), // 65 min before customNow
      makeItem({ id: 'item-2', firedAt: customNow - 5 * MIN_MS }), // 5 min before customNow
    ];
    const result = detectProactiveEngagement('user-1', items, undefined, customNow, { userMessage: 'How is the project?' });
    expect(result).toEqual(['item-2']);
  });

  it('does not count an unrelated nearby message as engagement', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];
    expect(detectProactiveEngagement('user-1', items, undefined, NOW, {
      userMessage: 'Can you explain this TypeScript error?',
    })).toEqual([]);
  });

  it('does not count a dismissal as positive engagement', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];
    expect(detectProactiveEngagement('user-1', items, undefined, NOW, {
      userMessage: 'Not now, stop reminding me about the passport',
    })).toEqual([]);
  });

  it('returns explicit negative attribution for persistence by the scheduler', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Why are you asking? I already told you that was done.',
    }, undefined, NOW)).toEqual([
      { itemId: 'item-1', score: -1, reason: 'negative' },
    ]);
  });

  it('keeps uncertainty neutral even when it repeats the nudge topic', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];

    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: "I don't know yet",
    }, undefined, NOW)).toEqual([]);
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: "I don't know about the passport",
    }, undefined, NOW)).toEqual([]);
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: "I'm not sure about the passport",
    }, undefined, NOW)).toEqual([]);
  });

  it('does not mistake ordinary uses of "stopped" for dismissal or approval', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'I stopped by the shop',
    }, undefined, NOW)).toEqual([]);
  });

  it('still treats a clear request to stop outreach as negative feedback', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];

    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Stop reminding me about this',
    }, undefined, NOW)).toEqual([
      { itemId: 'item-1', score: -1, reason: 'negative' },
    ]);
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Stop.',
    }, undefined, NOW)).toEqual([
      { itemId: 'item-1', score: -1, reason: 'negative' },
    ]);
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Please stop.',
    }, undefined, NOW)).toEqual([
      { itemId: 'item-1', score: -1, reason: 'negative' },
    ]);
  });

  it('attributes a terse acknowledgement only to the newest item', () => {
    const items = [
      makeItem({ id: 'older', firedAt: NOW - 8 * MIN_MS }),
      makeItem({ id: 'newest', firedAt: NOW - 2 * MIN_MS }),
    ];
    const matches = attributeProactiveEngagement('user-1', items, { userMessage: 'Thanks!' }, undefined, NOW);
    expect(matches).toEqual([{ itemId: 'newest', score: 0.5, reason: 'acknowledgement' }]);
  });

  it('does not treat a context-free acknowledgement much later as approval', () => {
    const items = [makeItem({ firedAt: NOW - 40 * MIN_MS })];
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Thanks!',
    }, undefined, NOW)).toEqual([]);
  });

  it('requires replied-to text to match before trusting direct-reply metadata', () => {
    const items = [makeItem({ message: 'Remember to renew your passport before Spain' })];
    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'Sure',
      directReply: true,
      repliedToText: 'Here is your unrelated build output',
    }, undefined, NOW)[0]?.reason).toBe('acknowledgement');

    expect(attributeProactiveEngagement('user-1', items, {
      userMessage: 'I renewed it',
      directReply: true,
      repliedToText: 'Remember to renew your passport before Spain',
    }, undefined, NOW)[0]?.reason).toBe('direct_reply');
  });

  it('matches exact, raw, and canonical single-user identities', () => {
    expect(proactiveIdentityCandidates('telegram:123')).toEqual(['telegram:123', '123']);
    expect(proactiveIdentityCandidates('telegram:123', ['123'])).toEqual(['telegram:123', '123', 'default']);
    expect(proactiveIdentityCandidates('api:default')).toEqual(['api:default', 'default']);
    expect(proactiveIdentityCandidates('default')).toEqual(['default']);

    const item = makeItem({ userId: 'default' });
    expect(detectProactiveEngagement('telegram:123', [item], undefined, NOW, {
      userMessage: 'How is the project?',
      identityCandidates: proactiveIdentityCandidates('telegram:123', ['123']),
    }))
      .toEqual(['item-1']);
  });

  it('does not attribute one public channel user to the shared default identity implicitly', () => {
    const item = makeItem({ userId: 'default' });
    expect(detectProactiveEngagement('telegram:999', [item], undefined, NOW, {
      userMessage: 'How is the project?',
    })).toEqual([]);
  });

  it('rejects future fired timestamps', () => {
    const item = makeItem({ firedAt: NOW + MIN_MS });
    expect(detectProactiveEngagement('user-1', [item], undefined, NOW, { userMessage: 'How is the project?' }))
      .toEqual([]);
  });

  it('measures higher attribution precision than the former time-only heuristic', () => {
    const item = makeItem({ message: 'Remember to renew your passport before Spain' });
    const fixtures = [
      { text: 'I renewed my passport for Spain', expected: true },
      { text: 'Thanks!', expected: true },
      { text: 'Can you explain this TypeScript error?', expected: false },
      { text: 'Hello, what model are you?', expected: false },
      { text: 'Not now, stop reminding me about the passport', expected: false },
    ];

    // Previous implementation classified every message in the time window as
    // engagement. On this deterministic fixture: TP=2, FP=3 (precision 40%).
    const baselinePredictions = fixtures.map(() => true);
    const candidatePredictions = fixtures.map(fixture =>
      detectProactiveEngagement('user-1', [item], undefined, NOW, { userMessage: fixture.text }).length > 0
    );
    const precision = (predictions: boolean[]) => {
      const predictedPositive = predictions.filter(Boolean).length;
      const truePositive = predictions.filter((prediction, index) => prediction && fixtures[index].expected).length;
      return truePositive / predictedPositive;
    };
    const recall = (predictions: boolean[]) => {
      const actualPositive = fixtures.filter(fixture => fixture.expected).length;
      const truePositive = predictions.filter((prediction, index) => prediction && fixtures[index].expected).length;
      return truePositive / actualPositive;
    };

    expect(precision(baselinePredictions)).toBe(0.4);
    expect(precision(candidatePredictions)).toBe(1);
    expect(recall(candidatePredictions)).toBe(1);
  });
});
