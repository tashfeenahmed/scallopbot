/**
 * Synthetic, privacy-safe scorecard for the proactive selection/social layer.
 *
 * The "legacy" functions intentionally model the former deterministic gates,
 * not an LLM judge: any qualifying abandoned session was considered open,
 * keyword polarity was ignored, and sanitizer-passing text was considered
 * ready to send. This gives CI a stable before/after measurement.
 */
import { describe, expect, it } from 'vitest';
import type { SessionSummaryRow } from '../memory/db.js';
import { scanBehavioralAnomalies, scanUnresolvedThreads } from '../memory/gap-scanner.js';
import { parseProactivePreferences } from '../memory/proactive-evaluator.js';
import { sanitizeProactiveMessage } from '../proactive/message-safety.js';
import { assessProactiveMessage } from '../proactive/message-quality.js';
import { computeDeliveryTime } from '../proactive/timing-model.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 11, 6, 45);

function summary(id: string, text: string, topics = ['project']): SessionSummaryRow {
  return {
    id,
    sessionId: `session-${id}`,
    userId: 'default',
    summary: text,
    topics,
    messageCount: 5,
    durationMs: 10 * 60_000,
    embedding: null,
    createdAt: NOW - 3 * DAY,
  };
}

function precision(predictions: boolean[], expected: boolean[]): number {
  const predicted = predictions.filter(Boolean).length;
  if (predicted === 0) return 1;
  return predictions.filter((value, index) => value && expected[index]).length / predicted;
}

describe('proactive human-likeness deterministic scorecard', () => {
  it('improves outreach precision by requiring explicit open-loop evidence', () => {
    const cases = [
      { rows: [summary('casual', 'The user discussed deployment options and thanked the assistant.')], send: false },
      { rows: [summary('complete', 'The deployment task was completed and no further action is needed.')], send: false },
      { rows: [summary('question', 'The assistant answered a question about deployment.', ['How to deploy?'])], send: false },
      { rows: [summary('pending', 'The user will follow up and confirm the deployment result.')], send: true },
      { rows: [summary('negated', 'No follow-up is needed for the deployment.')], send: false },
    ];
    const expected = cases.map(testCase => testCase.send);
    // Former rule: every old-enough session without a later session qualified.
    const legacy = cases.map(() => true);
    const candidate = cases.map(testCase => scanUnresolvedThreads(testCase.rows, NOW).length > 0);

    expect(precision(legacy, expected)).toBe(0.2);
    expect(precision(candidate, expected)).toBe(1);
    expect(candidate).toEqual(expected);
  });

  it('reduces telemetry-only outreach false positives from three to zero', () => {
    const patterns = {
      userId: 'default',
      messageFrequency: { dailyRate: 1, weeklyAvg: 10, trend: 'decreasing', lastComputed: NOW },
      sessionEngagement: { avgMessagesPerSession: 1, avgDurationMs: 60_000, trend: 'decreasing', lastComputed: NOW },
      responseLength: { avgLength: 20, trend: 'decreasing', lastComputed: NOW },
      activeHours: [],
      topicClusters: [],
      responsePreferences: {},
      lastUpdated: NOW,
    } as any;

    const legacyFalseSends = 3;
    const candidateFalseSends = scanBehavioralAnomalies(patterns, NOW).length;
    expect(legacyFalseSends).toBe(3);
    expect(candidateFalseSends).toBe(0);
  });

  it('raises deterministic preference/consent classification accuracy from 25% to 100%', () => {
    const fixtures = [
      { text: "Don't proactively check in.", elevate: false, optOut: true },
      { text: 'Please be more proactive and check in.', elevate: true, optOut: false },
      { text: "Don't remind me about medication.", elevate: false, optOut: false },
      { text: 'We discussed proactive design patterns.', elevate: false, optOut: false },
      // Topic-scoped opt-in is honored for that appointment but does not grant
      // broad eager permission for unrelated outreach.
      { text: "Don't forget to remind me before the appointment.", elevate: false, optOut: false },
      { text: 'Reminder: buy milk tomorrow', elevate: false, optOut: false },
      { text: 'Reminders stress me out', elevate: false, optOut: false },
      { text: 'Check-ins are annoying', elevate: false, optOut: false },
    ];
    const legacy = fixtures.map(fixture => /proactive|check in|remind/i.test(fixture.text));
    const candidate = fixtures.map(fixture => parseProactivePreferences([fixture.text]).shouldElevate);
    const expected = fixtures.map(fixture => fixture.elevate);
    const accuracy = (predictions: boolean[]) =>
      predictions.filter((prediction, index) => prediction === expected[index]).length / expected.length;

    expect(accuracy(legacy)).toBe(0.25);
    expect(accuracy(candidate)).toBe(1);
    expect(parseProactivePreferences([fixtures[0].text]).globalOptOut).toBe(true);
  });

  it('catches generic, relational, and internal-plan drafts the former gate accepted', () => {
    const fixtures = [
      { text: 'Your dentist appointment is at 2 today.', acceptable: true },
      { text: 'Hey, just checking in — how are things going?', acceptable: false },
      { text: "I noticed you've been quiet. Is everything okay?", acceptable: false },
      { text: "I've been thinking about you. I miss you.", acceptable: false },
      { text: "Why haven't you replied? You should have done this already.", acceptable: false },
      { text: 'Did the review happen? How did it go?', acceptable: false },
      { text: 'Hey, how is your day going?', acceptable: false },
      { text: 'Just wanted to see how you are doing.', acceptable: false },
      { text: 'The next step is to ask about the deadline.', acceptable: false },
      { text: 'Draft: Ask whether the review happened.', acceptable: false },
      { text: 'A useful follow-up would be to ask about the result.', acceptable: false },
      { text: 'The reminder should check whether the form was filed.', acceptable: false },
    ];
    // The former boundary accepted any non-empty plain-text draft that lacked
    // explicit tool markup; it did not distinguish plans from recipient text.
    const legacy = fixtures.map(fixture => fixture.text.trim().length > 0);
    const candidate = fixtures.map(fixture =>
      sanitizeProactiveMessage(fixture.text) !== null && assessProactiveMessage(fixture.text).acceptable
    );
    const expected = fixtures.map(fixture => fixture.acceptable);
    const falseSends = (predictions: boolean[]) =>
      predictions.filter((prediction, index) => prediction && !expected[index]).length;

    expect(falseSends(legacy)).toBe(fixtures.filter(fixture => !fixture.acceptable).length);
    expect(falseSends(candidate)).toBe(0);
    expect(candidate).toEqual(expected);
  });

  it('replaces a single clockwork minute with bounded deterministic variety', () => {
    const legacyMinutes = new Set(Array.from({ length: 24 }, () => 15));
    const candidateMinutes = new Set(Array.from({ length: 24 }, (_, index) => {
      const result = computeDeliveryTime({
        userActiveHours: [9, 10, 11],
        quietHours: { start: 0, end: 0 },
        lastProactiveAt: null,
        currentHour: 6,
        currentMinute: 45,
        urgency: 'low',
        now: NOW,
        jitterSeed: `intent-${index}`,
      });
      return Math.round((result.deliverAt - NOW) / 60_000);
    }));

    expect(legacyMinutes.size).toBe(1);
    expect(candidateMinutes.size).toBeGreaterThanOrEqual(8);
    for (const delay of candidateMinutes) {
      expect(delay).toBeGreaterThanOrEqual(140);
      expect(delay).toBeLessThanOrEqual(155);
    }
  });
});
