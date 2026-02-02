import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

const createMockLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

describe('Tailscale Types', () => {
  it('should export tailscale types', async () => {
    const types = await import('./types.js');

    expect(types).toBeDefined();
  });
});

describe('Tailscale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isInstalled', () => {
    it('should return true when tailscale is installed', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/tailscale'));

      const { Tailscale } = await import('./tailscale.js');
      const result = await Tailscale.isInstalled();

      expect(result).toBe(true);
    });

    it('should return false when tailscale is not installed', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const { Tailscale } = await import('./tailscale.js');
      const result = await Tailscale.isInstalled();

      expect(result).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return connected status when tailscale is running', async () => {
      const mockStatus = {
        BackendState: 'Running',
        Version: '1.50.0',
        Self: {
          HostName: 'my-machine',
          DNSName: 'my-machine.tail12345.ts.net.',
          TailscaleIPs: ['100.64.0.1'],
          UserID: '12345',
          Capabilities: ['funnel'],
        },
        User: {
          '12345': { LoginName: 'user@example.com' },
        },
      };

      mockExecSync.mockReturnValue(JSON.stringify(mockStatus));

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getStatus();

      expect(status.connected).toBe(true);
      expect(status.hostname).toBe('my-machine');
      expect(status.magicDNS).toBe('my-machine.tail12345.ts.net');
      expect(status.funnelEnabled).toBe(true);
      expect(status.userLogin).toBe('user@example.com');
    });

    it('should return error when tailscale is not installed', async () => {
      mockExecSync.mockImplementation(() => {
        const error = new Error('not found');
        throw error;
      });

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getStatus();

      expect(status.connected).toBe(false);
      expect(status.error).toContain('not installed');
    });

    it('should return error when not logged in', async () => {
      mockExecSync.mockImplementation(() => {
        const error = new Error('not logged in');
        throw error;
      });

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getStatus();

      expect(status.connected).toBe(false);
      expect(status.error).toContain('Not logged in');
    });
  });

  describe('getServeStatus', () => {
    it('should return inactive when no serve configured', async () => {
      mockExecSync.mockReturnValue('{}');

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getServeStatus();

      expect(status.active).toBe(false);
    });

    it('should return active with details when serve is configured', async () => {
      const mockServeStatus = {
        Web: {
          'https://my-machine.ts.net': {
            Handlers: { '/': { Proxy: 'http://localhost:3000' } },
          },
        },
        AllowFunnel: {},
      };

      mockExecSync.mockReturnValue(JSON.stringify(mockServeStatus));

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getServeStatus();

      expect(status.active).toBe(true);
      expect(status.mode).toBe('serve');
      expect(status.urls).toContain('https://my-machine.ts.net');
    });

    it('should detect funnel mode', async () => {
      const mockServeStatus = {
        Web: {
          'https://my-machine.ts.net': {
            Handlers: { '/': { Proxy: 'http://localhost:3000' } },
          },
        },
        AllowFunnel: {
          'https://my-machine.ts.net': true,
        },
      };

      mockExecSync.mockReturnValue(JSON.stringify(mockServeStatus));

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const status = await tailscale.getServeStatus();

      expect(status.active).toBe(true);
      expect(status.mode).toBe('funnel');
    });
  });

  describe('setup', () => {
    it('should do nothing when mode is off', async () => {
      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const result = await tailscale.setup();

      expect(result.success).toBe(true);
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('tailscale serve'),
        expect.anything()
      );
    });

    it('should fail setup when not connected', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --json')) {
          throw new Error('not logged in');
        }
        return Buffer.from('');
      });

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'serve', port: 3000 });
      const result = await tailscale.setup();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not logged in');
    });
  });

  describe('reset', () => {
    it('should reset serve configuration', async () => {
      mockExecSync.mockReturnValue(Buffer.from(''));

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'serve', resetOnExit: true });

      // Simulate setup was done
      (tailscale as any).isSetup = true;

      await tailscale.reset();

      expect(mockExecSync).toHaveBeenCalledWith(
        'tailscale serve reset',
        expect.anything()
      );
    });

    it('should not reset if resetOnExit is false and not setup', async () => {
      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'serve', resetOnExit: false });

      await tailscale.reset();

      expect(mockExecSync).not.toHaveBeenCalledWith(
        'tailscale serve reset',
        expect.anything()
      );
    });
  });

  describe('getStatusString', () => {
    it('should return formatted status when connected', async () => {
      const mockStatus = {
        BackendState: 'Running',
        Version: '1.50.0',
        Self: {
          HostName: 'my-machine',
          DNSName: 'my-machine.tail12345.ts.net.',
          TailscaleIPs: ['100.64.0.1'],
          UserID: '12345',
          Capabilities: [],
        },
        User: {
          '12345': { LoginName: 'user@example.com' },
        },
      };

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --json')) {
          return JSON.stringify(mockStatus);
        }
        if (cmd.includes('serve status')) {
          return '{}';
        }
        return Buffer.from('');
      });

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const statusStr = await tailscale.getStatusString();

      expect(statusStr).toContain('Connected');
      expect(statusStr).toContain('my-machine');
      expect(statusStr).toContain('1.50.0');
    });

    it('should return error message when not connected', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const { Tailscale } = await import('./tailscale.js');
      const tailscale = new Tailscale({ mode: 'off' });
      const statusStr = await tailscale.getStatusString();

      expect(statusStr).toContain('Not connected');
    });
  });
});

describe('createTailscaleFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should create Tailscale with default mode off', async () => {
    const { createTailscaleFromEnv } = await import('./tailscale.js');
    const tailscale = createTailscaleFromEnv();

    expect(tailscale).toBeDefined();
  });

  it('should use TAILSCALE_MODE from environment', async () => {
    process.env.TAILSCALE_MODE = 'serve';
    process.env.TAILSCALE_PORT = '8080';

    const { createTailscaleFromEnv } = await import('./tailscale.js');
    const tailscale = createTailscaleFromEnv();

    expect(tailscale).toBeDefined();
    expect((tailscale as any).config.mode).toBe('serve');
    expect((tailscale as any).config.port).toBe(8080);
  });

  it('should use TAILSCALE_HOSTNAME from environment', async () => {
    process.env.TAILSCALE_HOSTNAME = 'scallopbot';

    const { createTailscaleFromEnv } = await import('./tailscale.js');
    const tailscale = createTailscaleFromEnv();

    expect((tailscale as any).config.hostname).toBe('scallopbot');
  });
});

describe('Tailscale Index Exports', () => {
  it('should export all components', async () => {
    const tailscaleModule = await import('./index.js');

    expect(tailscaleModule.Tailscale).toBeDefined();
    expect(tailscaleModule.createTailscaleFromEnv).toBeDefined();
  });
});
