/**
 * Telegram Send Skill Execution Script
 *
 * Sends messages via the TelegramGateway singleton.
 * Receives arguments via SKILL_ARGS environment variable.
 */

import { TelegramGateway } from '../../../../channels/telegram-gateway.js';

// Types
interface TelegramSendArgs {
  chat_id: string | number;
  message: string;
}

interface TelegramSendResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

/**
 * Output result as JSON and exit
 */
function outputResult(result: TelegramSendResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

/**
 * Parse and validate arguments from SKILL_ARGS
 */
function parseArgs(): TelegramSendArgs {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
  }

  let args: unknown;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }

  // Validate args is an object
  if (!args || typeof args !== 'object') {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS must be a JSON object',
      exitCode: 1,
    });
  }

  const argsObj = args as Record<string, unknown>;

  // Validate required chat_id field
  if (argsObj.chat_id === undefined || argsObj.chat_id === null || argsObj.chat_id === '') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: chat_id',
      exitCode: 1,
    });
  }

  // Validate required message field
  if (!argsObj.message || typeof argsObj.message !== 'string') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: message',
      exitCode: 1,
    });
  }

  return {
    chat_id: argsObj.chat_id as string | number,
    message: argsObj.message as string,
  };
}

/**
 * Execute telegram send operation
 */
async function executeOperation(args: TelegramSendArgs): Promise<void> {
  const gateway = TelegramGateway.getInstance();

  // Check if gateway is available
  if (!gateway.isAvailable()) {
    outputResult({
      success: false,
      output: '',
      error: 'Telegram not initialized. Ensure Telegram channel is enabled and running.',
      exitCode: 1,
    });
  }

  try {
    await gateway.sendMessage(args.chat_id, args.message);
    outputResult({
      success: true,
      output: `Message sent to ${args.chat_id}`,
      exitCode: 0,
    });
  } catch (error) {
    const err = error as Error;
    outputResult({
      success: false,
      output: '',
      error: `Failed to send message: ${err.message}`,
      exitCode: 1,
    });
  }
}

// Main execution
const args = parseArgs();
executeOperation(args);
