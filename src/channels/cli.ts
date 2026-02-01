/**
 * CLI REPL Channel
 * Interactive command-line interface for LeanBot
 * Supports text and voice modes
 */

import * as readline from 'readline';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import { VoiceManager } from '../voice/index.js';

export interface CLIChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  enableColors?: boolean;
  showTokenUsage?: boolean;
  prompt?: string;
  voiceMode?: boolean;
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
export function getHelpMessage(voiceAvailable: boolean = false): string {
  const voiceCommands = voiceAvailable
    ? `
  /voice    - Toggle voice mode (speak to chat)
  /listen   - Record and transcribe (one-time)
  /speak    - Speak the last response again`
    : '';

  return `
LeanBot CLI Commands:

  /help     - Show this help message
  /reset    - Clear conversation history and start fresh
  /exit     - Exit the CLI
  /quit     - Exit the CLI (alias)
  /status   - Show current session status
  /model    - Show or change the current model${voiceCommands}

Just type your message and press Enter to chat with the bot.
${voiceAvailable ? 'Voice mode available! Type /voice to enable.' : ''}
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

  // Voice support
  private voiceManager: VoiceManager | null = null;
  private voiceModeEnabled = false;
  private voiceAvailable = false;
  private lastResponse: string = '';

  constructor(options: CLIChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'cli' });
    this.enableColors = options.enableColors ?? true;
    this.showTokenUsage = options.showTokenUsage ?? false;
    this.prompt = options.prompt ?? '> ';
    this.voiceModeEnabled = options.voiceMode ?? false;
  }

  /**
   * Initialize voice capabilities
   */
  private async initVoice(): Promise<void> {
    try {
      this.voiceManager = VoiceManager.fromEnv(this.logger);
      const status = await this.voiceManager.isAvailable();

      this.voiceAvailable = status.stt && status.tts;

      if (this.voiceAvailable) {
        const providers = await this.voiceManager.getStatus();
        this.logger.info(
          { stt: providers.stt.provider, tts: providers.tts.provider },
          'Voice initialized'
        );
      } else {
        this.logger.debug({ status }, 'Voice not available');
      }
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Voice init failed');
      this.voiceAvailable = false;
    }
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
        this.print(getHelpMessage(this.voiceAvailable));
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

      case 'voice':
        return this.handleVoiceToggle();

      case 'listen':
        return this.handleVoiceListen();

      case 'speak':
        return this.handleVoiceSpeak();

      default:
        this.print(`Unknown command: /${command}. Type /help for available commands.\n`);
        return {};
    }
  }

  /**
   * Toggle voice mode
   */
  private handleVoiceToggle(): HandleResult {
    if (!this.voiceAvailable) {
      this.print('Voice mode not available. Check if audio tools are installed.\n');
      return {};
    }

    this.voiceModeEnabled = !this.voiceModeEnabled;
    this.print(
      this.voiceModeEnabled
        ? 'Voice mode ENABLED. Press Enter to start recording, Enter again to stop.\n'
        : 'Voice mode DISABLED. Back to text input.\n'
    );
    return {};
  }

  /**
   * Record and transcribe once
   */
  private async handleVoiceListen(): Promise<HandleResult> {
    if (!this.voiceAvailable || !this.voiceManager) {
      this.print('Voice not available.\n');
      return {};
    }

    try {
      this.print('Recording... Press Enter to stop.\n');
      await this.voiceManager.startRecording();

      // Wait for Enter key
      await new Promise<void>((resolve) => {
        this.rl?.once('line', () => resolve());
      });

      const audio = await this.voiceManager.stopRecording();
      this.print('Transcribing...\n');

      const result = await this.voiceManager.transcribe(audio);
      this.print(`You said: "${result.text}"\n`);

      if (result.text.trim()) {
        // Process as message
        return this.processMessage(result.text);
      }

      return {};
    } catch (error) {
      this.print(`Voice error: ${(error as Error).message}\n`);
      return {};
    }
  }

  /**
   * Speak the last response
   */
  private async handleVoiceSpeak(): Promise<HandleResult> {
    if (!this.voiceAvailable || !this.voiceManager) {
      this.print('Voice not available.\n');
      return {};
    }

    if (!this.lastResponse) {
      this.print('No response to speak.\n');
      return {};
    }

    try {
      this.print('Speaking...\n');
      await this.voiceManager.speak(this.lastResponse);
    } catch (error) {
      this.print(`Speech error: ${(error as Error).message}\n`);
    }

    return {};
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

      // Save for /speak command
      this.lastResponse = result.response;

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

      // Speak response if voice mode enabled
      if (this.voiceModeEnabled && this.voiceManager) {
        try {
          await this.voiceManager.speak(result.response);
        } catch (error) {
          this.logger.debug({ error: (error as Error).message }, 'Failed to speak response');
        }
      }

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

    // Initialize voice capabilities
    await this.initVoice();

    // Create readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Show welcome message
    this.print(getWelcomeMessage());

    if (this.voiceAvailable) {
      const status = await this.voiceManager!.getStatus();
      this.print(`Voice available: STT=${status.stt.provider}, TTS=${status.tts.provider}\n`);
      this.print('Type /voice to enable voice mode.\n\n');
    }

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
        // Voice mode: record on empty Enter, transcribe and process
        if (this.voiceModeEnabled && this.voiceManager) {
          const prompt = '[Voice] Press Enter to record, or type message: ';
          const input = await question(prompt);

          if (input.trim() === '') {
            // Start voice recording
            await this.handleVoiceListen();
          } else {
            const result = await this.handleInput(input);
            if (result.shouldExit) break;
          }
        } else {
          // Text mode
          const input = await question(this.prompt);
          const result = await this.handleInput(input);

          if (result.shouldExit) {
            break;
          }
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
