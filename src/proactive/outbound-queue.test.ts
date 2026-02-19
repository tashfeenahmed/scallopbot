/**
 * Tests for OutboundQueue — single-user LLM-powered message combining.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboundQueue, type OutboundQueueOptions } from './outbound-queue.js';

// ============ Test Helpers ============

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createMockRouter(response = 'Combined message from LLM') {
  return {
    executeWithFallback: vi.fn().mockResolvedValue({
      response: {
        content: [{ type: 'text', text: response }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 30 },
        model: 'llama-3.3-70b-versatile',
      },
      provider: 'groq',
      attemptedProviders: ['groq'],
    }),
  } as any;
}

function createQueue(overrides: Partial<OutboundQueueOptions> = {}) {
  const sendMessage = vi.fn().mockResolvedValue(true);
  const logger = createMockLogger();
  const router = createMockRouter();

  const queue = new OutboundQueue({
    sendMessage,
    logger,
    router,
    ...overrides,
  });

  return { queue, sendMessage, logger, router };
}

// ============ Tests ============

describe('OutboundQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('single message passthrough', () => {
    it('sends a single message directly without LLM', async () => {
      const { queue, sendMessage, router } = createQueue();

      const handler = queue.createHandler();
      await handler('user1', 'Hey, your dentist appointment is at 2pm today.');

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(router.executeWithFallback).not.toHaveBeenCalled();
    });

    it('sends single message text as-is', async () => {
      const { queue, sendMessage } = createQueue();
      const handler = queue.createHandler();

      await handler('user1', 'Reminder: meeting at 3pm');

      expect(sendMessage).toHaveBeenCalledWith('user1', 'Reminder: meeting at 3pm');
    });
  });

  describe('LLM combining for 2+ messages', () => {
    it('combines multiple messages for same user via LLM', async () => {
      const { queue, sendMessage, router } = createQueue();

      queue.enqueue('user1', 'Your dentist is at 2pm.');
      queue.enqueue('user1', 'How is the Rust learning going?');

      // Create handler and send a third to trigger drain
      const handler = queue.createHandler();
      await handler('user1', 'Dan birthday next week');

      // LLM should have been called with all 3 messages
      expect(router.executeWithFallback).toHaveBeenCalledTimes(1);
      const call = router.executeWithFallback.mock.calls[0];
      expect(call[0].system).toContain('combine multiple proactive messages');
      expect(call[0].messages[0].content).toContain('1.');
      expect(call[0].messages[0].content).toContain('2.');
      expect(call[0].messages[0].content).toContain('3.');
      expect(call[1]).toBe('fast');

      // Should send the LLM's combined output
      expect(sendMessage).toHaveBeenCalledWith('user1', 'Combined message from LLM');
    });

    it('uses fast tier for LLM calls', async () => {
      const { queue, router } = createQueue();

      queue.enqueue('user1', 'Message A');
      queue.enqueue('user1', 'Message B');

      const handler = queue.createHandler();
      await handler('user1', 'Message C');

      expect(router.executeWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: 300,
          temperature: 0.7,
        }),
        'fast'
      );
    });
  });

  describe('LLM failure fallback', () => {
    it('falls back to newline-joined messages when LLM fails', async () => {
      const failingRouter = {
        executeWithFallback: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      } as any;

      const { queue, sendMessage } = createQueue({ router: failingRouter });

      queue.enqueue('user1', 'Message A');
      queue.enqueue('user1', 'Message B');

      const handler = queue.createHandler();
      await handler('user1', 'Message C');

      expect(sendMessage).toHaveBeenCalledWith('user1', 'Message A\n\nMessage B\n\nMessage C');
    });

    it('falls back to join when no router is provided', async () => {
      const { queue, sendMessage } = createQueue({ router: undefined });

      queue.enqueue('user1', 'First thing');
      queue.enqueue('user1', 'Second thing');

      const handler = queue.createHandler();
      await handler('user1', 'Third thing');

      expect(sendMessage).toHaveBeenCalledWith('user1', 'First thing\n\nSecond thing\n\nThird thing');
    });

    it('falls back when LLM returns empty response', async () => {
      const emptyRouter = createMockRouter('');
      // Override with empty text
      emptyRouter.executeWithFallback.mockResolvedValue({
        response: {
          content: [{ type: 'text', text: '  ' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 0 },
          model: 'test',
        },
        provider: 'test',
        attemptedProviders: ['test'],
      });

      const { queue, sendMessage } = createQueue({ router: emptyRouter });

      queue.enqueue('user1', 'Msg A');
      queue.enqueue('user1', 'Msg B');

      const handler = queue.createHandler();
      await handler('user1', 'Msg C');

      expect(sendMessage).toHaveBeenCalledWith('user1', 'Msg A\n\nMsg B\n\nMsg C');
    });
  });

  describe('queue size cap', () => {
    it('drops messages when queue is full', () => {
      const { queue } = createQueue();

      // Fill queue to MAX_QUEUE_SIZE (20)
      for (let i = 0; i < 20; i++) {
        expect(queue.enqueue('user1', `Message ${i}`)).toBe(true);
      }

      // 21st should be dropped
      expect(queue.enqueue('user1', 'Overflow message')).toBe(false);
      expect(queue.getQueueDepth()).toBe(20);
    });
  });

  describe('start/stop lifecycle', () => {
    it('starts and stops without errors', () => {
      const { queue } = createQueue();

      queue.start();
      queue.stop();

      // Double stop is safe
      queue.stop();
    });

    it('does not start twice', () => {
      const { queue } = createQueue();

      queue.start();
      queue.start(); // Should be a no-op

      queue.stop();
    });
  });
});
