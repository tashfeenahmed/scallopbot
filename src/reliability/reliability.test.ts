import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FallbackChain,
  BudgetGuard,
  TaskQueue,
  NotificationManager,
  ProviderHealth,
  NotificationType,
} from './reliability.js';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../providers/types.js';
import type { Logger } from 'pino';

describe('ProviderHealth', () => {
  let health: ProviderHealth;

  beforeEach(() => {
    vi.useFakeTimers();
    health = new ProviderHealth({ windowMs: 60000, failureThreshold: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordSuccess', () => {
    it('should mark provider as healthy after success', () => {
      health.recordFailure('openai');
      health.recordFailure('openai');
      health.recordSuccess('openai');

      expect(health.isHealthy('openai')).toBe(true);
    });
  });

  describe('recordFailure', () => {
    it('should mark provider as unhealthy after threshold failures', () => {
      health.recordFailure('openai');
      health.recordFailure('openai');
      health.recordFailure('openai');

      expect(health.isHealthy('openai')).toBe(false);
    });

    it('should not mark unhealthy before threshold', () => {
      health.recordFailure('openai');
      health.recordFailure('openai');

      expect(health.isHealthy('openai')).toBe(true);
    });
  });

  describe('failure window', () => {
    it('should reset failures after window expires', () => {
      health.recordFailure('openai');
      health.recordFailure('openai');
      health.recordFailure('openai');

      expect(health.isHealthy('openai')).toBe(false);

      // Advance past window
      vi.advanceTimersByTime(61000);

      expect(health.isHealthy('openai')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return health statistics', () => {
      health.recordSuccess('openai');
      health.recordSuccess('openai');
      health.recordFailure('openai');

      const stats = health.getStats('openai');

      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
    });
  });
});

describe('FallbackChain', () => {
  let chain: FallbackChain;
  let mockProviders: Map<string, LLMProvider>;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    const createMockProvider = (name: string, shouldFail: boolean): LLMProvider => ({
      name,
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(async () => {
        if (shouldFail) throw new Error(`${name} failed`);
        return {
          content: [{ type: 'text', text: `Response from ${name}` }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 20 },
          model: name,
        } as CompletionResponse;
      }),
    });

    mockProviders = new Map([
      ['primary', createMockProvider('primary', false)],
      ['secondary', createMockProvider('secondary', false)],
      ['fallback', createMockProvider('fallback', false)],
    ]);

    chain = new FallbackChain({
      providers: mockProviders,
      order: ['primary', 'secondary', 'fallback'],
      logger: mockLogger,
    });
  });

  describe('execute', () => {
    it('should use primary provider when healthy', async () => {
      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await chain.execute(request);

      expect(result.success).toBe(true);
      expect(result.provider).toBe('primary');
    });

    it('should fallback to secondary when primary fails', async () => {
      const failingProvider = mockProviders.get('primary')!;
      (failingProvider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Primary failed')
      );

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await chain.execute(request);

      expect(result.success).toBe(true);
      expect(result.provider).toBe('secondary');
    });

    it('should try all providers in order', async () => {
      (mockProviders.get('primary')!.complete as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed')
      );
      (mockProviders.get('secondary')!.complete as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed')
      );

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await chain.execute(request);

      expect(result.success).toBe(true);
      expect(result.provider).toBe('fallback');
    });

    it('should fail if all providers fail', async () => {
      for (const provider of mockProviders.values()) {
        (provider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('Failed')
        );
      }

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await chain.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('health tracking', () => {
    it('should skip unhealthy providers', async () => {
      // Make primary fail repeatedly to mark as unhealthy
      const primary = mockProviders.get('primary')!;
      (primary.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Failed'));

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      // First few requests will try primary and fail
      for (let i = 0; i < 3; i++) {
        await chain.execute(request);
      }

      // Now primary should be skipped
      const result = await chain.execute(request);

      expect(result.provider).toBe('secondary');
      // Primary should have been tried only during initial failures
    });
  });
});

describe('BudgetGuard', () => {
  let guard: BudgetGuard;
  let mockCostTracker: {
    getDailySpend: ReturnType<typeof vi.fn>;
    getMonthlySpend: ReturnType<typeof vi.fn>;
    recordUsage: ReturnType<typeof vi.fn>;
  };
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    mockCostTracker = {
      getDailySpend: vi.fn().mockReturnValue(0),
      getMonthlySpend: vi.fn().mockReturnValue(0),
      recordUsage: vi.fn(),
    };

    guard = new BudgetGuard({
      costTracker: mockCostTracker as any,
      dailyBudget: 1000, // $10
      monthlyBudget: 10000, // $100
      warningThreshold: 0.75,
      logger: mockLogger,
    });
  });

  describe('canProceed', () => {
    it('should allow requests under budget', () => {
      mockCostTracker.getDailySpend.mockReturnValue(500);
      mockCostTracker.getMonthlySpend.mockReturnValue(5000);

      const result = guard.canProceed(100);

      expect(result.allowed).toBe(true);
    });

    it('should block requests over daily budget', () => {
      mockCostTracker.getDailySpend.mockReturnValue(950);

      const result = guard.canProceed(100);

      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain('daily');
    });

    it('should block requests over monthly budget', () => {
      mockCostTracker.getDailySpend.mockReturnValue(100);
      mockCostTracker.getMonthlySpend.mockReturnValue(9950);

      const result = guard.canProceed(100);

      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain('monthly');
    });

    it('should warn when approaching threshold', () => {
      mockCostTracker.getDailySpend.mockReturnValue(760);

      const result = guard.canProceed(10);

      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost for request', () => {
      const estimate = guard.estimateCost({
        model: 'gpt-4',
        inputTokens: 1000,
        outputTokens: 500,
      });

      expect(estimate).toBeGreaterThan(0);
    });
  });
});

describe('TaskQueue', () => {
  let queue: TaskQueue;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();

    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    queue = new TaskQueue({
      maxSize: 100,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueue', () => {
    it('should add task to queue', () => {
      const task = {
        id: 'task-1',
        request: { messages: [{ role: 'user' as const, content: 'Hello' }] },
        priority: 1,
      };

      queue.enqueue(task);

      expect(queue.size()).toBe(1);
    });

    it('should reject when queue is full', () => {
      const smallQueue = new TaskQueue({ maxSize: 2, logger: mockLogger });

      smallQueue.enqueue({ id: '1', request: { messages: [] }, priority: 1 });
      smallQueue.enqueue({ id: '2', request: { messages: [] }, priority: 1 });

      expect(() => {
        smallQueue.enqueue({ id: '3', request: { messages: [] }, priority: 1 });
      }).toThrow();
    });
  });

  describe('dequeue', () => {
    it('should return highest priority task', () => {
      queue.enqueue({ id: 'low', request: { messages: [] }, priority: 1 });
      queue.enqueue({ id: 'high', request: { messages: [] }, priority: 10 });
      queue.enqueue({ id: 'medium', request: { messages: [] }, priority: 5 });

      const task = queue.dequeue();

      expect(task?.id).toBe('high');
    });

    it('should return undefined when empty', () => {
      const task = queue.dequeue();

      expect(task).toBeUndefined();
    });
  });

  describe('peek', () => {
    it('should return next task without removing', () => {
      queue.enqueue({ id: 'task-1', request: { messages: [] }, priority: 1 });

      const peeked = queue.peek();
      const size = queue.size();

      expect(peeked?.id).toBe('task-1');
      expect(size).toBe(1);
    });
  });

  describe('remove', () => {
    it('should remove specific task by id', () => {
      queue.enqueue({ id: 'task-1', request: { messages: [] }, priority: 1 });
      queue.enqueue({ id: 'task-2', request: { messages: [] }, priority: 1 });

      const removed = queue.remove('task-1');

      expect(removed).toBe(true);
      expect(queue.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all tasks', () => {
      queue.enqueue({ id: 'task-1', request: { messages: [] }, priority: 1 });
      queue.enqueue({ id: 'task-2', request: { messages: [] }, priority: 1 });

      queue.clear();

      expect(queue.size()).toBe(0);
    });
  });
});

describe('NotificationManager', () => {
  let manager: NotificationManager;
  let mockLogger: Logger;
  let mockNotifiers: Map<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    mockNotifiers = new Map([
      ['telegram', vi.fn().mockResolvedValue(undefined)],
      ['discord', vi.fn().mockResolvedValue(undefined)],
    ]);

    manager = new NotificationManager({
      logger: mockLogger,
      notifiers: mockNotifiers as any,
    });
  });

  describe('notify', () => {
    it('should send notification to all channels', async () => {
      await manager.notify({
        type: 'error',
        message: 'Something went wrong',
        channels: ['telegram', 'discord'],
      });

      expect(mockNotifiers.get('telegram')).toHaveBeenCalled();
      expect(mockNotifiers.get('discord')).toHaveBeenCalled();
    });

    it('should skip unknown channels', async () => {
      await manager.notify({
        type: 'info',
        message: 'Test',
        channels: ['unknown'],
      });

      // Should not throw
    });
  });

  describe('notifyError', () => {
    it('should send error notification', async () => {
      await manager.notifyError('Connection failed', ['telegram']);

      expect(mockNotifiers.get('telegram')).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Connection failed'),
        })
      );
    });
  });

  describe('notifyBudgetWarning', () => {
    it('should send budget warning notification', async () => {
      await manager.notifyBudgetWarning(
        { daily: 80, monthly: 50 },
        ['telegram']
      );

      expect(mockNotifiers.get('telegram')).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
        })
      );
    });
  });

  describe('notifyCompletion', () => {
    it('should send completion notification', async () => {
      await manager.notifyCompletion('Task completed', { taskId: '123' }, ['telegram']);

      expect(mockNotifiers.get('telegram')).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
        })
      );
    });
  });

  describe('rate limiting', () => {
    it('should not spam notifications', async () => {
      // Send multiple notifications quickly
      for (let i = 0; i < 10; i++) {
        await manager.notify({
          type: 'error',
          message: 'Same error',
          channels: ['telegram'],
          dedupeKey: 'same-error',
        });
      }

      // Should be rate limited to fewer calls
      expect(mockNotifiers.get('telegram')).toHaveBeenCalledTimes(1);
    });
  });
});
