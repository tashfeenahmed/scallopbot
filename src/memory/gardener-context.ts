/**
 * Shared types and helpers for gardener pipeline steps.
 */

import type { Logger } from 'pino';
import type { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, BehavioralPatterns } from './db.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';
import { resolveStateUserId } from '../utils/state-user-id.js';

export const DEFAULT_USER_ID = 'default';

export interface GardenerContext {
  scallopStore: ScallopMemoryStore;
  db: ScallopDatabase;
  logger: Logger;
  fusionProvider?: LLMProvider;
  sessionSummarizer?: SessionSummarizer;
  quietHours: { start: number; end: number };
  workspace?: string;
  disableArchival: boolean;
  /** Resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
  /** Explicit channel identities belonging to this deployment's one canonical owner. */
  canonicalSingleUserIds?: readonly string[];
}

/** True only when deployment configuration explicitly names a non-default owner alias. */
export function hasExplicitSingleOwner(ctx: Pick<GardenerContext, 'canonicalSingleUserIds'>): boolean {
  return (ctx.canonicalSingleUserIds ?? []).some(alias => (
    resolveStateUserId(alias, []) !== DEFAULT_USER_ID
  ));
}

/** Resolve a persisted session's authenticated identity, rejecting ambiguous sessions. */
export function resolveSessionStateUserId(
  metadata: Record<string, unknown> | null | undefined,
  canonicalSingleUserIds: readonly string[] = [],
): string | null {
  if (!metadata || metadata.isSubAgent === true) return null;
  const rawUserId = metadata.userId;
  if (typeof rawUserId !== 'string' || !rawUserId.trim()) return null;
  return resolveStateUserId(rawUserId, canonicalSingleUserIds);
}

/** Exact persisted identities allowed to contribute chat context to one state owner. */
export function stateIdentityCandidates(
  stateUserId: string,
  canonicalSingleUserIds: readonly string[] = [],
): string[] {
  const candidates = new Set<string>([stateUserId]);
  for (const alias of canonicalSingleUserIds) {
    const trimmed = alias.trim();
    if (trimmed && resolveStateUserId(trimmed, canonicalSingleUserIds) === stateUserId) {
      candidates.add(trimmed);
    }
  }
  return [...candidates];
}

/** Verify that a durable session belongs to the requested state owner. */
export function sessionBelongsToStateUser(
  db: Pick<ScallopDatabase, 'getSession'>,
  sessionId: string,
  stateUserId: string,
  canonicalSingleUserIds: readonly string[] = [],
): boolean {
  const session = db.getSession(sessionId);
  return resolveSessionStateUserId(session?.metadata, canonicalSingleUserIds) === stateUserId;
}

/**
 * Creates a default BehavioralPatterns stub for cold-start users.
 * Used when db.getBehavioralPatterns() returns null.
 */
export function safeBehavioralPatterns(userId: string): BehavioralPatterns {
  return {
    userId,
    communicationStyle: null,
    expertiseAreas: [],
    responsePreferences: {},
    activeHours: [],
    messageFrequency: null,
    sessionEngagement: null,
    topicSwitch: null,
    responseLength: null,
    affectState: null,
    smoothedAffect: null,
    updatedAt: 0,
  };
}
