/**
 * Tests for the Hooks/Event System.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerHook,
  unregisterHook,
  triggerHook,
  clearHooks,
  getHookCount,
  setHookLogger,
  type HookEvent,
  type HookHandler,
} from './hooks.js';

beforeEach(() => {
  clearHooks();
});

describe('registerHook / unregisterHook', () => {
  it('registers and counts a handler', () => {
    const handler: HookHandler = async () => {};
    registerHook('tool', handler);
    expect(getHookCount()).toBe(1);
  });

  it('registers multiple handlers for the same key', () => {
    registerHook('tool', async () => {});
    registerHook('tool', async () => {});
    expect(getHookCount()).toBe(2);
  });

  it('unregisters a specific handler', () => {
    const handler: HookHandler = async () => {};
    registerHook('tool', handler);
    expect(getHookCount()).toBe(1);
    unregisterHook('tool', handler);
    expect(getHookCount()).toBe(0);
  });

  it('unregister is a no-op for non-existent handler', () => {
    const h1: HookHandler = async () => {};
    const h2: HookHandler = async () => {};
    registerHook('tool', h1);
    unregisterHook('tool', h2);
    expect(getHookCount()).toBe(1);
  });

  it('unregister is a no-op for non-existent key', () => {
    unregisterHook('nonexistent', async () => {});
    expect(getHookCount()).toBe(0);
  });
});

describe('triggerHook', () => {
  it('calls type-level handlers', async () => {
    const calls: string[] = [];
    registerHook('tool', async () => { calls.push('type'); });

    await triggerHook({
      type: 'tool',
      action: 'before_call',
      sessionId: 'sess1',
      context: {},
      timestamp: new Date(),
    });

    expect(calls).toEqual(['type']);
  });

  it('calls both type-level and specific handlers', async () => {
    const calls: string[] = [];
    registerHook('tool', async () => { calls.push('type'); });
    registerHook('tool:before_call', async () => { calls.push('specific'); });

    await triggerHook({
      type: 'tool',
      action: 'before_call',
      sessionId: 'sess1',
      context: {},
      timestamp: new Date(),
    });

    expect(calls).toEqual(['type', 'specific']);
  });

  it('does not call handlers for unrelated actions', async () => {
    const calls: string[] = [];
    registerHook('tool:after_call', async () => { calls.push('after'); });

    await triggerHook({
      type: 'tool',
      action: 'before_call',
      sessionId: 'sess1',
      context: {},
      timestamp: new Date(),
    });

    expect(calls).toEqual([]);
  });

  it('passes event data to handlers', async () => {
    let received: HookEvent | null = null;
    registerHook('agent', async (event) => { received = event; });

    const event: HookEvent = {
      type: 'agent',
      action: 'start',
      sessionId: 'sess42',
      context: { foo: 'bar' },
      timestamp: new Date(),
    };

    await triggerHook(event);
    expect(received).toEqual(event);
  });

  it('catches handler errors without crashing', async () => {
    const errors: unknown[] = [];
    setHookLogger((_msg, error) => { errors.push(error); });

    registerHook('tool', async () => { throw new Error('boom'); });
    registerHook('tool', async () => {}); // should still run

    await triggerHook({
      type: 'tool',
      action: 'error',
      sessionId: 'sess1',
      context: {},
      timestamp: new Date(),
    });

    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('boom');

    // Clean up logger
    setHookLogger(() => {});
  });

  it('executes handlers sequentially', async () => {
    const order: number[] = [];

    registerHook('tool', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    registerHook('tool', async () => {
      order.push(2);
    });

    await triggerHook({
      type: 'tool',
      action: 'test',
      sessionId: 'sess1',
      context: {},
      timestamp: new Date(),
    });

    expect(order).toEqual([1, 2]);
  });
});

describe('clearHooks', () => {
  it('removes all registered handlers', () => {
    registerHook('tool', async () => {});
    registerHook('agent', async () => {});
    registerHook('memory:extract', async () => {});
    expect(getHookCount()).toBe(3);

    clearHooks();
    expect(getHookCount()).toBe(0);
  });
});
