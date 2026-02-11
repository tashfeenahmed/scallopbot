/**
 * Dashboard & Deployment
 * Cost dashboard CLI, systemd integration, crash recovery
 */

import type { Logger } from 'pino';

/**
 * Format cents to currency string
 */
export function formatCurrency(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/**
 * Format seconds to duration string
 */
export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

export interface SystemdConfigOptions {
  name: string;
  description: string;
  execPath: string;
  workingDir: string;
  user: string;
  group?: string;
  environment?: Record<string, string>;
  restartPolicy?: 'always' | 'on-failure' | 'no';
  restartSec?: number;
}

/**
 * Systemd service configuration generator
 */
export const SystemdConfig = {
  generate(options: SystemdConfigOptions): string {
    const envLines = options.environment
      ? Object.entries(options.environment)
          .map(([key, value]) => `Environment="${key}=${value}"`)
          .join('\n')
      : '';

    return `[Unit]
Description=${options.description}
After=network.target

[Service]
Type=simple
User=${options.user}
Group=${options.group || options.user}
WorkingDirectory=${options.workingDir}
ExecStart=${options.execPath} start
Restart=${options.restartPolicy || 'on-failure'}
RestartSec=${options.restartSec || 5}
${envLines}

[Install]
WantedBy=multi-user.target
`;
  },
};

export interface DaemonManagerOptions {
  logger: Logger;
  serviceName: string;
  exec: (command: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface ServiceStatus {
  running: boolean;
  uptime?: number;
  pid?: number;
  memory?: number;
}

export interface OperationResult {
  success: boolean;
  error?: string;
}

/**
 * Daemon manager for systemd integration
 */
export class DaemonManager {
  private logger: Logger;
  private serviceName: string;
  private exec: (command: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: DaemonManagerOptions) {
    this.logger = options.logger.child({ component: 'daemon' });
    this.serviceName = options.serviceName;
    this.exec = options.exec;
  }

  async install(config: {
    execPath: string;
    workingDir: string;
    user: string;
    environment?: Record<string, string>;
  }): Promise<OperationResult> {
    try {
      const unitContent = SystemdConfig.generate({
        name: this.serviceName,
        description: `${this.serviceName} AI Assistant`,
        execPath: config.execPath,
        workingDir: config.workingDir,
        user: config.user,
        environment: config.environment,
      });

      // Write unit file
      await this.exec(
        `echo '${unitContent.replace(/'/g, "'\\''")}' | sudo tee /etc/systemd/system/${this.serviceName}.service`
      );

      // Reload systemd
      await this.exec('sudo systemctl daemon-reload');

      // Enable service
      await this.exec(`sudo systemctl enable ${this.serviceName}`);

      this.logger.info('Service installed successfully');

      return { success: true };
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message }, 'Failed to install service');
      return { success: false, error: err.message };
    }
  }

  async uninstall(): Promise<OperationResult> {
    try {
      // Stop service (may fail if not running)
      await this.exec(`sudo systemctl stop ${this.serviceName}`).catch((err) => {
        this.logger.warn({ error: (err as Error).message }, 'Failed to stop service (may not be running)');
      });

      // Disable service (may fail if not enabled)
      await this.exec(`sudo systemctl disable ${this.serviceName}`).catch((err) => {
        this.logger.warn({ error: (err as Error).message }, 'Failed to disable service (may not be enabled)');
      });

      // Remove unit file
      await this.exec(`sudo rm /etc/systemd/system/${this.serviceName}.service`);

      // Reload systemd
      await this.exec('sudo systemctl daemon-reload');

      this.logger.info('Service uninstalled successfully');

      return { success: true };
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message }, 'Failed to uninstall service');
      return { success: false, error: err.message };
    }
  }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await this.exec(
        `systemctl is-active ${this.serviceName}`
      );

      const running = stdout.trim() === 'active' || stdout.includes('running');

      return { running };
    } catch {
      return { running: false };
    }
  }

  async start(): Promise<OperationResult> {
    try {
      await this.exec(`sudo systemctl start ${this.serviceName}`);
      this.logger.info('Service started');
      return { success: true };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  }

  async stop(): Promise<OperationResult> {
    try {
      await this.exec(`sudo systemctl stop ${this.serviceName}`);
      this.logger.info('Service stopped');
      return { success: true };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  }

  async restart(): Promise<OperationResult> {
    try {
      await this.exec(`sudo systemctl restart ${this.serviceName}`);
      this.logger.info('Service restarted');
      return { success: true };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  }
}

export interface CrashState {
  sessionId: string;
  lastMessage: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
}

export interface CrashRecoveryOptions {
  logger: Logger;
  stateDir: string;
  fs: FileSystem;
}

export interface RecoveryResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

/**
 * Crash recovery with state persistence
 */
export class CrashRecovery {
  private logger: Logger;
  private stateDir: string;
  private fs: FileSystem;
  private stateFile: string;

  constructor(options: CrashRecoveryOptions) {
    this.logger = options.logger.child({ component: 'crash-recovery' });
    this.stateDir = options.stateDir;
    this.fs = options.fs;
    this.stateFile = `${this.stateDir}/crash-state.json`;
  }

  async saveState(state: CrashState): Promise<void> {
    try {
      await this.fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
      this.logger.debug({ sessionId: state.sessionId }, 'State saved');
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to save state');
    }
  }

  async loadState(): Promise<CrashState | null> {
    try {
      const exists = await this.fs.exists(this.stateFile);
      if (!exists) {
        return null;
      }

      const content = await this.fs.readFile(this.stateFile);
      return JSON.parse(content);
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to load state');
      return null;
    }
  }

  async clearState(): Promise<void> {
    try {
      const exists = await this.fs.exists(this.stateFile);
      if (exists) {
        await this.fs.unlink(this.stateFile);
        this.logger.debug('State cleared');
      }
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to clear state');
    }
  }

  async checkForCrash(): Promise<boolean> {
    const state = await this.loadState();
    return state !== null;
  }

  async getRecoveryOptions(): Promise<string[]> {
    const hasCrashState = await this.checkForCrash();
    if (!hasCrashState) {
      return [];
    }
    return ['resume', 'restart', 'abort'];
  }

  async resume(): Promise<RecoveryResult> {
    const state = await this.loadState();
    if (!state) {
      return { success: false, error: 'No crash state found' };
    }

    this.logger.info(
      { sessionId: state.sessionId },
      'Resuming from crash state'
    );

    return {
      success: true,
      sessionId: state.sessionId,
    };
  }

  async restart(): Promise<RecoveryResult> {
    await this.clearState();
    this.logger.info('Starting fresh after crash');
    return { success: true };
  }

  async abort(): Promise<RecoveryResult> {
    await this.clearState();
    this.logger.info('Aborted crash recovery');
    return { success: true };
  }
}
