import { describe, expect, it } from 'vitest';
import {
  isBoardItemLiveForContext,
  isGoalLiveForAutonomy,
  isGoalLiveForContext,
  isMemoryLiveForContext,
  isRecallRelevant,
  memoryActivationScore,
  isProfileEntryLiveForContext,
  requestContentTerms,
  requestRelevanceScore,
} from './state-relevance.js';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 15, 12);

describe('ambient state relevance', () => {
  it('matches ordinary singular/plural topic wording without treating goal labels as topics', () => {
    expect(requestContentTerms('YouTube subscriber goal growth phases')).toEqual([
      'youtube', 'subscriber', 'growth', 'phase',
    ]);
    expect(requestRelevanceScore(
      'YouTube subscriber goal growth phases',
      'Become YouTube Famous - 100K Subscribers',
    )).toBeGreaterThanOrEqual(0.5);
    expect(requestRelevanceScore(
      'YouTube subscriber goal growth phases',
      'Test Goal',
    )).toBe(0);
  });

  it('requires direct topic evidence or a genuinely strong semantic paraphrase for recall', () => {
    expect(isRecallRelevant(
      'What was my Struan meeting about?',
      'Met Struan to discuss the UXBR engagement',
      0.76,
    )).toBe(true);
    expect(isRecallRelevant(
      'What was my Struan meeting about?',
      'Annual Global Shapers meeting',
      0.64,
    )).toBe(false);
    expect(isRecallRelevant(
      'How do I like to unwind?',
      'User relaxes by taking quiet evening walks',
      0.71,
    )).toBe(true);
  });

  it('lets an old topic fade from general context but return on a natural direct mention', () => {
    expect(isMemoryLiveForContext({
      content: 'Prepare for the Struan client meeting',
      category: 'event',
      source: 'user',
      documentDate: NOW - 120 * DAY,
      eventDate: NOW - 120 * DAY,
      metadata: null,
    }, 'what is on my plate today?', NOW)).toBe(false);

    expect(isMemoryLiveForContext({
      content: 'Prepare for the Struan client meeting',
      category: 'event',
      source: 'user',
      documentDate: NOW - 120 * DAY,
      eventDate: NOW - 120 * DAY,
      metadata: null,
    }, 'Whatever happened with Struan?', NOW)).toBe(true);
  });

  it('does not strengthen a memory merely because software retrieved it repeatedly', () => {
    const base = {
      content: 'Prepare for the Struan client meeting',
      category: 'event',
      source: 'user',
      documentDate: NOW - 180 * DAY,
      eventDate: NOW - 180 * DAY,
      metadata: null,
    };
    const normal = memoryActivationScore(base, 'what is on my plate today?', NOW);
    const repeatedlyRetrieved = memoryActivationScore({
      ...base,
      // Deliberately extra properties from a real memory row. Activation does
      // not use machine retrieval telemetry as human reinforcement.
      accessCount: 500,
      lastAccessed: NOW,
    }, 'what is on my plate today?', NOW);
    expect(repeatedlyRetrieved).toBe(normal);
  });

  it('never exposes assistant self-reflection as user memory', () => {
    expect(isMemoryLiveForContext({
      content: 'Assistant should improve its workflow',
      source: 'assistant',
      learnedFrom: 'self_reflection',
      documentDate: NOW,
      eventDate: null,
      metadata: { audience: 'assistant' },
    }, 'what should I do today?', NOW)).toBe(false);
    expect(isMemoryLiveForContext({
      content: 'Agent prefers a particular workflow',
      source: 'user',
      documentDate: NOW,
      eventDate: null,
      metadata: { subject: 'agent' },
    }, 'what workflow should I use?', NOW)).toBe(false);
  });

  it('parks stale overdue goals from autonomous evaluation', () => {
    expect(isGoalLiveForAutonomy({
      createdAt: NOW - 100 * DAY,
      lastAccessed: NOW - 90 * DAY,
      metadata: { status: 'active', dueDate: NOW - 30 * DAY, progress: 0 },
    }, NOW)).toBe(false);
    expect(isGoalLiveForAutonomy({
      createdAt: NOW - 100 * DAY,
      updatedAt: NOW,
      lastAccessed: NOW,
      metadata: { status: 'active', dueDate: NOW - 30 * DAY, progress: 20 },
    }, NOW)).toBe(false);
    expect(isGoalLiveForAutonomy({
      createdAt: NOW - 100 * DAY,
      updatedAt: NOW,
      lastAccessed: NOW,
      metadata: {
        status: 'active', dueDate: NOW - 30 * DAY, progress: 20,
        // Automatic check-ins must not keep an abandoned goal alive.
        lastCheckin: NOW,
      },
    }, NOW)).toBe(false);
    expect(isGoalLiveForAutonomy({
      createdAt: NOW - 100 * DAY,
      updatedAt: NOW,
      metadata: {
        status: 'active', dueDate: NOW - 30 * DAY, progress: 20,
        lastActivityAt: NOW,
      },
    }, NOW)).toBe(true);

    expect(isGoalLiveForContext({
      content: 'Prepare for the Struan meeting',
      createdAt: NOW - 200 * DAY,
      updatedAt: NOW - 190 * DAY,
      lastAccessed: NOW,
      metadata: { status: 'active', dueDate: NOW - 180 * DAY, progress: 0 },
    }, 'How did the Struan meeting go?', NOW)).toBe(true);
  });

  it('separates current work from suggestions, blockers, and old cards', () => {
    const base = { triggerAt: 0, createdAt: NOW - DAY, updatedAt: NOW - DAY };
    expect(isBoardItemLiveForContext({
      ...base, source: 'agent', status: 'pending', boardStatus: 'inbox',
    }, NOW)).toBe(false);
    expect(isBoardItemLiveForContext({
      ...base, source: 'user', status: 'blocked', boardStatus: 'waiting',
    }, NOW)).toBe(false);
    expect(isBoardItemLiveForContext({
      ...base,
      message: 'Generate a YouTube metrics report',
      triggerAt: NOW - 2 * DAY,
      updatedAt: NOW,
      source: 'agent', status: 'blocked', boardStatus: 'waiting',
    }, 'what is on my plate today?', NOW)).toBe(false);
    expect(isBoardItemLiveForContext({
      ...base,
      message: 'Generate a YouTube metrics report',
      triggerAt: NOW - 2 * DAY,
      updatedAt: NOW,
      source: 'agent', status: 'blocked', boardStatus: 'waiting',
    }, 'What blocked the YouTube report?', NOW)).toBe(true);
    expect(isBoardItemLiveForContext({
      ...base, source: 'user', status: 'pending', boardStatus: 'backlog',
    }, NOW)).toBe(true);

    expect(isBoardItemLiveForContext({
      ...base,
      message: 'Resolve the Struan contract',
      createdAt: NOW - 180 * DAY,
      updatedAt: NOW - 180 * DAY,
      source: 'user', status: 'blocked', boardStatus: 'waiting',
    }, 'What happened with Struan?', NOW)).toBe(true);
  });

  it('expires transient profile state but preserves identity', () => {
    expect(isProfileEntryLiveForContext({ key: 'mood', updatedAt: NOW - 2 * DAY }, NOW)).toBe(false);
    expect(isProfileEntryLiveForContext({ key: 'name', updatedAt: NOW - 500 * DAY }, NOW)).toBe(true);
  });
});
