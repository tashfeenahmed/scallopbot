// Pure display logic for the delegated-tasks panel, kept free of React so
// the root vitest suite (node environment) can cover it.

export interface TaskTimes {
  status: string;
  createdAt: number;
  startedAt?: number | null;
  lastProgressAt?: number | null;
  completedAt?: number | null;
}

/** Compact "m 12s"-style duration for task rows. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Human label for how long a task has been (or was) running.
 *  - completed: wall time from start to completion.
 *  - running:   since it started, or since last progress if that is later
 *               (a task that just resumed shouldn't claim 40 minutes).
 *  - pending:   how long it has been queued.
 *  - failed/blocked/cancelled with no timestamps: ''. */
export function taskElapsedLabel(task: TaskTimes, now: number): string {
  if (task.status === 'completed' && task.startedAt && task.completedAt) {
    const d = formatDuration(task.completedAt - task.startedAt);
    return d ? `done in ${d}` : '';
  }
  if (task.status === 'running') {
    const since = Math.max(task.startedAt ?? 0, task.lastProgressAt ?? 0);
    if (!since) return '';
    const d = formatDuration(now - since);
    return d ? `running ${d}` : '';
  }
  if (task.status === 'pending' && task.createdAt) {
    const d = formatDuration(now - task.createdAt);
    return d ? `queued ${d}` : '';
  }
  return '';
}
