/**
 * Cron Scheduler
 * Unified scheduling system with built-in actions and channel notifications
 */

import type { Logger } from 'pino';
import { nanoid } from 'nanoid';

export interface CronParseResult {
  valid: boolean;
  error?: string;
  parts?: string[];
}

/**
 * Parse and validate a cron expression
 */
export function parseCronExpression(expression: string): CronParseResult {
  // Handle shorthand expressions
  const shorthands: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
  };

  const expr = shorthands[expression] || expression;
  const parts = expr.trim().split(/\s+/);

  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Invalid cron expression: expected 5 parts, got ${parts.length}`,
    };
  }

  // Basic validation of each part
  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 6 },  // day of week
  ];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const range = ranges[i];

    if (!isValidCronPart(part, range.min, range.max)) {
      return {
        valid: false,
        error: `Invalid cron part at position ${i + 1}: ${part}`,
      };
    }
  }

  return { valid: true, parts };
}

function isValidCronPart(part: string, min: number, max: number): boolean {
  // Handle asterisk
  if (part === '*') return true;

  // Handle step values (*/5)
  if (part.startsWith('*/')) {
    const step = parseInt(part.slice(2), 10);
    return !isNaN(step) && step > 0 && step <= max;
  }

  // Handle ranges (1-5)
  if (part.includes('-')) {
    const [start, end] = part.split('-').map((n) => parseInt(n, 10));
    return !isNaN(start) && !isNaN(end) && start >= min && end <= max && start <= end;
  }

  // Handle lists (1,2,3)
  if (part.includes(',')) {
    return part.split(',').every((n) => {
      const num = parseInt(n, 10);
      return !isNaN(num) && num >= min && num <= max;
    });
  }

  // Handle single number
  const num = parseInt(part, 10);
  return !isNaN(num) && num >= min && num <= max;
}

/**
 * Get the next run time for a cron expression
 */
export function getNextRun(expression: string, from: Date = new Date()): Date {
  const shorthands: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
  };

  const expr = shorthands[expression] || expression;
  const parts = expr.split(/\s+/);
  const [minute, hour] = parts.map((p) => (p === '*' ? -1 : parseInt(p.replace('*/', ''), 10)));

  const next = new Date(from);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Simple calculation for common patterns
  if (minute === -1) {
    // Every minute
    next.setMinutes(next.getMinutes() + 1);
  } else if (parts[0].startsWith('*/')) {
    // Every N minutes
    const step = parseInt(parts[0].slice(2), 10);
    const currentMin = next.getMinutes();
    const nextMin = Math.ceil((currentMin + 1) / step) * step;
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin % 60);
    } else {
      next.setMinutes(nextMin);
    }
  } else if (hour === -1) {
    // Every hour at specific minute
    if (next.getMinutes() >= minute) {
      next.setHours(next.getHours() + 1);
    }
    next.setMinutes(minute);
  } else {
    // Specific hour and minute
    if (next.getHours() > hour || (next.getHours() === hour && next.getMinutes() >= minute)) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(hour);
    next.setMinutes(minute);
  }

  return next;
}

export interface ActionResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ActionContext {
  logger: Logger;
  [key: string]: unknown;
}

/**
 * Built-in actions for the scheduler
 */
export const BuiltInActions = {
  async ping(context: ActionContext): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    context.logger.debug('Ping action executed');
    return {
      success: true,
      message: `pong at ${timestamp}`,
    };
  },

  async status(context: ActionContext): Promise<ActionResult> {
    const uptime = process.uptime();
    const memory = process.memoryUsage();

    context.logger.debug('Status action executed');
    return {
      success: true,
      data: {
        uptime,
        memory: {
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          rss: memory.rss,
        },
        timestamp: new Date().toISOString(),
      },
    };
  },

  async backup(context: ActionContext & {
    backupFn: () => Promise<{ files: number; size: number }>;
    targetDir: string;
  }): Promise<ActionResult> {
    try {
      context.logger.info({ targetDir: context.targetDir }, 'Starting backup');
      const result = await context.backupFn();
      return {
        success: true,
        message: `Backup completed: ${result.files} files, ${result.size} bytes`,
        data: result,
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message,
      };
    }
  },
};

export type BuiltInActionType = 'ping' | 'status' | 'backup';

export interface JobAction {
  type: BuiltInActionType | 'custom';
  handler?: (context: ActionContext) => Promise<ActionResult>;
  config?: Record<string, unknown>;
}

export interface ScheduledJob {
  id: string;
  name: string;
  cron: string;
  action: JobAction;
  notifyChannels?: string[];
  notifyOnlyOnFailure?: boolean;
  paused: boolean;
  lastRun?: Date;
  nextRun?: Date;
  createdAt: Date;
}

export interface JobExecution {
  jobId: string;
  timestamp: Date;
  success: boolean;
  message?: string;
  error?: string;
  duration: number;
}

export interface ScheduleOptions {
  name: string;
  cron: string;
  action: JobAction;
  notifyChannels?: string[];
  notifyOnlyOnFailure?: boolean;
}

export type NotifyFunction = (
  jobName: string,
  result: ActionResult
) => Promise<void>;

export interface CronSchedulerOptions {
  logger: Logger;
}

export class CronScheduler {
  private logger: Logger;
  private jobs: Map<string, ScheduledJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private history: Map<string, JobExecution[]> = new Map();
  private notifiers: Map<string, NotifyFunction> = new Map();
  private running = false;

  constructor(options: CronSchedulerOptions) {
    this.logger = options.logger.child({ component: 'scheduler' });
  }

  schedule(options: ScheduleOptions): ScheduledJob {
    const parsed = parseCronExpression(options.cron);
    if (!parsed.valid) {
      throw new Error(`Invalid cron expression: ${parsed.error}`);
    }

    const job: ScheduledJob = {
      id: nanoid(),
      name: options.name,
      cron: options.cron,
      action: options.action,
      notifyChannels: options.notifyChannels,
      notifyOnlyOnFailure: options.notifyOnlyOnFailure,
      paused: false,
      nextRun: getNextRun(options.cron),
      createdAt: new Date(),
    };

    this.jobs.set(job.id, job);
    this.history.set(job.id, []);

    this.logger.info({ jobId: job.id, name: job.name, cron: job.cron }, 'Job scheduled');

    if (this.running) {
      this.scheduleNextExecution(job);
    }

    return job;
  }

  private scheduleNextExecution(job: ScheduledJob): void {
    if (job.paused) return;

    const now = new Date();
    const nextRun = getNextRun(job.cron, now);
    const delay = nextRun.getTime() - now.getTime();

    job.nextRun = nextRun;

    const timer = setTimeout(async () => {
      await this.executeJob(job);
      this.scheduleNextExecution(job);
    }, delay);

    this.timers.set(job.id, timer);
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    const startTime = Date.now();
    let result: ActionResult;

    this.logger.debug({ jobId: job.id, name: job.name }, 'Executing job');

    try {
      const context: ActionContext = {
        logger: this.logger.child({ job: job.name }),
        ...job.action.config,
      };

      switch (job.action.type) {
        case 'ping':
          result = await BuiltInActions.ping(context);
          break;
        case 'status':
          result = await BuiltInActions.status(context);
          break;
        case 'backup':
          result = await BuiltInActions.backup(context as Parameters<typeof BuiltInActions.backup>[0]);
          break;
        case 'custom':
          if (!job.action.handler) {
            throw new Error('Custom action requires handler');
          }
          result = await job.action.handler(context);
          break;
        default:
          throw new Error(`Unknown action type: ${job.action.type}`);
      }
    } catch (error) {
      const err = error as Error;
      result = {
        success: false,
        error: err.message,
      };
    }

    const duration = Date.now() - startTime;
    job.lastRun = new Date();

    // Record execution
    const execution: JobExecution = {
      jobId: job.id,
      timestamp: job.lastRun,
      success: result.success,
      message: result.message,
      error: result.error,
      duration,
    };

    const jobHistory = this.history.get(job.id) || [];
    jobHistory.unshift(execution);
    if (jobHistory.length > 100) {
      jobHistory.pop();
    }
    this.history.set(job.id, jobHistory);

    this.logger.info(
      { jobId: job.id, name: job.name, success: result.success, duration },
      'Job executed'
    );

    // Send notifications
    await this.sendNotifications(job, result);
  }

  private async sendNotifications(job: ScheduledJob, result: ActionResult): Promise<void> {
    if (!job.notifyChannels || job.notifyChannels.length === 0) {
      return;
    }

    if (job.notifyOnlyOnFailure && result.success) {
      return;
    }

    for (const channel of job.notifyChannels) {
      const notifier = this.notifiers.get(channel);
      if (notifier) {
        try {
          await notifier(job.name, result);
        } catch (error) {
          this.logger.error(
            { channel, error: (error as Error).message },
            'Failed to send notification'
          );
        }
      }
    }
  }

  registerNotifier(channel: string, fn: NotifyFunction): void {
    this.notifiers.set(channel, fn);
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  getJobHistory(id: string): JobExecution[] {
    return this.history.get(id) || [];
  }

  pauseJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.paused = true;
      const timer = this.timers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
      this.logger.info({ jobId: id }, 'Job paused');
    }
  }

  resumeJob(id: string): void {
    const job = this.jobs.get(id);
    if (job && job.paused) {
      job.paused = false;
      if (this.running) {
        this.scheduleNextExecution(job);
      }
      this.logger.info({ jobId: id }, 'Job resumed');
    }
  }

  removeJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.jobs.delete(id);
    this.history.delete(id);
    this.logger.info({ jobId: id }, 'Job removed');
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.logger.info('Scheduler started');

    for (const job of this.jobs.values()) {
      if (!job.paused) {
        this.scheduleNextExecution(job);
      }
    }
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.logger.info('Scheduler stopped');
  }

  stopAll(): void {
    this.stop();
    this.jobs.clear();
    this.history.clear();
  }

  isRunning(): boolean {
    return this.running;
  }
}
