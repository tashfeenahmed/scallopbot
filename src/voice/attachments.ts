/**
 * Voice Attachment Utilities
 *
 * Manages pending voice attachments per session.
 * Used by the voice_reply native skill and the Telegram channel.
 */

import { unlink } from 'fs/promises';

const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PendingEntry {
  files: string[];
  createdAt: number;
}

// Global storage for pending voice attachments per session
const pendingVoiceAttachments = new Map<string, PendingEntry>();

/**
 * Evict entries older than STALE_TTL_MS and clean up their files
 */
function evictStale(): void {
  const now = Date.now();
  for (const [sessionId, entry] of pendingVoiceAttachments) {
    if (now - entry.createdAt > STALE_TTL_MS) {
      pendingVoiceAttachments.delete(sessionId);
      // Best-effort cleanup of orphaned files
      for (const file of entry.files) {
        unlink(file).catch(() => {});
      }
    }
  }
}

/**
 * Add a pending voice attachment for a session
 */
export function addPendingVoiceAttachment(sessionId: string, filePath: string): void {
  evictStale();
  const existing = pendingVoiceAttachments.get(sessionId);
  if (existing) {
    existing.files.push(filePath);
  } else {
    pendingVoiceAttachments.set(sessionId, { files: [filePath], createdAt: Date.now() });
  }
}

/**
 * Get and clear pending voice attachments for a session
 */
export function getPendingVoiceAttachments(sessionId: string): string[] {
  const entry = pendingVoiceAttachments.get(sessionId);
  pendingVoiceAttachments.delete(sessionId);
  return entry?.files || [];
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
