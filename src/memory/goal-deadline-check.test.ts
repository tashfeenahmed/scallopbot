/**
 * Tests for goal deadline checking.
 *
 * Pure function that checks active goals for approaching deadlines,
 * computes urgency levels, generates notification candidates, and
 * deduplicates against existing reminders via word overlap.
 */

import { describe, it, expect } from 'vitest';
import {
  checkGoalDeadlines,
  type GoalDeadlineResult,
  type ApproachingGoal,
} from './goal-deadline-check.js';
import type { GoalItem } from '../goals/types.js';

// ============ Test Helpers ============

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed "now" for deterministic tests */
const NOW = new Date('2026-02-10T12:00:00Z').getTime();

/** Create a minimal GoalItem for testing */
function makeGoal(overrides: {
  id?: string;
  userId?: string;
  title?: string;
  dueDate?: number;
  status?: 'backlog' | 'active' | 'completed';
}): GoalItem {
  return {
    id: overrides.id ?? 'goal-1',
    userId: overrides.userId ?? 'user-1',
    content: overrides.title ?? 'Test Goal',
    category: 'preference',
    memoryType: 'semantic',
    importance: 5,
    confidence: 1.0,
    isLatest: true,
    documentDate: NOW - 30 * DAY_MS,
    eventDate: null,
    metadata: {
      goalType: 'goal',
      status: overrides.status ?? 'active',
      dueDate: overrides.dueDate,
    },
  } as unknown as GoalItem;
}

// ============ No Goals / Empty Input ============

describe('checkGoalDeadlines -- empty input', () => {
  it('returns empty results for no goals', () => {
    const result = checkGoalDeadlines([], [], { now: NOW });
    expect(result.approaching).toEqual([]);
    expect(result.notifications).toEqual([]);
    expect(result.totalChecked).toBe(0);
  });

  it('returns empty results when all goals lack dueDates', () => {
    const goals = [
      makeGoal({ id: 'g1', title: 'No due date goal' }),
      makeGoal({ id: 'g2', title: 'Another goal without due' }),
    ];
    const result = checkGoalDeadlines(goals, [], { now: NOW });
    expect(result.approaching).toEqual([]);
    expect(result.notifications).toEqual([]);
    expect(result.totalChecked).toBe(2);
  });
});

// ============ Urgency Mapping ============

describe('checkGoalDeadlines -- urgency mapping', () => {
  it('marks goal due in 3 days as warning with notification', () => {
    const dueDate = NOW + 3 * DAY_MS;
    const goals = [makeGoal({ id: 'g1', title: 'Learn TypeScript', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].goalId).toBe('g1');
    expect(result.approaching[0].goalTitle).toBe('Learn TypeScript');
    expect(result.approaching[0].dueDate).toBe(dueDate);
    expect(result.approaching[0].daysRemaining).toBe(3);
    expect(result.approaching[0].urgency).toBe('warning');

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].userId).toBe('user-1');
    expect(result.notifications[0].goalId).toBe('g1');
    expect(result.notifications[0].message).toContain('Learn TypeScript');
    expect(result.notifications[0].message).toContain('3 days');
  });

  it('marks goal due tomorrow as urgent with notification', () => {
    const dueDate = NOW + 1 * DAY_MS;
    const goals = [makeGoal({ id: 'g2', title: 'Ship Feature', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].daysRemaining).toBe(1);
    expect(result.approaching[0].urgency).toBe('urgent');

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toContain('Ship Feature');
  });

  it('marks goal due today (0 days remaining) as urgent', () => {
    const dueDate = NOW; // due right now
    const goals = [makeGoal({ id: 'g3', title: 'Submit Report', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].daysRemaining).toBe(0);
    expect(result.approaching[0].urgency).toBe('urgent');
  });

  it('marks goal overdue by 2 days as overdue with notification', () => {
    const dueDate = NOW - 2 * DAY_MS;
    const goals = [makeGoal({ id: 'g4', title: 'Fix Bug', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].daysRemaining).toBe(-2);
    expect(result.approaching[0].urgency).toBe('overdue');

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toContain('Fix Bug');
    expect(result.notifications[0].message).toContain('overdue');
  });

  it('marks goal at exactly 2 days remaining as urgent', () => {
    const dueDate = NOW + 2 * DAY_MS;
    const goals = [makeGoal({ id: 'g5', title: 'Boundary Check', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].daysRemaining).toBe(2);
    expect(result.approaching[0].urgency).toBe('urgent');
  });

  it('marks goal at exactly warningWindowDays (7) as warning', () => {
    const dueDate = NOW + 7 * DAY_MS;
    const goals = [makeGoal({ id: 'g6', title: 'Week Away', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].daysRemaining).toBe(7);
    expect(result.approaching[0].urgency).toBe('warning');
  });
});

// ============ Outside Window ============

describe('checkGoalDeadlines -- outside warning window', () => {
  it('does not include goal due in 30 days (outside default 7-day window)', () => {
    const dueDate = NOW + 30 * DAY_MS;
    const goals = [makeGoal({ id: 'g7', title: 'Far Away Goal', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(0);
    expect(result.notifications).toHaveLength(0);
    expect(result.totalChecked).toBe(1);
  });

  it('does not include goal due in 8 days (just outside default 7-day window)', () => {
    const dueDate = NOW + 8 * DAY_MS;
    const goals = [makeGoal({ id: 'g8', title: 'Just Outside', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(0);
    expect(result.notifications).toHaveLength(0);
  });

  it('respects custom warningWindowDays', () => {
    const dueDate = NOW + 10 * DAY_MS;
    const goals = [makeGoal({ id: 'g9', title: 'Custom Window', dueDate })];

    // With default 7-day window: not included
    const result7 = checkGoalDeadlines(goals, [], { now: NOW });
    expect(result7.approaching).toHaveLength(0);

    // With 14-day window: included
    const result14 = checkGoalDeadlines(goals, [], {
      now: NOW,
      warningWindowDays: 14,
    });
    expect(result14.approaching).toHaveLength(1);
    expect(result14.approaching[0].urgency).toBe('warning');
  });
});

// ============ Deduplication ============

describe('checkGoalDeadlines -- deduplication', () => {
  it('skips notification when similar reminder already exists', () => {
    const dueDate = NOW + 3 * DAY_MS;
    const goals = [makeGoal({ id: 'g10', title: 'Learn TypeScript', dueDate })];

    // An existing reminder with very similar wording
    const existingReminders = [
      { message: 'Goal approaching deadline: Learn TypeScript — due in 3 days' },
    ];

    const result = checkGoalDeadlines(goals, existingReminders, { now: NOW });

    // The goal should still appear in approaching list
    expect(result.approaching).toHaveLength(1);
    // But no duplicate notification should be created
    expect(result.notifications).toHaveLength(0);
  });

  it('creates notification when existing reminder is for different goal', () => {
    const dueDate = NOW + 3 * DAY_MS;
    const goals = [makeGoal({ id: 'g11', title: 'Learn TypeScript', dueDate })];

    // An existing reminder for a completely different goal
    const existingReminders = [
      { message: 'Goal approaching deadline: Fix Database Bug — due in 5 days' },
    ];

    const result = checkGoalDeadlines(goals, existingReminders, { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.notifications).toHaveLength(1);
  });

  it('deduplicates based on word overlap >= 0.8 threshold', () => {
    const dueDate = NOW + 3 * DAY_MS;
    const goals = [makeGoal({ id: 'g12', title: 'Learn TypeScript', dueDate })];

    // Similar but slightly different wording (high overlap but different days count)
    const existingReminders = [
      { message: 'Goal approaching deadline: Learn TypeScript — due in 4 days' },
    ];

    const result = checkGoalDeadlines(goals, existingReminders, { now: NOW });

    // Word overlap should be high enough (>= 0.8) to deduplicate
    // "Goal approaching deadline: Learn TypeScript — due in 3 days" vs
    // "Goal approaching deadline: Learn TypeScript — due in 4 days"
    // Difference is only "3" vs "4" — most words overlap
    expect(result.notifications).toHaveLength(0);
  });
});

// ============ Multiple Goals ============

describe('checkGoalDeadlines -- multiple goals', () => {
  it('includes all approaching goals with individual notifications', () => {
    const goals = [
      makeGoal({
        id: 'g13',
        userId: 'user-1',
        title: 'Goal Alpha',
        dueDate: NOW + 1 * DAY_MS,
      }),
      makeGoal({
        id: 'g14',
        userId: 'user-1',
        title: 'Goal Beta',
        dueDate: NOW + 5 * DAY_MS,
      }),
      makeGoal({
        id: 'g15',
        userId: 'user-1',
        title: 'Goal Gamma',
        dueDate: NOW - 1 * DAY_MS,
      }),
    ];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(3);
    expect(result.notifications).toHaveLength(3);
    expect(result.totalChecked).toBe(3);

    // Verify each has correct urgency
    const alpha = result.approaching.find((a) => a.goalId === 'g13');
    const beta = result.approaching.find((a) => a.goalId === 'g14');
    const gamma = result.approaching.find((a) => a.goalId === 'g15');

    expect(alpha?.urgency).toBe('urgent');
    expect(beta?.urgency).toBe('warning');
    expect(gamma?.urgency).toBe('overdue');
  });

  it('mixes approaching and non-approaching goals correctly', () => {
    const goals = [
      makeGoal({
        id: 'g16',
        title: 'Due Soon',
        dueDate: NOW + 2 * DAY_MS,
      }),
      makeGoal({
        id: 'g17',
        title: 'Far Away',
        dueDate: NOW + 30 * DAY_MS,
      }),
      makeGoal({
        id: 'g18',
        title: 'No Due Date',
      }),
    ];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.approaching).toHaveLength(1);
    expect(result.approaching[0].goalId).toBe('g16');
    expect(result.notifications).toHaveLength(1);
    expect(result.totalChecked).toBe(3);
  });
});

// ============ Notification Message Format ============

describe('checkGoalDeadlines -- notification messages', () => {
  it('formats approaching message with days remaining', () => {
    const dueDate = NOW + 5 * DAY_MS;
    const goals = [makeGoal({ id: 'g19', title: 'Write Tests', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toBe(
      'Goal approaching deadline: Write Tests \u2014 due in 5 days',
    );
  });

  it('formats overdue message with days overdue', () => {
    const dueDate = NOW - 3 * DAY_MS;
    const goals = [makeGoal({ id: 'g20', title: 'Deploy App', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toBe(
      'Goal approaching deadline: Deploy App \u2014 overdue by 3 days',
    );
  });

  it('formats due today message', () => {
    const dueDate = NOW;
    const goals = [makeGoal({ id: 'g21', title: 'Review PR', dueDate })];

    const result = checkGoalDeadlines(goals, [], { now: NOW });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toBe(
      'Goal approaching deadline: Review PR \u2014 due in 0 days',
    );
  });
});
