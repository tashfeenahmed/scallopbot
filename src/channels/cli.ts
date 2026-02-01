/**
 * CLI REPL Channel
 * Interactive command-line interface for LeanBot
 */

import * as readline from 'readline';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';

export interface CLIChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  enableColors?: boolean;
  showTokenUsage?: boolean;
  prompt?: string;
}

export interface CommandResult {
  command: string;
  args: string;
}

export interface HandleResult {
  shouldExit?: boolean;
}

/**
 * Parse input for commands (starting with /)
 */
export function parseCommand(input: string): CommandResult | null {
  const trimmed = input.trim();

  if (!trimmed || !trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  return { command, args };
}

/**
 * Format output text, optionally with syntax highlighting
 */
export function formatOutput(text: string, enableColors: boolean): string {
  if (!text) return '';

  // When colors are enabled, we could add syntax highlighting
  // For now, just return the text as-is
  if (enableColors) {
    // Could integrate with chalk for colors
    return text;
  }

  return text;
}

/**
 * Get help message with available commands
 */
export function getHelpMessage(): string {
  return `
LeanBot CLI Commands:

  /help     - Show this help message
  /reset    - Clear conversation history and start fresh
  /exit     - Exit the CLI
  /quit     - Exit the CLI (alias)
  /status   - Show current session status
  /model    - Show or change the current model

Just type your message and press Enter to chat with the bot.
`;
}

/**
 * Get welcome message
 */
export function getWelcomeMessage(): string {
  return `
Welcome to LeanBot CLI!

Type /help for available commands, or just start chatting.
Press Ctrl+C or type /exit to quit.
`;
}

export class CLIChannel {
  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private enableColors: boolean;
  private showTokenUsage: boolean;
  private prompt: string;
  private sessionId: string | null = null;
  private rl: readline.Interface | null = null;
  private isRunning = false;

  constructor(options: CLIChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'cli' });
    this.enableColors = options.enableColors ?? true;
    this.showTokenUsage = options.showTokenUsage ?? false;
    this.prompt = options.prompt ?? '> ';
  }

  /**
   * Handle a single input line
   */
  async handleInput(input: string): Promise<HandleResult> {
    const trimmedInput = input.trim();

    if (!trimmedInput) {
      return {};
    }

    // Check for commands
    const cmd = parseCommand(trimmedInput);

    if (cmd) {
      return this.handleCommand(cmd.command, cmd.args);
    }

    // Process as regular message
    return this.processMessage(trimmedInput);
  }

  /**
   * Handle a command
   */
  private async handleCommand(command: string, args: string): Promise<HandleResult> {
    switch (command) {
      case 'help':
        this.print(getHelpMessage());
        return {};

      case 'exit':
      case 'quit':
        this.print('Goodbye!\n');
        return { shouldExit: true };

      case 'reset':
        await this.resetSession();
        this.print('Conversation history cleared. Starting fresh!\n');
        return {};

      case 'status':
        await this.showStatus();
        return {};

      case 'model':
        this.print(`Current model: (configured in environment)\n`);
        return {};

      default:
        this.print(`Unknown command: /${command}. Type /help for available commands.\n`);
        return {};
    }
  }

  /**
   * Process a regular message through the agent
   */
  private async processMessage(message: string): Promise<HandleResult> {
    try {
      // Ensure we have a session
      await this.ensureSession();

      if (!this.sessionId) {
        throw new Error('Failed to create session');
      }

      this.logger.debug({ message: message.substring(0, 100) }, 'Processing message');

      // Show thinking indicator
      this.print('Thinking...\r');

      // Process through agent
      const result = await this.agent.processMessage(this.sessionId, message);

      // Clear thinking indicator
      this.print('            \r');

      // Format and display response
      const formatted = formatOutput(result.response, this.enableColors);
      this.print('\n' + formatted + '\n\n');

      // Show token usage if enabled
      if (this.showTokenUsage) {
        this.print(
          `[${result.tokenUsage.inputTokens} input + ${result.tokenUsage.outputTokens} output tokens, ${result.iterationsUsed} iteration(s)]\n`
        );
      }

      this.logger.info(
        { tokens: result.tokenUsage, iterations: result.iterationsUsed },
        'Message processed'
      );

      return {};
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message }, 'Failed to process message');
      this.print(`\nError: ${err.message}\n\n`);
      return {};
    }
  }

  /**
   * Ensure we have an active session
   */
  private async ensureSession(): Promise<void> {
    if (this.sessionId) {
      // Verify session still exists
      const session = await this.sessionManager.getSession(this.sessionId);
      if (session) {
        return;
      }
    }

    // Create new session
    const session = await this.sessionManager.createSession({
      userId: 'cli-user',
      channelId: 'cli',
    });

    this.sessionId = session.id;
    this.logger.info({ sessionId: this.sessionId }, 'Created new session');
  }

  /**
   * Reset the current session
   */
  private async resetSession(): Promise<void> {
    if (this.sessionId) {
      await this.sessionManager.deleteSession(this.sessionId);
      this.sessionId = null;
    }
  }

  /**
   * Show session status
   */
  private async showStatus(): Promise<void> {
    if (!this.sessionId) {
      this.print('No active session.\n');
      return;
    }

    const session = await this.sessionManager.getSession(this.sessionId);
    if (!session) {
      this.print('Session not found.\n');
      return;
    }

    this.print(`Session ID: ${this.sessionId}\n`);
    this.print(`Messages: ${session.messages?.length ?? 0}\n`);
  }

  /**
   * Print to stdout
   */
  private print(text: string): void {
    process.stdout.write(text);
  }

  /**
   * Start the interactive REPL
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting CLI REPL...');

    // Create readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Show welcome message
    this.print(getWelcomeMessage());

    // Start the REPL loop
    await this.replLoop();
  }

  /**
   * Main REPL loop
   */
  private async replLoop(): Promise<void> {
    if (!this.rl) return;

    const question = (prompt: string): Promise<string> => {
      return new Promise((resolve) => {
        this.rl!.question(prompt, resolve);
      });
    };

    while (this.isRunning) {
      try {
        const input = await question(this.prompt);
        const result = await this.handleInput(input);

        if (result.shouldExit) {
          break;
        }
      } catch (error) {
        // Handle Ctrl+C or other interrupts
        if ((error as Error).message?.includes('closed')) {
          break;
        }
        this.logger.error({ error: (error as Error).message }, 'REPL error');
      }
    }

    await this.stop();
  }

  /**
   * Stop the REPL
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping CLI REPL...');
    this.isRunning = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.logger.info('CLI REPL stopped');
  }
}
