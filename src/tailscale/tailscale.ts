/**
 * Tailscale Integration
 *
 * Provides secure remote access to ScallopBot using Tailscale.
 *
 * Modes:
 * - serve: Expose gateway to your tailnet only (private)
 * - funnel: Expose gateway to the public internet (requires password auth)
 *
 * Requirements:
 * - Tailscale CLI installed and logged in
 * - For funnel: Tailscale v1.38.3+, MagicDNS enabled, HTTPS enabled
 */

import { execSync } from 'child_process';
import type { Logger } from 'pino';
import type {
  TailscaleConfig,
  TailscaleStatus,
  ServeStatus,
  SetupResult,
} from './types.js';

/**
 * Tailscale manager for gateway integration
 */
export class Tailscale {
  private config: TailscaleConfig;
  private logger: Logger | null;
  private isSetup = false;

  constructor(config: TailscaleConfig, logger?: Logger) {
    this.config = {
      mode: config.mode,
      hostname: config.hostname,
      port: config.port ?? 3000,
      resetOnExit: config.resetOnExit ?? true,
    };
    this.logger = logger?.child({ module: 'tailscale' }) || null;
  }

  /**
   * Check if Tailscale CLI is installed
   */
  static async isInstalled(): Promise<boolean> {
    try {
      execSync('which tailscale', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Tailscale status
   */
  async getStatus(): Promise<TailscaleStatus> {
    try {
      const output = execSync('tailscale status --json', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const status = JSON.parse(output);

      // Extract relevant fields
      const self = status.Self || {};

      return {
        connected: status.BackendState === 'Running',
        version: status.Version,
        hostname: self.HostName,
        magicDNS: self.DNSName?.replace(/\.$/, ''), // Remove trailing dot
        tailscaleIPs: self.TailscaleIPs,
        funnelEnabled: self.Capabilities?.includes('funnel'),
        userLogin: status.User?.[self.UserID]?.LoginName,
      };
    } catch (error) {
      const err = error as Error;

      // Check if tailscale is not installed
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        return {
          connected: false,
          error: 'Tailscale CLI not installed. Install from https://tailscale.com/download',
        };
      }

      // Check if not logged in
      if (err.message.includes('not logged in') || err.message.includes('NeedsLogin')) {
        return {
          connected: false,
          error: 'Not logged in to Tailscale. Run: tailscale login',
        };
      }

      return {
        connected: false,
        error: `Failed to get Tailscale status: ${err.message}`,
      };
    }
  }

  /**
   * Get current serve/funnel status
   */
  async getServeStatus(): Promise<ServeStatus> {
    try {
      const output = execSync('tailscale serve status --json', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const status = JSON.parse(output);

      // Parse serve configuration
      if (status && Object.keys(status).length > 0) {
        const urls: string[] = [];
        let port: number | undefined;
        let mode: 'serve' | 'funnel' | undefined;

        // Check TCP handlers for our port
        if (status.TCP) {
          for (const [portStr, config] of Object.entries(status.TCP)) {
            if (config) {
              port = parseInt(portStr, 10);
            }
          }
        }

        // Check web handlers
        if (status.Web) {
          for (const [url, _handlers] of Object.entries(status.Web)) {
            urls.push(url);
            // Check if funnel is enabled for this URL
            if (status.AllowFunnel?.[url]) {
              mode = 'funnel';
            } else {
              mode = mode || 'serve';
            }
          }
        }

        return {
          active: urls.length > 0 || port !== undefined,
          mode,
          urls,
          port,
        };
      }

      return { active: false };
    } catch {
      return { active: false };
    }
  }

  /**
   * Setup Tailscale serve (tailnet-only access)
   */
  async setupServe(port?: number): Promise<SetupResult> {
    const targetPort = port || this.config.port || 3000;

    this.logger?.info({ port: targetPort }, 'Setting up Tailscale Serve...');

    try {
      // First check status
      const status = await this.getStatus();
      if (!status.connected) {
        return {
          success: false,
          error: status.error || 'Tailscale not connected',
        };
      }

      // Reset any existing serve config for this port
      try {
        execSync(`tailscale serve reset`, { stdio: 'ignore', timeout: 5000 });
      } catch {
        // Ignore reset errors
      }

      // Setup serve
      execSync(`tailscale serve --bg https+insecure://localhost:${targetPort}`, {
        timeout: 10000,
      });

      this.isSetup = true;

      const url = status.magicDNS
        ? `https://${status.magicDNS}`
        : `https://${status.hostname}.ts.net`;

      this.logger?.info({ url, port: targetPort }, 'Tailscale Serve configured');

      return {
        success: true,
        url,
      };
    } catch (error) {
      const err = error as Error;
      this.logger?.error({ error: err.message }, 'Failed to setup Tailscale Serve');
      return {
        success: false,
        error: `Failed to setup serve: ${err.message}`,
      };
    }
  }

  /**
   * Setup Tailscale funnel (public access)
   *
   * WARNING: Funnel exposes your service to the public internet.
   * Always use password authentication when using funnel.
   */
  async setupFunnel(port?: number): Promise<SetupResult> {
    const targetPort = port || this.config.port || 3000;

    this.logger?.info({ port: targetPort }, 'Setting up Tailscale Funnel...');

    try {
      // First check status
      const status = await this.getStatus();
      if (!status.connected) {
        return {
          success: false,
          error: status.error || 'Tailscale not connected',
        };
      }

      // Check if funnel is enabled for this node
      if (!status.funnelEnabled) {
        return {
          success: false,
          error:
            'Funnel not enabled for this node. Enable in Tailscale admin console or run: tailscale set --advertise-exit-node',
        };
      }

      // Reset any existing config
      try {
        execSync(`tailscale serve reset`, { stdio: 'ignore', timeout: 5000 });
      } catch {
        // Ignore reset errors
      }

      // Setup funnel (note: funnel implies serve)
      execSync(`tailscale funnel --bg https+insecure://localhost:${targetPort}`, {
        timeout: 10000,
      });

      this.isSetup = true;

      const url = status.magicDNS
        ? `https://${status.magicDNS}`
        : `https://${status.hostname}.ts.net`;

      this.logger?.info({ url, port: targetPort }, 'Tailscale Funnel configured');

      return {
        success: true,
        url,
      };
    } catch (error) {
      const err = error as Error;
      this.logger?.error({ error: err.message }, 'Failed to setup Tailscale Funnel');
      return {
        success: false,
        error: `Failed to setup funnel: ${err.message}`,
      };
    }
  }

  /**
   * Setup based on configured mode
   */
  async setup(): Promise<SetupResult> {
    if (this.config.mode === 'off') {
      return { success: true };
    }

    if (this.config.mode === 'serve') {
      return this.setupServe(this.config.port);
    }

    if (this.config.mode === 'funnel') {
      return this.setupFunnel(this.config.port);
    }

    return { success: false, error: `Unknown mode: ${this.config.mode}` };
  }

  /**
   * Reset/cleanup serve and funnel configuration
   */
  async reset(): Promise<void> {
    if (!this.isSetup && !this.config.resetOnExit) {
      return;
    }

    this.logger?.info('Resetting Tailscale Serve/Funnel...');

    try {
      execSync('tailscale serve reset', { timeout: 5000, stdio: 'ignore' });
      this.isSetup = false;
      this.logger?.info('Tailscale Serve/Funnel reset');
    } catch (error) {
      const err = error as Error;
      this.logger?.warn({ error: err.message }, 'Failed to reset Tailscale serve');
    }
  }

  /**
   * Get a formatted status string for display
   */
  async getStatusString(): Promise<string> {
    const status = await this.getStatus();
    const serveStatus = await this.getServeStatus();

    const lines: string[] = [];

    if (!status.connected) {
      lines.push(`Tailscale: Not connected`);
      if (status.error) {
        lines.push(`  Error: ${status.error}`);
      }
      return lines.join('\n');
    }

    lines.push(`Tailscale: Connected`);
    lines.push(`  Version: ${status.version || 'unknown'}`);
    lines.push(`  Hostname: ${status.hostname || 'unknown'}`);

    if (status.magicDNS) {
      lines.push(`  MagicDNS: ${status.magicDNS}`);
    }

    if (status.tailscaleIPs?.length) {
      lines.push(`  IPs: ${status.tailscaleIPs.join(', ')}`);
    }

    if (status.userLogin) {
      lines.push(`  User: ${status.userLogin}`);
    }

    lines.push(`  Funnel capable: ${status.funnelEnabled ? 'Yes' : 'No'}`);

    if (serveStatus.active) {
      lines.push(`  Serve mode: ${serveStatus.mode || 'active'}`);
      if (serveStatus.urls?.length) {
        lines.push(`  URLs: ${serveStatus.urls.join(', ')}`);
      }
      if (serveStatus.port) {
        lines.push(`  Port: ${serveStatus.port}`);
      }
    } else {
      lines.push(`  Serve: Not active`);
    }

    return lines.join('\n');
  }
}

/**
 * Create Tailscale instance from environment variables
 */
export function createTailscaleFromEnv(logger?: Logger): Tailscale {
  const mode = (process.env.TAILSCALE_MODE || 'off') as 'off' | 'serve' | 'funnel';
  const hostname = process.env.TAILSCALE_HOSTNAME;
  const parsedPort = process.env.TAILSCALE_PORT
    ? parseInt(process.env.TAILSCALE_PORT, 10)
    : NaN;
  const port = !isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : undefined;
  const resetOnExit = process.env.TAILSCALE_RESET_ON_EXIT !== 'false';

  return new Tailscale(
    {
      mode,
      hostname,
      port,
      resetOnExit,
    },
    logger
  );
}
