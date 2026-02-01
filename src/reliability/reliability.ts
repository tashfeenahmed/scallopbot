/**
 * Reliability Features
 * Provider fallback chain, budget handling, proactive notifications
 */

import type { Logger } from 'pino';
import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
} from '../providers/types.js';

export interface ProviderHealthOptions {
  windowMs: number;
  failureThreshold: number;
}

export interface HealthStats {
  successCount: number;
  failureCount: number;
  lastSuccess?: Date;
  lastFailure?: Date;
}

/**
 * Tracks provider health based on success/failure rates
 */
export class ProviderHealth {
  private windowMs: number;
  private failureThreshold: number;
  private failures: Map<string, number[]> = new Map();
  private successes: Map<string, number[]> = new Map();

  constructor(options: ProviderHealthOptions) {
    this.windowMs = options.windowMs;
    this.failureThreshold = options.failureThreshold;
  }

  recordSuccess(provider: string): void {
    const now = Date.now();
    const list = this.successes.get(provider) || [];
    list.push(now);
    this.successes.set(provider, list);

    // Clear failures on success (provider recovered)
    this.failures.set(provider, []);
  }

  recordFailure(provider: string): void {
    const now = Date.now();
    const list = this.failures.get(provider) || [];
    list.push(now);
    this.failures.set(provider, list);
  }

  isHealthy(provider: string): boolean {
    const now = Date.now();
    const failures = this.failures.get(provider) || [];

    // Count recent failures within window
    const recentFailures = failures.filter((t) => now - t < this.windowMs);

    // Update the list to only keep recent failures
    this.failures.set(provider, recentFailures);

    return recentFailures.length < this.failureThreshold;
  }

  getStats(provider: string): HealthStats {
    const now = Date.now();
    const failures = (this.failures.get(provider) || []).filter(
      (t) => now - t < this.windowMs
    );
    const successes = (this.successes.get(provider) || []).filter(
      (t) => now - t < this.windowMs
    );

    return {
      successCount: successes.length,
      failureCount: failures.length,
      lastSuccess: successes.length > 0 ? new Date(Math.max(...successes)) : undefined,
      lastFailure: failures.length > 0 ? new Date(Math.max(...failures)) : undefined,
    };
  }
}

export interface FallbackChainOptions {
  providers: Map<string, LLMProvider>;
  order: string[];
  logger: Logger;
  healthWindowMs?: number;
  failureThreshold?: number;
}

export interface ExecutionResult {
  success: boolean;
  response?: CompletionResponse;
  provider?: string;
  error?: string;
  attempts: number;
}

/**
 * Fallback chain for provider resilience
 */
export class FallbackChain {
  private providers: Map<string, LLMProvider>;
  private order: string[];
  private logger: Logger;
  private health: ProviderHealth;

  constructor(options: FallbackChainOptions) {
    this.providers = options.providers;
    this.order = options.order;
    this.logger = options.logger.child({ component: 'fallback-chain' });
    this.health = new ProviderHealth({
      windowMs: options.healthWindowMs ?? 300000, // 5 minutes
      failureThreshold: options.failureThreshold ?? 3,
    });
  }

  async execute(request: CompletionRequest): Promise<ExecutionResult> {
    let attempts = 0;
    const errors: string[] = [];

    for (const providerName of this.order) {
      // Skip unhealthy providers
      if (!this.health.isHealthy(providerName)) {
        this.logger.debug({ provider: providerName }, 'Skipping unhealthy provider');
        continue;
      }

      const provider = this.providers.get(providerName);
      if (!provider || !provider.isAvailable()) {
        continue;
      }

      attempts++;

      try {
        this.logger.debug({ provider: providerName }, 'Trying provider');

        const response = await provider.complete(request);

        this.health.recordSuccess(providerName);

        this.logger.info(
          { provider: providerName, attempts },
          'Request succeeded'
        );

        return {
          success: true,
          response,
          provider: providerName,
          attempts,
        };
      } catch (error) {
        const err = error as Error;
        errors.push(`${providerName}: ${err.message}`);

        this.health.recordFailure(providerName);

        this.logger.warn(
          { provider: providerName, error: err.message },
          'Provider failed, trying next'
        );
      }
    }

    this.logger.error({ attempts, errors }, 'All providers failed');

    return {
      success: false,
      error: `All providers failed: ${errors.join('; ')}`,
      attempts,
    };
  }

  getHealthStatus(): Map<string, HealthStats> {
    const status = new Map<string, HealthStats>();
    for (const name of this.order) {
      status.set(name, this.health.getStats(name));
    }
    return status;
  }
}

export interface CostTracker {
  getDailySpend(): number;
  getMonthlySpend(): number;
  recordUsage(params: {
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

export interface BudgetGuardOptions {
  costTracker: CostTracker;
  dailyBudget: number;
  monthlyBudget: number;
  warningThreshold: number;
  logger: Logger;
}

export interface ProceedResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export interface CostEstimateParams {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Model pricing in cents per 1M tokens
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4': { input: 3000, output: 6000 },
  'gpt-4-turbo': { input: 1000, output: 3000 },
  'gpt-3.5-turbo': { input: 50, output: 150 },
  'claude-3-opus': { input: 1500, output: 7500 },
  'claude-3-sonnet': { input: 300, output: 1500 },
  'claude-3-haiku': { input: 25, output: 125 },
  default: { input: 100, output: 300 },
};

/**
 * Budget guard with hard stops and warnings
 */
export class BudgetGuard {
  private costTracker: CostTracker;
  private dailyBudget: number;
  private monthlyBudget: number;
  private warningThreshold: number;
  private logger: Logger;

  constructor(options: BudgetGuardOptions) {
    this.costTracker = options.costTracker;
    this.dailyBudget = options.dailyBudget;
    this.monthlyBudget = options.monthlyBudget;
    this.warningThreshold = options.warningThreshold;
    this.logger = options.logger.child({ component: 'budget-guard' });
  }

  canProceed(estimatedCost: number): ProceedResult {
    const dailySpend = this.costTracker.getDailySpend();
    const monthlySpend = this.costTracker.getMonthlySpend();

    // Check daily budget
    if (dailySpend + estimatedCost > this.dailyBudget) {
      this.logger.warn({ dailySpend, estimatedCost }, 'Daily budget exceeded');
      return {
        allowed: false,
        reason: `Daily budget exceeded (${dailySpend}/${this.dailyBudget} cents)`,
      };
    }

    // Check monthly budget
    if (monthlySpend + estimatedCost > this.monthlyBudget) {
      this.logger.warn({ monthlySpend, estimatedCost }, 'Monthly budget exceeded');
      return {
        allowed: false,
        reason: `Monthly budget exceeded (${monthlySpend}/${this.monthlyBudget} cents)`,
      };
    }

    // Check for warnings
    const dailyUsage = dailySpend / this.dailyBudget;
    const monthlyUsage = monthlySpend / this.monthlyBudget;

    if (dailyUsage >= this.warningThreshold) {
      return {
        allowed: true,
        warning: `Daily budget ${Math.round(dailyUsage * 100)}% used`,
      };
    }

    if (monthlyUsage >= this.warningThreshold) {
      return {
        allowed: true,
        warning: `Monthly budget ${Math.round(monthlyUsage * 100)}% used`,
      };
    }

    return { allowed: true };
  }

  estimateCost(params: CostEstimateParams): number {
    const pricing = MODEL_PRICING[params.model] || MODEL_PRICING.default;

    const inputCost = (params.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (params.outputTokens / 1_000_000) * pricing.output;

    return Math.ceil(inputCost + outputCost);
  }
}

export interface QueuedTask {
  id: string;
  request: CompletionRequest;
  priority: number;
  enqueuedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface TaskQueueOptions {
  maxSize: number;
  logger: Logger;
}

/**
 * Priority queue for budget-exhausted tasks
 */
export class TaskQueue {
  private tasks: QueuedTask[] = [];
  private maxSize: number;
  private logger: Logger;

  constructor(options: TaskQueueOptions) {
    this.maxSize = options.maxSize;
    this.logger = options.logger.child({ component: 'task-queue' });
  }

  enqueue(task: QueuedTask): void {
    if (this.tasks.length >= this.maxSize) {
      throw new Error('Task queue is full');
    }

    task.enqueuedAt = new Date();
    this.tasks.push(task);

    // Sort by priority (highest first)
    this.tasks.sort((a, b) => b.priority - a.priority);

    this.logger.debug({ taskId: task.id, priority: task.priority }, 'Task enqueued');
  }

  dequeue(): QueuedTask | undefined {
    const task = this.tasks.shift();
    if (task) {
      this.logger.debug({ taskId: task.id }, 'Task dequeued');
    }
    return task;
  }

  peek(): QueuedTask | undefined {
    return this.tasks[0];
  }

  remove(taskId: string): boolean {
    const index = this.tasks.findIndex((t) => t.id === taskId);
    if (index !== -1) {
      this.tasks.splice(index, 1);
      return true;
    }
    return false;
  }

  size(): number {
    return this.tasks.length;
  }

  clear(): void {
    this.tasks = [];
  }

  getAll(): QueuedTask[] {
    return [...this.tasks];
  }
}

export type NotificationType = 'error' | 'warning' | 'info' | 'success';

export interface Notification {
  type: NotificationType;
  message: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

export type NotifyFunction = (notification: Notification) => Promise<void>;

export interface NotificationManagerOptions {
  logger: Logger;
  notifiers: Map<string, NotifyFunction>;
  rateLimitMs?: number;
}

export interface NotifyParams {
  type: NotificationType;
  message: string;
  channels: string[];
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

/**
 * Proactive notification manager
 */
export class NotificationManager {
  private logger: Logger;
  private notifiers: Map<string, NotifyFunction>;
  private rateLimitMs: number;
  private lastNotified: Map<string, number> = new Map();

  constructor(options: NotificationManagerOptions) {
    this.logger = options.logger.child({ component: 'notifications' });
    this.notifiers = options.notifiers;
    this.rateLimitMs = options.rateLimitMs ?? 60000; // 1 minute default
  }

  async notify(params: NotifyParams): Promise<void> {
    // Check rate limiting
    if (params.dedupeKey) {
      const lastTime = this.lastNotified.get(params.dedupeKey);
      if (lastTime && Date.now() - lastTime < this.rateLimitMs) {
        this.logger.debug({ dedupeKey: params.dedupeKey }, 'Notification rate limited');
        return;
      }
      this.lastNotified.set(params.dedupeKey, Date.now());
    }

    const notification: Notification = {
      type: params.type,
      message: params.message,
      timestamp: new Date(),
      metadata: params.metadata,
    };

    for (const channel of params.channels) {
      const notifier = this.notifiers.get(channel);
      if (!notifier) {
        this.logger.warn({ channel }, 'Unknown notification channel');
        continue;
      }

      try {
        await notifier(notification);
        this.logger.debug({ channel, type: params.type }, 'Notification sent');
      } catch (error) {
        this.logger.error(
          { channel, error: (error as Error).message },
          'Failed to send notification'
        );
      }
    }
  }

  async notifyError(message: string, channels: string[]): Promise<void> {
    await this.notify({
      type: 'error',
      message: `Error: ${message}`,
      channels,
      dedupeKey: `error:${message}`,
    });
  }

  async notifyBudgetWarning(
    usage: { daily: number; monthly: number },
    channels: string[]
  ): Promise<void> {
    await this.notify({
      type: 'warning',
      message: `Budget warning: Daily ${usage.daily}%, Monthly ${usage.monthly}%`,
      channels,
      metadata: usage,
      dedupeKey: 'budget-warning',
    });
  }

  async notifyCompletion(
    message: string,
    metadata: Record<string, unknown>,
    channels: string[]
  ): Promise<void> {
    await this.notify({
      type: 'success',
      message,
      channels,
      metadata,
    });
  }
}
