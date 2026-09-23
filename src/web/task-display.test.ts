import { describe, expect, it } from 'vitest';
import { formatDuration, taskElapsedLabel, type TaskTimes } from '../../web/src/hooks/taskDisplay';

const MIN = 60_000;

function task(overrides: Partial<TaskTimes> = {}): TaskTimes {
  return { status: 'running', createdAt: 1_000, ...overrides };
}

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_600_000 + 5 * MIN)).toBe('1h 5m');
  });

  it('returns empty for negative or non-finite input', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('taskElapsedLabel', () => {
  it('shows wall time for completed tasks', () => {
    expect(taskElapsedLabel(task({
      status: 'completed', startedAt: 1000, completedAt: 1000 + 2 * MIN + 30_000,
    }), 9_999_999)).toBe('done in 2m 30s');
  });

  it('shows live time for running tasks, measured from last progress when newer', () => {
    const now = 10_000;
    expect(taskElapsedLabel(task({ startedAt: now - 3 * MIN, lastProgressAt: now - 3 * MIN }), now))
      .toBe('running 3m 0s');
    // Resumed worker: claiming since startedAt would overstate the run.
    expect(taskElapsedLabel(task({ startedAt: now - 40 * MIN, lastProgressAt: now - 30_000 }), now))
      .toBe('running 30s');
  });

  it('shows queue wait for pending tasks', () => {
    const now = 5000;
    expect(taskElapsedLabel(task({ status: 'pending', createdAt: now - 90_000 }), now))
      .toBe('queued 1m 30s');
  });

  it('stays silent for failed/cancelled tasks and running tasks without timestamps', () => {
    expect(taskElapsedLabel(task({ status: 'failed' }), Date.now())).toBe('');
    expect(taskElapsedLabel(task({ status: 'running' }), Date.now())).toBe('');
    // Completed without startedAt (edge): no bogus duration.
    expect(taskElapsedLabel(task({ status: 'completed', completedAt: 5 }), 10)).toBe('');
  });
});
