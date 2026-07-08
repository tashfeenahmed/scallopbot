import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearHooks, triggerHook } from './hooks.js';
import {
  createWebhookHookHandler,
  registerWebhookEventRelay,
  unregisterWebhookEventRelay,
} from './webhook-relay.js';

const okResponse = {
  ok: true,
  status: 200,
  text: async () => '',
};

beforeEach(() => {
  unregisterWebhookEventRelay();
  clearHooks();
});

describe('createWebhookHookHandler', () => {
  it('posts a lifecycle event payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);
    const handler = createWebhookHookHandler({
      url: 'https://example.com/events',
      agentId: 'scallopbot-test',
      secret: 'shared-secret',
      timeoutMs: 1000,
      fetchImpl,
    });

    await handler({
      type: 'memory',
      action: 'reflection_output',
      sessionId: 'session-1',
      context: { insightsStored: 1 },
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.com/events');
    expect(init.headers.authorization).toBe('Bearer shared-secret');
    expect(init.headers['x-scallopbot-event']).toBe('memory.reflection_output');

    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      schema_version: 1,
      agent_id: 'scallopbot-test',
      event: 'memory.reflection_output',
      type: 'memory',
      action: 'reflection_output',
      session_id: 'session-1',
      timestamp: '2026-01-02T03:04:05.000Z',
      context: { insightsStored: 1 },
    });
  });

  it('throws on non-2xx webhook responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'failed',
    });
    const handler = createWebhookHookHandler({
      url: 'https://example.com/events',
      agentId: 'scallopbot-test',
      fetchImpl,
    });

    await expect(handler({
      type: 'session',
      action: 'affect_change',
      sessionId: 'session-1',
      context: {},
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
    })).rejects.toThrow('HTTP 500');
  });
});

describe('registerWebhookEventRelay', () => {
  it('registers only lifecycle event keys', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);
    const count = registerWebhookEventRelay({
      url: 'https://example.com/events',
      agentId: 'scallopbot-test',
      fetchImpl,
    });

    expect(count).toBe(3);

    await triggerHook({
      type: 'memory',
      action: 'consolidation_complete',
      sessionId: 'background:default',
      context: { memoriesConsolidated: 1 },
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
    });
    await triggerHook({
      type: 'tool',
      action: 'before_call',
      sessionId: 'session-1',
      context: { toolName: 'send_file' },
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
