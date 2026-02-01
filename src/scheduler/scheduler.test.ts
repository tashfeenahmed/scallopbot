import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CronScheduler,
  ScheduledJob,
  JobAction,
  BuiltInActions,
  parseCronExpression,
  getNextRun,
} from './scheduler.js';
import type { Logger } from 'pino';

describe('parseCronExpression', () => {
  it('should parse valid cron expression', () => {
    const result = parseCronExpression('*/5 * * * *');
    expect(result.valid).toBe(true);
  });

  it('should reject invalid cron expression', () => {
    const result = parseCronExpression('invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should parse every minute expression', () => {
    const result = parseCronExpression('* * * * *');
    expect(result.valid).toBe(true);
  });

  it('should parse every hour expression', () => {
    const result = parseCronExpression('0 * * * *');
    expect(result.valid).toBe(true);
  });

  it('should parse daily expression', () => {
    const result = parseCronExpression('0 0 * * *');
    expect(result.valid).toBe(true);
  });

  it('should parse weekly expression', () => {
    const result = parseCronExpression('0 0 * * 0');
    expect(result.valid).toBe(true);
  });

  it('should handle shorthand expressions', () => {
    expect(parseCronExpression('@hourly').valid).toBe(true);
    expect(parseCronExpression('@daily').valid).toBe(true);
    expect(parseCronExpression('@weekly').valid).toBe(true);
    expect(parseCronExpression('@monthly').valid).toBe(true);
  });
});

describe('getNextRun', () => {
  it('should calculate next run time', () => {
    const now = new Date('2024-01-01T00:00:00Z');
    const next = getNextRun('0 * * * *', now); // Every hour

    expect(next).toBeInstanceOf(Date);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('should handle every minute', () => {
    const now = new Date('2024-01-01T00:00:30Z');
    const next = getNextRun('* * * * *', now);

    expect(next.getMinutes()).toBe(now.getMinutes() + 1);
  });
});

describe('BuiltInActions', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;
  });

  describe('ping', () => {
    it('should return pong with timestamp', async () => {
      const result = await BuiltInActions.ping({ logger: mockLogger });

      expect(result.success).toBe(true);
      expect(result.message).toContain('pong');
    });
  });

  describe('status', () => {
    it('should return system status', async () => {
      const result = await BuiltInActions.status({ logger: mockLogger });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.uptime).toBeDefined();
      expect(result.data.memory).toBeDefined();
    });
  });

  describe('backup', () => {
    it('should perform backup action', async () => {
      const mockBackupFn = vi.fn().mockResolvedValue({ files: 3, size: 1024 });

      const result = await BuiltInActions.backup({
        logger: mockLogger,
        backupFn: mockBackupFn,
        targetDir: '/backups',
      });

      expect(result.success).toBe(true);
      expect(mockBackupFn).toHaveBeenCalled();
    });

    it('should handle backup failure', async () => {
      const mockBackupFn = vi.fn().mockRejectedValue(new Error('Disk full'));

      const result = await BuiltInActions.backup({
        logger: mockLogger,
        backupFn: mockBackupFn,
        targetDir: '/backups',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Disk full');
    });
  });
});

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
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

    scheduler = new CronScheduler({ logger: mockLogger });
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  describe('schedule', () => {
    it('should schedule a job', () => {
      const action: JobAction = {
        type: 'custom',
        handler: vi.fn().mockResolvedValue({ success: true }),
      };

      const job = scheduler.schedule({
        name: 'test-job',
        cron: '*/5 * * * *',
        action,
      });

      expect(job.id).toBeDefined();
      expect(job.name).toBe('test-job');
      expect(scheduler.getJob(job.id)).toBeDefined();
    });

    it('should reject invalid cron expression', () => {
      const action: JobAction = {
        type: 'custom',
        handler: vi.fn(),
      };

      expect(() =>
        scheduler.schedule({
          name: 'invalid',
          cron: 'bad cron',
          action,
        })
      ).toThrow();
    });

    it('should schedule built-in ping action', () => {
      const job = scheduler.schedule({
        name: 'heartbeat',
        cron: '* * * * *',
        action: { type: 'ping' },
      });

      expect(job).toBeDefined();
    });

    it('should schedule built-in status action', () => {
      const job = scheduler.schedule({
        name: 'status-check',
        cron: '0 * * * *',
        action: { type: 'status' },
      });

      expect(job).toBeDefined();
    });
  });

  describe('job execution', () => {
    it('should execute job at scheduled time', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });

      scheduler.schedule({
        name: 'exec-test',
        cron: '* * * * *', // Every minute
        action: { type: 'custom', handler },
      });

      scheduler.start();

      // Advance time by 1 minute
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(handler).toHaveBeenCalled();
    });

    it('should track execution history', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, message: 'done' });

      const job = scheduler.schedule({
        name: 'history-test',
        cron: '* * * * *',
        action: { type: 'custom', handler },
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      const history = scheduler.getJobHistory(job.id);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].success).toBe(true);
    });

    it('should handle execution errors', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Job failed'));

      const job = scheduler.schedule({
        name: 'error-test',
        cron: '* * * * *',
        action: { type: 'custom', handler },
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      const history = scheduler.getJobHistory(job.id);
      expect(history[0].success).toBe(false);
      expect(history[0].error).toContain('Job failed');
    });
  });

  describe('job management', () => {
    it('should pause a job', () => {
      const job = scheduler.schedule({
        name: 'pause-test',
        cron: '* * * * *',
        action: { type: 'ping' },
      });

      scheduler.pauseJob(job.id);

      const updated = scheduler.getJob(job.id);
      expect(updated?.paused).toBe(true);
    });

    it('should resume a paused job', () => {
      const job = scheduler.schedule({
        name: 'resume-test',
        cron: '* * * * *',
        action: { type: 'ping' },
      });

      scheduler.pauseJob(job.id);
      scheduler.resumeJob(job.id);

      const updated = scheduler.getJob(job.id);
      expect(updated?.paused).toBe(false);
    });

    it('should remove a job', () => {
      const job = scheduler.schedule({
        name: 'remove-test',
        cron: '* * * * *',
        action: { type: 'ping' },
      });

      scheduler.removeJob(job.id);

      expect(scheduler.getJob(job.id)).toBeUndefined();
    });

    it('should list all jobs', () => {
      scheduler.schedule({
        name: 'job1',
        cron: '* * * * *',
        action: { type: 'ping' },
      });
      scheduler.schedule({
        name: 'job2',
        cron: '0 * * * *',
        action: { type: 'status' },
      });

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
    });
  });

  describe('channel notifications', () => {
    it('should send notification to specified channel', async () => {
      const notifyFn = vi.fn().mockResolvedValue(undefined);

      scheduler.registerNotifier('telegram', notifyFn);

      scheduler.schedule({
        name: 'notify-test',
        cron: '* * * * *',
        action: { type: 'ping' },
        notifyChannels: ['telegram'],
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(notifyFn).toHaveBeenCalled();
    });

    it('should support multiple notification channels', async () => {
      const telegramNotify = vi.fn().mockResolvedValue(undefined);
      const discordNotify = vi.fn().mockResolvedValue(undefined);

      scheduler.registerNotifier('telegram', telegramNotify);
      scheduler.registerNotifier('discord', discordNotify);

      scheduler.schedule({
        name: 'multi-notify',
        cron: '* * * * *',
        action: { type: 'ping' },
        notifyChannels: ['telegram', 'discord'],
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(telegramNotify).toHaveBeenCalled();
      expect(discordNotify).toHaveBeenCalled();
    });

    it('should only notify on failure if configured', async () => {
      const notifyFn = vi.fn().mockResolvedValue(undefined);
      const handler = vi.fn().mockResolvedValue({ success: true });

      scheduler.registerNotifier('telegram', notifyFn);

      scheduler.schedule({
        name: 'notify-failure-only',
        cron: '* * * * *',
        action: { type: 'custom', handler },
        notifyChannels: ['telegram'],
        notifyOnlyOnFailure: true,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(notifyFn).not.toHaveBeenCalled();
    });

    it('should notify on failure when configured', async () => {
      const notifyFn = vi.fn().mockResolvedValue(undefined);
      const handler = vi.fn().mockRejectedValue(new Error('Failed'));

      scheduler.registerNotifier('telegram', notifyFn);

      scheduler.schedule({
        name: 'notify-on-fail',
        cron: '* * * * *',
        action: { type: 'custom', handler },
        notifyChannels: ['telegram'],
        notifyOnlyOnFailure: true,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(notifyFn).toHaveBeenCalled();
    });
  });

  describe('scheduler lifecycle', () => {
    it('should start the scheduler', () => {
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
    });

    it('should stop the scheduler', () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should stop all jobs on stopAll', () => {
      scheduler.schedule({
        name: 'job1',
        cron: '* * * * *',
        action: { type: 'ping' },
      });
      scheduler.schedule({
        name: 'job2',
        cron: '* * * * *',
        action: { type: 'status' },
      });

      scheduler.start();
      scheduler.stopAll();

      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });
});
