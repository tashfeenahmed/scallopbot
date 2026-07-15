import { describe, expect, it } from 'vitest';
import {
  isBoardItemLiveForContext,
  isGoalLiveForAutonomy,
  isMemoryLiveForContext,
  isProfileEntryLiveForContext,
} from './state-relevance.js';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 15, 12);

describe('ambient state relevance', () => {
  it('keeps old records recoverable without treating them as current', () => {
    expect(isMemoryLiveForContext({
      content: 'Prepare for an old client meeting',
      source: 'user',
      documentDate: NOW - 120 * DAY,
      eventDate: null,
      metadata: null,
    }, 'what is on my plate today?', NOW)).toBe(false);

    expect(isMemoryLiveForContext({
      content: 'Prepare for an old client meeting',
      source: 'user',
      documentDate: NOW - 120 * DAY,
      eventDate: null,
      metadata: null,
    }, 'show the history of the client meeting', NOW)).toBe(true);
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
      lastAccessed: NOW - DAY,
      metadata: { status: 'active', dueDate: NOW - 30 * DAY, progress: 20 },
    }, NOW)).toBe(true);
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
      ...base, source: 'user', status: 'pending', boardStatus: 'backlog',
    }, NOW)).toBe(true);
  });

  it('expires transient profile state but preserves identity', () => {
    expect(isProfileEntryLiveForContext({ key: 'mood', updatedAt: NOW - 2 * DAY }, NOW)).toBe(false);
    expect(isProfileEntryLiveForContext({ key: 'name', updatedAt: NOW - 500 * DAY }, NOW)).toBe(true);
  });
});
