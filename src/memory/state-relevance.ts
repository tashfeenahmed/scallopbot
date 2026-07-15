/**
 * Shared liveness rules for ambient context.
 *
 * Durable state is deliberately not deleted when it becomes old. These helpers
 * decide whether that state may be presented as *current* without the user
 * explicitly asking for history, backlog, or archived work.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const REQUEST_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'that', 'the', 'this',
  'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your', 'know', 'thing', 'things',
]);

export interface ContextMemoryLike {
  content: string;
  source?: string;
  learnedFrom?: string;
  memoryType?: string;
  documentDate: number;
  eventDate: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContextGoalLike {
  createdAt: number;
  lastAccessed?: number | null;
  metadata: {
    status?: string;
    dueDate?: number;
    progress?: number;
  };
}

export interface ContextBoardItemLike {
  source: string;
  status?: string;
  boardStatus?: string | null;
  triggerAt: number;
  recurring?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ContextProfileEntryLike {
  key: string;
  updatedAt: number;
}

export function isHistoricalStateRequest(value: string): boolean {
  return /\b(?:all|archive|archived|backlog|history|historical|old|older|past|previous|earlier|before|ago|last\s+(?:week|month|year|time)|everything)\b/i.test(value);
}

export function requestContentTerms(value: string): string[] {
  return [...new Set(value
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 3 && !REQUEST_STOP_WORDS.has(term)))];
}

export function hasRequestContentOverlap(request: string, content: string): boolean {
  const terms = requestContentTerms(request);
  if (terms.length === 0) return false;
  const normalized = content.toLocaleLowerCase('en-US');
  return terms.some(term => normalized.includes(term));
}

/** User-grounded and either recent or specifically relevant to this request. */
export function isMemoryLiveForContext(
  memory: ContextMemoryLike,
  activeRequest: string,
  now: number = Date.now(),
): boolean {
  if (memory.source && memory.source !== 'user') return false;
  if (memory.learnedFrom === 'self_reflection') return false;
  if (memory.metadata?.audience === 'assistant') return false;
  if (memory.metadata?.subject === 'agent') return false;
  if (memory.metadata?.goalType) return false;

  const historical = isHistoricalStateRequest(activeRequest);
  if (!historical && memory.eventDate && memory.eventDate < now - DAY_MS) return false;
  if (historical) return hasRequestContentOverlap(activeRequest, memory.content);

  const recent = memory.documentDate >= now - DAY_MS;
  return recent || hasRequestContentOverlap(activeRequest, memory.content);
}

/**
 * An overdue goal remains durable and explicitly queryable, but autonomous
 * systems stop treating it as a live signal after a grace period unless the
 * underlying goal was genuinely accessed recently.
 */
export function isGoalLiveForAutonomy(
  goal: ContextGoalLike,
  now: number = Date.now(),
): boolean {
  if (goal.metadata.status !== 'active') return false;
  const dueDate = goal.metadata.dueDate;
  if (!dueDate || dueDate >= now - 7 * DAY_MS) return true;
  const lastEngagement = Math.max(goal.createdAt, goal.lastAccessed ?? 0);
  return lastEngagement >= now - 14 * DAY_MS;
}

/**
 * Current-board view. Hidden rows are preserved and remain available through
 * an explicit all/history/backlog view.
 */
export function isBoardItemLiveForContext(
  item: ContextBoardItemLike,
  now: number = Date.now(),
): boolean {
  const boardStatus = item.boardStatus ?? '';
  if (['done', 'archived'].includes(boardStatus)) return false;
  if (item.status && ['fired', 'acted', 'dismissed', 'expired', 'failed'].includes(item.status)) return false;
  if (item.status === 'processing' || boardStatus === 'in_progress') return true;

  // A waiting/blocked card is diagnostic state, not an implied current user
  // priority. It stays available in the full board.
  if (item.status === 'blocked' || boardStatus === 'waiting') return false;

  // Agent-created inbox/backlog cards are suggestions until the user accepts,
  // schedules, or starts them.
  if (item.source === 'agent' && ['inbox', 'backlog'].includes(boardStatus)) return false;

  if (item.recurring) return true;
  if (item.triggerAt > 0) {
    return item.triggerAt >= now - DAY_MS && item.triggerAt <= now + 30 * DAY_MS;
  }

  return ['inbox', 'backlog'].includes(boardStatus)
    && Math.max(item.createdAt, item.updatedAt) >= now - 14 * DAY_MS;
}

/** Dynamic profile keys expire from ambient context but stay stored. */
export function isProfileEntryLiveForContext(
  entry: ContextProfileEntryLike,
  now: number = Date.now(),
): boolean {
  const key = entry.key.toLocaleLowerCase('en-US');
  if (key === 'mood') return entry.updatedAt >= now - DAY_MS;
  if (key === 'focus' || /^(?:current|recent|active)[_.-]/.test(key)) {
    return entry.updatedAt >= now - 14 * DAY_MS;
  }
  return true;
}
