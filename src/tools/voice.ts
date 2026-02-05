/**
 * Voice Attachment Utilities
 *
 * Manages pending voice attachments per session.
 * The VoiceReplyTool has been migrated to a native skill (voice_reply).
 * These utilities are used by both the skill and the Telegram channel.
 */

import { unlink } from 'fs/promises';

// Global storage for pending voice attachments per session
const pendingVoiceAttachments = new Map<string, string[]>();

/**
 * Add a pending voice attachment for a session
 */
export function addPendingVoiceAttachment(sessionId: string, filePath: string): void {
  const attachments = pendingVoiceAttachments.get(sessionId) || [];
  attachments.push(filePath);
  pendingVoiceAttachments.set(sessionId, attachments);
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
