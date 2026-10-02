/**
 * Recall memory for the per-turn user message and for cold boundaries.
 *
 * - buildRecallBlock: prefetch for the current user message. BM25 + embeddings
 *   only (never an LLM rerank), hard time budget, skipped for trivial messages.
 *   The result goes INTO the current user message (not the system prompt) so
 *   the frozen session prompt stays cacheable.
 * - buildRecallDigest: a ranked digest for session start / resume / after
 *   compaction (Prime-style IDF overlap with the goal and the last 4 messages,
 *   plus prominence). Synchronous, no embeddings, no LLM.
 *
 * Filtering mirrors Agent.buildMemoryContext: user-grounded memories only, and
 * each must pass isMemoryLiveForContext for the active request.
 */

import type { ScallopMemoryEntry, ScallopMemoryEntryLight } from './db.js';
import type { ScallopSearchOptions, ScallopSearchResult } from './scallop-store.js';
import { isMemoryLiveForContext } from './state-relevance.js';

export const RECALL_CONTEXT_NOTE = 'recalled context, not user input';

type RecallMemory = ScallopMemoryEntry | ScallopMemoryEntryLight;

/** Minimal store surface (ScallopMemoryStore satisfies it). */
export interface RecallStore {
  search(query: string, options?: ScallopSearchOptions): Promise<ScallopSearchResult[]>;
  getDatabase(): {
    getMemoriesByUser(
      userId: string,
      options: { minProminence?: number; isLatest?: boolean; limit?: number },
    ): ScallopMemoryEntry[];
  };
}

/** Same semantics as the agent's isUserGroundedMemory. */
export function isUserGroundedMemory(memory: {
  source?: string;
  learnedFrom?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return memory.source !== 'assistant'
    && memory.learnedFrom !== 'self_reflection'
    && memory.metadata?.audience !== 'assistant'
    && memory.metadata?.subject !== 'agent'
    // Goals have their own lifecycle/status context.
    && !memory.metadata?.goalType;
}

function localIsoDate(epochMs: number, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** One bullet, formatted like the agent's MEMORIES FROM THE PAST lines. */
export function formatRecallLine(memory: RecallMemory, timezone?: string): string {
  const dated = memory.eventDate == null
    ? `[Recorded: ${localIsoDate(memory.documentDate, timezone)}]`
    : `[Event date: ${localIsoDate(memory.eventDate, timezone)}]`;
  const subject = typeof memory.metadata?.subject === 'string' && memory.metadata.subject !== 'user'
    ? `[About ${memory.metadata.subject}] `
    : '';
  return `- ${subject}${dated} ${memory.content.replace(/\s+/g, ' ').trim()}`;
}

function wrapBlock(lines: string[], kind?: string): string {
  const open = kind ? `<memory-context kind="${kind}">` : '<memory-context>';
  return `${open}\n[${RECALL_CONTEXT_NOTE}: background facts from memory, possibly stale; verify with tools when it matters]\n${lines.join('\n')}\n</memory-context>`;
}

function fitLines(lines: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

// ─── Trivial-message detection ─────────────────────────────────────────

const ACKNOWLEDGEMENTS = new Set([
  'ok', 'okay', 'k', 'kk', 'ok thanks', 'okay thanks', 'thanks', 'thank you', 'thank u', 'thx', 'ty', 'tysm',
  'cheers', 'cool', 'nice', 'great', 'awesome', 'perfect', 'good', 'got it', 'gotcha', 'sure', 'yes', 'yeah',
  'yep', 'yup', 'no', 'nope', 'nah', 'lol', 'lmao', 'haha', 'hah', 'hi', 'hello', 'hey', 'yo', 'sup', 'bye',
  'good night', 'gn', 'good morning', 'gm', 'morning', 'night', 'np', 'no problem', 'alright', 'right',
  'sounds good', 'will do', 'done', 'go on', 'continue', 'go ahead', 'please', 'pls', 'hmm', 'hm', 'ah', 'oh',
  'wow', 'love it', 'nice one', 'that works', 'sounds great', 'thanks a lot', 'many thanks', 'all good', 'fine', 'agreed', 'exactly',
]);

const ACK_WORDS = new Set([
  ...[...ACKNOWLEDGEMENTS].filter(phrase => !phrase.includes(' ')),
  'got', 'it', 'thank', 'you', 'u', 'so', 'much', 'a', 'lot', 'very',
]);

const COMMON_CAPITALISED =new Set(['i', 'im', 'ok', 'okay', 'yes', 'no', 'thanks', 'please', 'hi', 'hey', 'hello']);

/** A token that looks like a named entity, number, handle, or identifier. */
function looksLikeEntity(token: string, index: number, wordCount: number): boolean {
  const bare = token.replace(/^[^\p{L}\p{N}@#]+|[^\p{L}\p{N}]+$/gu, '');
  if (!bare) return false;
  if (/\d/.test(bare) || /^[@#]/.test(bare)) return true;
  if (/[._/:]/.test(bare)) return true; // paths, domains, file names
  if (/\p{Lu}/u.test(bare.slice(1))) return true; // GitHub, NASA, McDonald
  if (/^\p{Lu}/u.test(bare) && !COMMON_CAPITALISED.has(bare.toLowerCase())) {
    // A sentence-initial capital is weak evidence ("Nice work"), unless the
    // whole message is that one word ("Sarah?").
    return index > 0 || wordCount === 1;
  }
  return false;
}

/**
 * True for messages that should not trigger a recall prefetch: empty, emoji or
 * punctuation only, acknowledgements ("ok", "thanks"), or under 3 words with
 * no entity-like token.
 */
export function isTrivialMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (!/[\p{L}\p{N}]/u.test(text)) return true; // emoji / punctuation only
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (ACKNOWLEDGEMENTS.has(normalized) || ACKNOWLEDGEMENTS.has(normalized.replace(/'/g, ''))) return true;
  // Strings of acknowledgements ("got it, thanks", "ok cool thank you so much").
  if (normalized.split(' ').every(word => ACK_WORDS.has(word.replace(/'/g, '')))) return true;
  const words = text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  if (words.length >= 3) return false;
  return !words.some((word, index) => looksLikeEntity(word, index, words.length));
}

// ─── Per-turn prefetch ─────────────────────────────────────────────────

export interface RecallBlockOptions {
  /** Hard latency budget; '' is returned when search does not finish in time. */
  budgetMs?: number;
  /** Max memories in the block. */
  limit?: number;
  /** Max characters of bullet text. */
  maxChars?: number;
  timezone?: string;
  now?: number;
  /** Ids already shown (e.g. in the digest or core memory) to skip. */
  excludeIds?: ReadonlySet<string>;
}

const TIMEOUT = Symbol('recall-timeout');

/**
 * Prefetch recall for the current user message. Returns a `<memory-context>`
 * block to prepend/append to the user message, or '' (trivial message, no live
 * hits, search error, or budget exceeded).
 */
export async function buildRecallBlock(
  store: RecallStore,
  userId: string,
  message: string,
  options: RecallBlockOptions = {},
): Promise<string> {
  if (isTrivialMessage(message)) return '';
  // Search (~10–300 ms) plus one time-limited rerank (2.5s) with headroom.
  const budgetMs = options.budgetMs ?? 3_500;
  const limit = options.limit ?? 8;
  const now = options.now ?? Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let results: ScallopSearchResult[] | typeof TIMEOUT;
  try {
    results = await Promise.race([
      store.search(message, { userId, minProminence: 0.1, limit: Math.max(limit, 10) }),
      new Promise<typeof TIMEOUT>(resolve => {
        timer = setTimeout(() => resolve(TIMEOUT), budgetMs);
      }),
    ]);
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (results === TIMEOUT) return '';

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const memory = result.memory;
    if (seen.has(memory.id) || options.excludeIds?.has(memory.id)) continue;
    if (!isUserGroundedMemory(memory)) continue;
    if (!isMemoryLiveForContext(memory, message, now, result.score)) continue;
    seen.add(memory.id);
    lines.push(formatRecallLine(memory, options.timezone));
    if (lines.length >= limit) break;
  }
  const kept = fitLines(lines, options.maxChars ?? 2000);
  return kept.length > 0 ? wrapBlock(kept) : '';
}

// ─── Cold-boundary digest ──────────────────────────────────────────────

const DIGEST_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
  'from', 'as', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'do', 'does',
  'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'what', 'which', 'who', 'how', 'when',
  'where', 'why', 'not', 'no', 'yes', 'just', 'also', 'about', 'up', 'out', 'user', 'please', 'let', 'lets',
]);

function digestTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(term => term.length > 1 && !DIGEST_STOP_WORDS.has(term))
      .map(term => (term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term)),
  );
}

/** Weights for the last 4 messages, newest first (Prime). */
export const DIGEST_MESSAGE_WEIGHTS = [2, 1.5, 1, 1] as const;
export const DIGEST_GOAL_WEIGHT = 3;

export interface RecallDigestInput {
  /** Current goal / task statement, if known. */
  goal?: string;
  /** Recent message texts, oldest → newest; only the last 4 count. */
  recentMessages?: string[];
  /** Character cap for bullet text (default ~1,500). */
  maxChars?: number;
  /** Candidate pool size, highest prominence first (default 200). */
  poolSize?: number;
  /** Max bullets (default 12). */
  limit?: number;
  timezone?: string;
  now?: number;
  excludeIds?: ReadonlySet<string>;
}

export interface RankedDigestItem {
  memory: ScallopMemoryEntry;
  score: number;
  overlap: number;
}

/**
 * Rank memories for a cold boundary. score = Σ weight_i · IDF-overlap(text_i)
 * (goal ×3, last 4 messages ×2, ×1.5, ×1, ×1) + prominence. Overlap is the
 * IDF mass of shared terms divided by the IDF mass of the query's terms.
 */
export function rankRecallDigest(
  memories: ScallopMemoryEntry[],
  input: Pick<RecallDigestInput, 'goal' | 'recentMessages'>,
): RankedDigestItem[] {
  const docs = memories.map(memory => digestTerms(memory.content));
  const df = new Map<string, number>();
  for (const terms of docs) for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  const n = Math.max(1, memories.length);
  const idf = (term: string) => Math.log(1 + (n + 1) / ((df.get(term) ?? 0) + 0.5));

  const queries: Array<{ terms: Set<string>; weight: number; mass: number }> = [];
  const addQuery = (text: string | undefined, weight: number) => {
    if (!text?.trim()) return;
    const terms = digestTerms(text);
    if (terms.size === 0) return;
    let mass = 0;
    for (const term of terms) mass += idf(term);
    queries.push({ terms, weight, mass });
  };
  addQuery(input.goal, DIGEST_GOAL_WEIGHT);
  const recent = (input.recentMessages ?? []).slice(-4).reverse();
  recent.forEach((text, index) => addQuery(text, DIGEST_MESSAGE_WEIGHTS[index]));

  return memories.map((memory, index) => {
    let overlap = 0;
    for (const query of queries) {
      let shared = 0;
      for (const term of query.terms) if (docs[index].has(term)) shared += idf(term);
      overlap += query.weight * (query.mass > 0 ? shared / query.mass : 0);
    }
    return { memory, overlap, score: overlap + (memory.prominence ?? 0) };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Ranked recall digest for session start / resume / post-compaction. Returns a
 * `<memory-context kind="digest">` block (≤ maxChars of bullets) or ''.
 */
export function buildRecallDigest(
  store: RecallStore,
  userId: string,
  input: RecallDigestInput = {},
): string {
  const now = input.now ?? Date.now();
  let pool: ScallopMemoryEntry[];
  try {
    pool = store.getDatabase().getMemoriesByUser(userId, {
      minProminence: 0.1,
      isLatest: true,
      limit: input.poolSize ?? 200,
    });
  } catch {
    return '';
  }
  pool = pool.filter(memory =>
    memory.memoryType !== 'superseded'
    && isUserGroundedMemory(memory)
    && !input.excludeIds?.has(memory.id));
  if (pool.length === 0) return '';

  const request = [input.goal ?? '', ...(input.recentMessages ?? []).slice(-4)].join('\n');
  const totalWeight = DIGEST_GOAL_WEIGHT + DIGEST_MESSAGE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const ranked = rankRecallDigest(pool, input);
  const lines: string[] = [];
  for (const item of ranked) {
    // Relevance as a 0..1 signal for the shared liveness gate.
    const relevance = Math.min(1, item.overlap / (totalWeight / 3));
    if (!isMemoryLiveForContext(item.memory, request, now, relevance)) continue;
    lines.push(formatRecallLine(item.memory, input.timezone));
    if (lines.length >= (input.limit ?? 12)) break;
  }
  const kept = fitLines(lines, input.maxChars ?? 1500);
  return kept.length > 0 ? wrapBlock(kept, 'digest') : '';
}
