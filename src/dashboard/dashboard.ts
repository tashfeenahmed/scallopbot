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

export interface CostSummary {
  daily: {
    spent: number;
    budget: number;
    percentage: number;
  };
  monthly: {
    spent: number;
    budget: number;
    percentage: number;
  };
}

export interface CostTracker {
  getDailySpend(): number;
  getMonthlySpend(): number;
  getUsageHistory(): Array<{
    date?: string;
    model?: string;
    cost: number;
    requests?: number;
  }>;
}

export interface CostDashboardOptions {
  costTracker: CostTracker;
  dailyBudget?: number;
  monthlyBudget?: number;
}

/**
 * Cost dashboard for monitoring spending
 */
export class CostDashboard {
  private costTracker: CostTracker;
  private dailyBudget: number;
  private monthlyBudget: number;

  constructor(options: CostDashboardOptions) {
    this.costTracker = options.costTracker;
    this.dailyBudget = options.dailyBudget ?? 1000; // $10 default
    this.monthlyBudget = options.monthlyBudget ?? 10000; // $100 default
  }

  getSummary(): CostSummary {
    const dailySpent = this.costTracker.getDailySpend();
    const monthlySpent = this.costTracker.getMonthlySpend();

    return {
      daily: {
        spent: dailySpent,
        budget: this.dailyBudget,
        percentage: Math.round((dailySpent / this.dailyBudget) * 100),
      },
      monthly: {
        spent: monthlySpent,
        budget: this.monthlyBudget,
        percentage: Math.round((monthlySpent / this.monthlyBudget) * 100),
      },
    };
  }

  getFormattedReport(): string {
    const summary = this.getSummary();

    const lines: string[] = [
      '╔══════════════════════════════════════╗',
      '║         LeanBot Cost Dashboard       ║',
      '╠══════════════════════════════════════╣',
      '║ Daily Spend                          ║',
      `║   ${formatCurrency(summary.daily.spent).padEnd(12)} / ${formatCurrency(summary.daily.budget).padEnd(12)} (${summary.daily.percentage}%)`.padEnd(40) + '║',
      '║                                      ║',
      '║ Monthly Spend                        ║',
      `║   ${formatCurrency(summary.monthly.spent).padEnd(12)} / ${formatCurrency(summary.monthly.budget).padEnd(12)} (${summary.monthly.percentage}%)`.padEnd(40) + '║',
      '╚══════════════════════════════════════╝',
    ];

    return lines.join('\n');
  }

  getHistoryChart(days: number): string {
    const history = this.costTracker.getUsageHistory();
    if (history.length === 0) return 'No history data';

    const maxCost = Math.max(...history.map((h) => h.cost));
    const chartHeight = 10;

    const lines: string[] = [];
    lines.push('Spending History (last ' + days + ' days)');
    lines.push('');

    for (let row = chartHeight; row >= 0; row--) {
      const threshold = (row / chartHeight) * maxCost;
      let line = row === chartHeight ? formatCurrency(maxCost).padStart(8) + ' │' : '         │';

      for (const entry of history.slice(-days)) {
        line += entry.cost >= threshold ? '█' : ' ';
      }

      lines.push(line);
    }

    lines.push('         └' + '─'.repeat(Math.min(days, history.length)));

    return lines.join('\n');
  }

  getTopModels(): Array<{ model: string; cost: number; percentage: number }> {
    const history = this.costTracker.getUsageHistory();
    const modelCosts = new Map<string, number>();

    for (const entry of history) {
      if (entry.model) {
        modelCosts.set(
          entry.model,
          (modelCosts.get(entry.model) || 0) + entry.cost
        );
      }
    }

    const total = Array.from(modelCosts.values()).reduce((a, b) => a + b, 0);

    return Array.from(modelCosts.entries())
      .map(([model, cost]) => ({
        model,
        cost,
        percentage: total > 0 ? Math.round((cost / total) * 100) : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  }
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
      // Stop service
      await this.exec(`sudo systemctl stop ${this.serviceName}`).catch(() => {});

      // Disable service
      await this.exec(`sudo systemctl disable ${this.serviceName}`).catch(() => {});

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
