/**
 * Session Lane Serialization (Command Queue)
 *
 * Ensures concurrent messages to the same session are processed sequentially.
 * Each "lane" (keyed by session ID) processes tasks one at a time.
 */

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
};

type LaneState = {
  queue: QueueEntry[];
  active: boolean;
  /** Bumped on reset to invalidate stale completions */
  generation: number;
};

const lanes = new Map<string, LaneState>();

/**
 * Enqueue a task in a named lane. Tasks in the same lane run sequentially.
 * Tasks in different lanes run concurrently.
 *
 * @param lane - Lane name (e.g., `session:${sessionId}`)
 * @param task - Async function to execute
 * @param opts - Options
 * @returns Promise that resolves with the task's return value
 */
export function enqueueInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: { warnAfterMs?: number }
): Promise<T> {
  const state = lanes.get(lane) || { queue: [], active: false, generation: 0 };
  if (!lanes.has(lane)) lanes.set(lane, state);

  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 5000,
    });

    drainLane(state);
  });
}

/**
 * Clear all pending (not yet started) tasks in a lane.
 * The currently executing task is not affected.
 * Pending tasks are rejected with a cancellation error.
 */
export function clearLane(lane: string): void {
  const state = lanes.get(lane);
  if (!state) return;

  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new Error(`Lane "${lane}" cleared — task cancelled`));
  }
  state.generation++;
}

/**
 * Reset all lanes. Cancels all pending tasks and invalidates active ones.
 */
export function resetAllLanes(): void {
  for (const [lane, state] of lanes) {
    const pending = state.queue.splice(0);
    for (const entry of pending) {
      entry.reject(new Error(`All lanes reset — task cancelled`));
    }
    state.generation++;
    state.active = false;
  }
  lanes.clear();
}

/**
 * Check if a lane has pending (queued but not yet started) work.
 */
export function laneHasPending(lane: string): boolean {
  const state = lanes.get(lane);
  return !!state && state.queue.length > 0;
}

/**
 * Get the number of pending tasks in a lane.
 */
export function laneQueueSize(lane: string): number {
  const state = lanes.get(lane);
  return state ? state.queue.length : 0;
}

/** Optional warning logger */
let warnLogger: ((msg: string) => void) | null = null;

/**
 * Set a logger for queue warnings (e.g., long wait times).
 */
export function setQueueLogger(logger: (msg: string) => void): void {
  warnLogger = logger;
}

/**
 * Drain lane: process tasks sequentially.
 */
function drainLane(state: LaneState): void {
  if (state.active || state.queue.length === 0) return;

  state.active = true;
  const entry = state.queue.shift()!;

  // Warn if task waited too long
  const waitTime = Date.now() - entry.enqueuedAt;
  if (waitTime > entry.warnAfterMs && warnLogger) {
    warnLogger(`Task waited ${waitTime}ms in queue (warn threshold: ${entry.warnAfterMs}ms)`);
  }

  const gen = state.generation;

  entry.task()
    .then(result => {
      entry.resolve(result);
    })
    .catch(err => {
      entry.reject(err);
    })
    .finally(() => {
      // Only continue draining if generation hasn't been bumped (not reset)
      if (gen === state.generation) {
        state.active = false;
        drainLane(state); // pump next
      }
    });
}
