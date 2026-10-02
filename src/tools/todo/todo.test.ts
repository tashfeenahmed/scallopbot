import { beforeEach, describe, expect, it } from 'vitest';
import type { Skill } from '../../skills/types.js';
import { clearTodos, getTodoSnapshot, getTodos, registerTodoTool, renderTodos, setTodos } from './index.js';

function tool() {
  let skill: Skill | undefined;
  registerTodoTool({ registerSkill: (s) => { skill = s; } });
  return (sessionId: string, todos: unknown) => skill!.handler!({ args: { todos }, workspace: '/tmp', sessionId });
}

describe('todo tool', () => {
  beforeEach(() => clearTodos());

  it('replaces the whole list each call and returns it rendered', async () => {
    const call = tool();
    const r1 = await call('s', [
      { content: 'Write parser', status: 'in_progress' },
      { content: 'Add tests', status: 'pending' },
    ]);
    expect(r1.success).toBe(true);
    expect(r1.output).toBe('Todos (0/2 done):\n[>] 1. Write parser  (in progress)\n[ ] 2. Add tests');

    const r2 = await call('s', [
      { id: '1', content: 'Write parser', status: 'completed' },
      { id: '2', content: 'Add tests', status: 'in_progress' },
      { id: '3', content: 'Run tsc', status: 'pending' },
    ]);
    expect(r2.output).toContain('Todos (1/3 done):');
    expect(r2.output).toContain('[x] 1. Write parser');
    expect(getTodos('s')).toHaveLength(3);
  });

  it('enforces at most one in_progress and leaves the list unchanged', async () => {
    const call = tool();
    await call('s', [{ content: 'a', status: 'in_progress' }]);
    const r = await call('s', [
      { id: 'x', content: 'a', status: 'in_progress' },
      { id: 'y', content: 'b', status: 'in_progress' },
    ]);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/Only one item may be in_progress at a time, but 2 are \(x, y\)/);
    expect(r.output).toContain('Current list:');
    expect(getTodos('s')).toEqual([{ id: '1', content: 'a', status: 'in_progress' }]);
  });

  it('validates status and content', async () => {
    const call = tool();
    expect((await call('s', [{ content: 'a', status: 'done' }])).output).toMatch(/pending, in_progress or completed/);
    expect((await call('s', [{ status: 'pending' }])).output).toMatch(/no "content"/);
    expect((await call('s', 'nope')).success).toBe(false);
  });

  it('accepts a JSON-string list (weak models) and an empty list clears it', async () => {
    const call = tool();
    const r = await call('s', JSON.stringify([{ content: 'a', status: 'pending' }]));
    expect(r.success).toBe(true);
    await call('s', []);
    expect(getTodos('s')).toEqual([]);
  });

  it('keeps lists per session', () => {
    setTodos('a', [{ content: 'one', status: 'pending' }]);
    setTodos('b', [{ content: 'two', status: 'pending' }]);
    expect(getTodos('a')[0].content).toBe('one');
    expect(getTodos('b')[0].content).toBe('two');
  });

  it('getTodoSnapshot returns the list for re-injection, null when empty or all done', () => {
    expect(getTodoSnapshot('s')).toBeNull();
    setTodos('s', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]);
    expect(getTodoSnapshot('s')).toBe(`[todo: current list]\n${renderTodos(getTodos('s'))}`);
    setTodos('s', [{ content: 'a', status: 'completed' }]);
    expect(getTodoSnapshot('s')).toBeNull();
  });

  it('describes the verify-before-complete rule', () => {
    let skill: Skill | undefined;
    registerTodoTool({ registerSkill: (s) => { skill = s; } });
    expect(skill!.description).toMatch(/completed only after it is verified/);
    expect(skill!.description).toMatch(/FULL list/);
  });
});
