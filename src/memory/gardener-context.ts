/**
 * Shared types and helpers for gardener pipeline steps.
 */

import type { Logger } from 'pino';
import type { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, BehavioralPatterns } from './db.js';
import type { SessionSummarizer } from './session-summary.js';
import type { LLMProvider } from '../providers/types.js';

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
