/**
 * Voice Reply Tool - Synthesizes speech and queues it for delivery
 *
 * This tool allows the agent to send voice messages when contextually appropriate.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { writeFile, unlink } from 'fs/promises';
import { nanoid } from 'nanoid';
import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { VoiceManager } from '../voice/index.js';

// Global storage for pending voice attachments per session
const pendingVoiceAttachments = new Map<string, string[]>();

export interface VoiceToolConfig {
  voiceManager: VoiceManager;
  defaultVoice?: string;
}

export class VoiceReplyTool implements Tool {
  public readonly name = 'voice_reply';
  public readonly description = 'Send a voice message to the user. Use this when the user asks for a voice note, audio response, or when voice would be more appropriate than text.';

  private voiceManager: VoiceManager;
  private defaultVoice: string;

  public readonly definition: ToolDefinition = {
    name: 'voice_reply',
    description: 'Send a voice message to the user. Use this when the user explicitly asks for a voice note/audio, or when spoken response would be more natural (e.g., greetings, short confirmations, emotional responses).',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to speak in the voice message. Keep it concise (under 500 characters) for best results.',
        },
        voice: {
          type: 'string',
          description: 'Optional voice style. Options: af_heart (warm female), af_bella (professional female), am_adam (deep male), am_michael (friendly male). Default: af_heart',
          enum: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_adam', 'am_michael'],
        },
      },
      required: ['text'],
    },
  };

  constructor(config: VoiceToolConfig) {
    this.voiceManager = config.voiceManager;
    this.defaultVoice = config.defaultVoice || 'af_heart';
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const text = input.text as string;
    const voice = (input.voice as string) || this.defaultVoice;

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'No text provided for voice synthesis',
      };
    }

    // Limit text length for voice
    const maxLength = 1000;
    const truncatedText = text.length > maxLength
      ? text.substring(0, maxLength) + '...'
      : text;

    context.logger.info({ textLength: truncatedText.length, voice }, 'Synthesizing voice reply');

    try {
      // Check if TTS is available
      const status = await this.voiceManager.isAvailable();
      if (!status.tts) {
        return {
          success: false,
          output: '',
          error: 'Text-to-speech is not available. Voice reply cannot be sent.',
        };
      }

      // Synthesize speech
      const result = await this.voiceManager.synthesize(truncatedText, {
        voice,
        format: 'opus', // Best for Telegram
      });

      // Save to temp file
      const tempFile = join(tmpdir(), `voice-reply-${nanoid()}.ogg`);
      await writeFile(tempFile, result.audio);

      // Queue the attachment for this session
      const sessionAttachments = pendingVoiceAttachments.get(context.sessionId) || [];
      sessionAttachments.push(tempFile);
      pendingVoiceAttachments.set(context.sessionId, sessionAttachments);

      context.logger.info({ file: tempFile, duration: result.duration }, 'Voice reply queued');

      return {
        success: true,
        output: `Voice message prepared (${Math.round(result.duration || 0)}s). It will be sent along with this response.`,
      };
    } catch (error) {
      const err = error as Error;
      context.logger.error({ error: err.message }, 'Voice synthesis failed');
      return {
        success: false,
        output: '',
        error: `Failed to create voice message: ${err.message}`,
      };
    }
  }
}

/**
 * Get and clear pending voice attachments for a session
 */
export function getPendingVoiceAttachments(sessionId: string): string[] {
  const attachments = pendingVoiceAttachments.get(sessionId) || [];
  pendingVoiceAttachments.delete(sessionId);
  return attachments;
}

/**
 * Clean up voice attachment files
 */
export async function cleanupVoiceAttachments(files: string[]): Promise<void> {
  for (const file of files) {
    try {
      await unlink(file);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Initialize the voice reply tool
 */
export function initializeVoiceTool(voiceManager: VoiceManager): VoiceReplyTool {
  return new VoiceReplyTool({ voiceManager });
}
