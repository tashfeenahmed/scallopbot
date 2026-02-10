import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DaemonManager,
  CrashRecovery,
  formatCurrency,
  formatDuration,
  SystemdConfig,
} from './dashboard.js';
import type { Logger } from 'pino';

describe('formatCurrency', () => {
  it('should format cents to dollars', () => {
    expect(formatCurrency(100)).toBe('$1.00');
    expect(formatCurrency(1550)).toBe('$15.50');
  });

  it('should handle zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('should handle small amounts', () => {
    expect(formatCurrency(5)).toBe('$0.05');
  });

  it('should handle large amounts', () => {
    expect(formatCurrency(123456)).toBe('$1,234.56');
  });
});

describe('formatDuration', () => {
  it('should format seconds', () => {
    expect(formatDuration(30)).toBe('30s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(90)).toBe('1m 30s');
  });

  it('should format hours', () => {
    expect(formatDuration(3661)).toBe('1h 1m 1s');
  });

  it('should format days', () => {
    expect(formatDuration(86400 + 3600)).toBe('1d 1h 0m 0s');
  });
});

describe('SystemdConfig', () => {
  describe('generate', () => {
    it('should generate systemd unit file', () => {
      const config = SystemdConfig.generate({
        name: 'scallopbot',
        description: 'ScallopBot AI Assistant',
        execPath: '/usr/local/bin/scallopbot',
        workingDir: '/var/lib/scallopbot',
        user: 'scallopbot',
      });

      expect(config).toContain('[Unit]');
      expect(config).toContain('[Service]');
      expect(config).toContain('[Install]');
      expect(config).toContain('scallopbot');
    });

    it('should include restart policy', () => {
      const config = SystemdConfig.generate({
        name: 'scallopbot',
        description: 'Test',
        execPath: '/bin/test',
        workingDir: '/tmp',
        user: 'test',
      });

      expect(config).toContain('Restart=');
    });

    it('should include environment variables', () => {
      const config = SystemdConfig.generate({
        name: 'scallopbot',
        description: 'Test',
        execPath: '/bin/test',
        workingDir: '/tmp',
        user: 'test',
        environment: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
        },
      });

      expect(config).toContain('NODE_ENV');
      expect(config).toContain('production');
    });
  });
});

describe('DaemonManager', () => {
  let manager: DaemonManager;
  let mockLogger: Logger;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    manager = new DaemonManager({
      logger: mockLogger,
      serviceName: 'scallopbot',
      exec: mockExec,
    });
  });

  describe('install', () => {
    it('should install systemd service', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await manager.install({
        execPath: '/usr/local/bin/scallopbot',
        workingDir: '/var/lib/scallopbot',
        user: 'scallopbot',
      });

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });

    it('should handle installation failure', async () => {
      mockExec.mockRejectedValue(new Error('Permission denied'));

      const result = await manager.install({
        execPath: '/usr/local/bin/scallopbot',
        workingDir: '/var/lib/scallopbot',
        user: 'scallopbot',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });
  });

  describe('uninstall', () => {
    it('should uninstall systemd service', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await manager.uninstall();

      expect(result.success).toBe(true);
    });
  });

  describe('status', () => {
    it('should return service status', async () => {
      mockExec.mockResolvedValue({
        stdout: 'active (running)',
        stderr: '',
      });

      const status = await manager.status();

      expect(status.running).toBe(true);
    });

    it('should handle inactive service', async () => {
      mockExec.mockResolvedValue({
        stdout: 'inactive (dead)',
        stderr: '',
      });

      const status = await manager.status();

      expect(status.running).toBe(false);
    });
  });

  describe('start/stop/restart', () => {
    it('should start service', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await manager.start();

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('start'));
    });

    it('should stop service', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await manager.stop();

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('stop'));
    });

    it('should restart service', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await manager.restart();

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('restart'));
    });
  });
});

describe('CrashRecovery', () => {
  let recovery: CrashRecovery;
  let mockLogger: Logger;
  let mockFs: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    mockFs = {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
    };

    recovery = new CrashRecovery({
      logger: mockLogger,
      stateDir: '/var/lib/scallopbot',
      fs: mockFs as any,
    });
  });

  describe('saveState', () => {
    it('should save current state to disk', async () => {
      await recovery.saveState({
        sessionId: 'session-123',
        lastMessage: 'Processing request...',
        timestamp: new Date().toISOString(),
      });

      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('loadState', () => {
    it('should load state from disk', async () => {
      mockFs.exists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          sessionId: 'session-123',
          lastMessage: 'Processing...',
          timestamp: '2024-01-01T00:00:00Z',
        })
      );

      const state = await recovery.loadState();

      expect(state).toBeDefined();
      expect(state?.sessionId).toBe('session-123');
    });

    it('should return null if no state file', async () => {
      mockFs.exists.mockResolvedValue(false);

      const state = await recovery.loadState();

      expect(state).toBeNull();
    });
  });

  describe('clearState', () => {
    it('should remove state file', async () => {
      mockFs.exists.mockResolvedValue(true);

      await recovery.clearState();

      expect(mockFs.unlink).toHaveBeenCalled();
    });
  });

  describe('checkForCrash', () => {
    it('should detect unclean shutdown', async () => {
      mockFs.exists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          sessionId: 'session-123',
          lastMessage: 'Processing...',
          timestamp: new Date(Date.now() - 60000).toISOString(),
        })
      );

      const crashed = await recovery.checkForCrash();

      expect(crashed).toBe(true);
    });

    it('should not flag if no state file', async () => {
      mockFs.exists.mockResolvedValue(false);

      const crashed = await recovery.checkForCrash();

      expect(crashed).toBe(false);
    });
  });

  describe('getRecoveryOptions', () => {
    it('should return recovery options', async () => {
      mockFs.exists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          sessionId: 'session-123',
          lastMessage: 'Processing complex task...',
          timestamp: '2024-01-01T00:00:00Z',
        })
      );

      const options = await recovery.getRecoveryOptions();

      expect(options).toContain('resume');
      expect(options).toContain('restart');
      expect(options).toContain('abort');
    });
  });

  describe('resume', () => {
    it('should resume from saved state', async () => {
      mockFs.exists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          sessionId: 'session-123',
          lastMessage: 'Processing...',
          timestamp: '2024-01-01T00:00:00Z',
        })
      );

      const result = await recovery.resume();

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('session-123');
    });
  });
});
