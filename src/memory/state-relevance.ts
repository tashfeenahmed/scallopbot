/**
 * Natural activation for durable state.
 *
 * Storage and recall are intentionally separate. Nothing becomes false merely
 * because it is old, but an old record needs either current lifecycle energy
 * or genuine relevance to become mentally available again. This mirrors human
 * recall more closely than permanent "active" flags or magic history words.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const ACTIVATION_THRESHOLD = 0.5;

// Ordinary language and generic state-query words carry little topic signal.
// This is vocabulary-independent filtering, not a list of product/domain rules.
const REQUEST_STOP_WORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'are', 'at', 'be', 'been', 'before', 'but', 'by',
  'can', 'could', 'current', 'currently', 'did', 'do', 'does', 'done', 'for',
  'from', 'had', 'happen', 'happened', 'has', 'have', 'history', 'how', 'i',
  'in', 'is', 'it', 'last', 'latest', 'me', 'my', 'need', 'now', 'of', 'old',
  'on', 'or', 'our', 'past', 'plate', 'please', 'priorities', 'priority',
  'recent', 'should', 'show', 'status', 'that', 'the', 'this', 'to', 'today',
  'update', 'updates', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'whatever', 'which', 'who', 'why', 'will', 'with', 'work', 'working', 'would', 'you',
  'your', 'know', 'thing', 'things',
]);

export interface ContextMemoryLike {
  content: string;
  category?: string;
  source?: string;
  learnedFrom?: string;
  memoryType?: string;
  importance?: number;
  confidence?: number;
  prominence?: number;
  timesConfirmed?: number;
  /** Retrieval telemetry is accepted for real-row compatibility but never reinforces activation. */
  accessCount?: number;
  lastAccessed?: number | null;
  documentDate: number;
  eventDate: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContextGoalLike {
  content?: string;
  createdAt: number;
  updatedAt?: number;
  lastAccessed?: number | null;
  metadata: {
    status?: string;
    dueDate?: number;
    progress?: number;
  };
}

export interface ContextBoardItemLike {
  message?: string;
  title?: string;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** Smooth forgetting curve: 1 now, 0.5 after one half-life. */
export function temporalActivation(
  timestamp: number | null | undefined,
  halfLifeMs: number,
  now: number = Date.now(),
): number {
  if (!timestamp || timestamp >= now) return 1;
  return Math.pow(0.5, (now - timestamp) / Math.max(HOUR_MS, halfLifeMs));
}

/** Nearer future state is more mentally available than distant future state. */
function futureProximity(timestamp: number, halfLifeMs: number, now: number): number {
  if (timestamp <= now) return 1;
  return Math.pow(0.5, (timestamp - now) / Math.max(HOUR_MS, halfLifeMs));
}

export function requestContentTerms(value: string): string[] {
  return [...new Set(value
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 3 && !REQUEST_STOP_WORDS.has(term)))];
}

/**
 * Lexical relevance used when a semantic retrieval score is unavailable.
 * A direct name/topic mention can revive an old memory without the user having
 * to say "search history"; generic planning language cannot.
 */
export function requestRelevanceScore(request: string, content: string): number {
  const requestTerms = requestContentTerms(request);
  if (requestTerms.length === 0) return 0;
  const contentTerms = new Set(requestContentTerms(content));
  const shared = requestTerms.filter(term => contentTerms.has(term));
  if (shared.length === 0) return 0;
  if (requestTerms.length === 1) return 0.9;

  const coverage = shared.length / requestTerms.length;
  const density = shared.length / Math.max(1, contentTerms.size);
  return clamp01(0.2 + 0.55 * coverage + 0.2 * Math.min(1, shared.length / 3) + 0.05 * density);
}

export function hasRequestContentOverlap(request: string, content: string): boolean {
  return requestRelevanceScore(request, content) > 0;
}

function memoryHalfLife(category?: string): number {
  switch (category) {
    case 'event': return 14 * DAY_MS;
    case 'insight': return 23 * DAY_MS;
    case 'fact': return 69 * DAY_MS;
    case 'preference': return 138 * DAY_MS;
    case 'relationship': return 346 * DAY_MS;
    default: return 30 * DAY_MS;
  }
}

function isUserGrounded(memory: ContextMemoryLike): boolean {
  if (memory.source && memory.source !== 'user') return false;
  if (memory.learnedFrom === 'self_reflection') return false;
  if (memory.metadata?.audience === 'assistant') return false;
  if (memory.metadata?.subject === 'agent') return false;
  if (memory.metadata?.goalType) return false;
  return true;
}

/** Score ordinary memory availability from freshness, relevance and confirmation. */
export function memoryActivationScore(
  memory: ContextMemoryLike,
  activeRequest: string,
  now: number = Date.now(),
  semanticRelevance?: number,
): number {
  if (!isUserGrounded(memory)) return 0;
  if (memory.memoryType === 'superseded') return 0;

  const anchor = memory.eventDate ?? memory.documentDate;
  const freshness = temporalActivation(anchor, memoryHalfLife(memory.category), now);
  const lexicalRelevance = requestRelevanceScore(activeRequest, memory.content);
  const relevance = semanticRelevance === undefined
    ? lexicalRelevance
    : Math.max(lexicalRelevance, clamp01(semanticRelevance));
  const importance = clamp01((memory.importance ?? 5) / 10);
  const confidence = clamp01(memory.confidence ?? 0.7);
  const prominence = clamp01(memory.prominence ?? 0.5);
  const salience = (importance + confidence + prominence) / 3;
  const confirmation = clamp01(Math.log2(1 + Math.max(1, memory.timesConfirmed ?? 1)) / 3);

  return clamp01(
    0.52 * freshness
    + 0.58 * relevance
    + 0.08 * salience
    + 0.07 * confirmation
  );
}

export function isMemoryLiveForContext(
  memory: ContextMemoryLike,
  activeRequest: string,
  now: number = Date.now(),
  semanticRelevance?: number,
): boolean {
  return memoryActivationScore(memory, activeRequest, now, semanticRelevance) >= ACTIVATION_THRESHOLD;
}

/** Smooth activation for a goal; lifecycle contributes but never defeats age forever. */
export function goalActivationScore(
  goal: ContextGoalLike,
  activeRequest: string = '',
  now: number = Date.now(),
): number {
  const status = goal.metadata.status ?? 'backlog';
  const lifecycle = status === 'active' ? 0.16 : status === 'backlog' ? 0.03 : 0;
  const freshness = temporalActivation(goal.updatedAt ?? goal.createdAt, 45 * DAY_MS, now);
  const dueDate = goal.metadata.dueDate;
  const dueSignal = dueDate === undefined
    ? 0
    : dueDate >= now
      ? futureProximity(dueDate, 90 * DAY_MS, now)
      : temporalActivation(dueDate, 14 * DAY_MS, now);
  const relevance = requestRelevanceScore(activeRequest, goal.content ?? '');
  const progress = clamp01((goal.metadata.progress ?? 0) / 100);
  return clamp01(lifecycle + 0.45 * freshness + 0.3 * dueSignal + 0.55 * relevance + 0.08 * progress);
}

/** Autonomous work has no request-relevance boost and must still be active. */
export function isGoalLiveForAutonomy(
  goal: ContextGoalLike,
  now: number = Date.now(),
): boolean {
  return goal.metadata.status === 'active'
    && goalActivationScore(goal, '', now) >= ACTIVATION_THRESHOLD;
}

/** Conversational recall can naturally revive a specifically relevant old goal. */
export function isGoalLiveForContext(
  goal: ContextGoalLike,
  activeRequest: string,
  now: number = Date.now(),
): boolean {
  return goalActivationScore(goal, activeRequest, now) >= ACTIVATION_THRESHOLD;
}

export function boardItemActivationScore(
  item: ContextBoardItemLike,
  activeRequest: string = '',
  now: number = Date.now(),
): number {
  const boardStatus = item.boardStatus ?? '';
  if (['done', 'archived'].includes(boardStatus)) return 0;
  if (item.status && ['fired', 'acted', 'dismissed', 'expired', 'failed'].includes(item.status)) return 0;

  const relevance = requestRelevanceScore(activeRequest, item.message ?? item.title ?? '');
  const freshness = temporalActivation(item.updatedAt || item.createdAt, 21 * DAY_MS, now);
  let lifecycle = 0;
  if (item.status === 'processing' || boardStatus === 'in_progress') lifecycle = 0.65;
  else if (item.recurring || boardStatus === 'scheduled') lifecycle = 0.35;
  else if (item.status === 'blocked' || boardStatus === 'waiting') lifecycle = 0.02;
  else if (item.source === 'agent') lifecycle = 0.02;
  else if (['inbox', 'backlog'].includes(boardStatus)) lifecycle = 0.18;

  const timing = item.triggerAt > 0
    ? item.triggerAt >= now
      ? futureProximity(item.triggerAt, 30 * DAY_MS, now)
      : temporalActivation(item.triggerAt, 2 * DAY_MS, now)
    : 0;
  return clamp01(lifecycle + 0.45 * freshness + 0.3 * timing + 0.55 * relevance);
}

export function isBoardItemLiveForContext(
  item: ContextBoardItemLike,
  activeRequestOrNow: string | number = '',
  maybeNow: number = Date.now(),
): boolean {
  const activeRequest = typeof activeRequestOrNow === 'string' ? activeRequestOrNow : '';
  const now = typeof activeRequestOrNow === 'number' ? activeRequestOrNow : maybeNow;
  return boardItemActivationScore(item, activeRequest, now) >= ACTIVATION_THRESHOLD;
}

/** Dynamic profile fields use smooth decay; identity fields remain durable. */
export function isProfileEntryLiveForContext(
  entry: ContextProfileEntryLike,
  now: number = Date.now(),
): boolean {
  const key = entry.key.toLocaleLowerCase('en-US');
  if (key === 'mood') return temporalActivation(entry.updatedAt, 8 * HOUR_MS, now) >= 0.25;
  if (key === 'focus' || /^(?:current|recent|active)[_.-]/.test(key)) {
    return temporalActivation(entry.updatedAt, 7 * DAY_MS, now) >= 0.25;
  }
  return true;
}
