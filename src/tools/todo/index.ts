/**
 * Native `todo` tool (Hermes / Claude Code style).
 *
 * Each call sends the whole list and replaces the previous one. At most one
 * item may be in_progress. The full list comes back on every call, and
 * {@link getTodoSnapshot} lets the agent re-inject it after compaction.
 */

import { defineSkill } from '../../skills/sdk.js';
import type { SkillRegistry } from '../../skills/registry.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_ITEMS = 50;
const MAX_CONTENT = 500;

const store = new Map<string, TodoItem[]>();

const MARK: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

/** Compact rendering used in results and snapshots. */
export function renderTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return 'Todo list is empty.';
  const done = items.filter(i => i.status === 'completed').length;
  const lines = items.map(i => `${MARK[i.status]} ${i.id}. ${i.content}${i.status === 'in_progress' ? '  (in progress)' : ''}`);
  return [`Todos (${done}/${items.length} done):`, ...lines].join('\n');
}

export type TodoValidation = { ok: true; items: TodoItem[] } | { ok: false; error: string };

/** Validate and normalise a full replacement list. */
export function validateTodos(raw: unknown): TodoValidation {
  let input = raw;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return { ok: false, error: '"todos" must be an array of {id?, content, status}.' }; }
  }
  if (!Array.isArray(input)) return { ok: false, error: '"todos" must be an array of {id?, content, status}.' };
  if (input.length > MAX_ITEMS) return { ok: false, error: `Too many items (${input.length}); keep the list to ${MAX_ITEMS} or fewer.` };

  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const entry = input[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return { ok: false, error: `Item ${i + 1} is not an object.` };
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) return { ok: false, error: `Item ${i + 1} has no "content".` };
    const status = (typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : 'pending') as TodoStatus;
    if (!STATUSES.includes(status)) {
      return { ok: false, error: `Item ${i + 1} has status "${String(entry.status)}"; use pending, in_progress or completed.` };
    }
    let id = entry.id === undefined || entry.id === null || entry.id === '' ? String(i + 1) : String(entry.id).trim();
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    items.push({ id, content: content.slice(0, MAX_CONTENT), status });
  }

  const active = items.filter(i => i.status === 'in_progress');
  if (active.length > 1) {
    return {
      ok: false,
      error: `Only one item may be in_progress at a time, but ${active.length} are (${active.map(i => i.id).join(', ')}). Keep the one you are working on now as in_progress and set the others to pending (or completed if verified). The list was not changed.`,
    };
  }
  return { ok: true, items };
}

/** Replace the session's list (validated). */
export function setTodos(sessionId: string, raw: unknown): TodoValidation {
  const v = validateTodos(raw);
  if (v.ok) {
    if (v.items.length === 0) store.delete(sessionId);
    else store.set(sessionId, v.items);
  }
  return v;
}

export function getTodos(sessionId: string): TodoItem[] {
  return [...(store.get(sessionId) ?? [])];
}

/**
 * The list as a harness message for re-injection after compaction, or null
 * when the session has no list or everything is completed.
 */
export function getTodoSnapshot(sessionId: string): string | null {
  const items = store.get(sessionId);
  if (!items || items.length === 0) return null;
  if (items.every(i => i.status === 'completed')) return null;
  return `[todo: current list]\n${renderTodos(items)}`;
}

export function clearTodos(sessionId?: string): void {
  if (sessionId === undefined) store.clear();
  else store.delete(sessionId);
}

const DESCRIPTION = [
  'Plan and track multi-step work (3+ steps). Each call sends the FULL list and replaces the previous one; the whole list comes back every call.',
  'Statuses: pending, in_progress, completed. Exactly one item in_progress while you work; move it to completed and the next to in_progress in the same call.',
  'Mark an item completed only after it is verified (tests/type check/build passed, or you ran it and checked the output), not when the code is merely written.',
  'Skip it for single-step or conversational requests. Send an empty list to clear it.',
].join(' ');

export function registerTodoTool(registry: Pick<SkillRegistry, 'registerSkill'>, _deps: Record<string, never> = {}): void {
  const todo = defineSkill('todo', DESCRIPTION)
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete list, in order',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id (optional; defaults to the position)' },
              content: { type: 'string', description: 'What to do, imperative and specific' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    })
    .onNativeExecute(async (ctx) => {
      const v = setTodos(ctx.sessionId, ctx.args.todos);
      if (!v.ok) {
        const current = store.get(ctx.sessionId);
        return { success: false, output: `${v.error}${current ? `\n\nCurrent list:\n${renderTodos(current)}` : ''}` };
      }
      const rendered = renderTodos(v.items);
      const allDone = v.items.length > 0 && v.items.every(i => i.status === 'completed');
      return { success: true, output: allDone ? `${rendered}\nAll items completed.` : rendered };
    })
    .build();
  registry.registerSkill(todo.skill);
}
