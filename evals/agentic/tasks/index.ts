import type { BenchTask } from '../types.js';
import { ASSISTANT_TASKS } from './assistant.js';
import { CODING_TASKS } from './coding.js';
import { HARD_CODE_TASKS } from './hard-code.js';
import { HARD_OPS_TASKS } from './hard-ops.js';
import { TRAP_TASKS } from './trap.js';

export const HARD_TASKS: BenchTask[] = [...HARD_CODE_TASKS, ...HARD_OPS_TASKS];

export const ALL_TASKS: BenchTask[] = [...TRAP_TASKS, ...CODING_TASKS, ...ASSISTANT_TASKS, ...HARD_TASKS];

/**
 * Resolve a `--tasks` selector: `all`, a category (`trap`, `coding`,
 * `assistant`, `hard`), or a comma list of task ids / categories.
 */
export function selectTasks(selector: string): BenchTask[] {
  const aliases: Record<string, string> = { traps: 'trap', code: 'coding', assist: 'assistant' };
  const parts = selector.split(',').map(part => part.trim()).filter(Boolean).map(part => aliases[part] ?? part);
  if (parts.length === 0 || parts.includes('all')) return ALL_TASKS;
  const unknown = parts.filter(part => !ALL_TASKS.some(task => task.category === part || task.id === part));
  if (unknown.length > 0) {
    throw new Error(`Unknown task selector(s): ${unknown.join(', ')}. Known ids: ${ALL_TASKS.map(t => t.id).join(', ')}`);
  }
  return ALL_TASKS.filter(task => parts.includes(task.category) || parts.includes(task.id));
}
