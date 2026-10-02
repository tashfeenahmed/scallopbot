/**
 * session_search — native, read-only, no-LLM recall over the user's own
 * conversation history (SQLite FTS5 + BM25).
 *
 * Four call shapes:
 *   discover {query}                                 best hits + top hit expanded ±5
 *   scroll   {session_id, around_message_id, direction}  page through a session
 *   read     {session_id, message_id, radius=5}      a window around one message
 *   browse   {session_id?, limit}                    recent sessions, or a session's tail
 *
 * Results are scoped to sessions owned by the calling user (ctx.userId and
 * its declared aliases); sub-agent/scheduler transcripts are excluded.
 */

import type { ScallopDatabase, SessionMessageRow } from '../memory/db.js';
import type { Skill } from '../skills/types.js';
import { defineSkill } from '../skills/sdk.js';
import { proactiveIdentityCandidates } from '../proactive/feedback.js';
import { resolveStateUserId, DEFAULT_STATE_USER_ID } from '../utils/state-user-id.js';
import { contentBlocks, searchableMessageText, toolResultText, truncateMiddle } from './message-text.js';

export const SESSION_SEARCH_TOOL_NAME = 'session_search';

export const SESSION_SEARCH_DESCRIPTION = 'Search the full history of your past conversations with this user, including turns that were compacted out of your context and earlier sessions (tool calls and results included). '
  + 'Never conclude "not found" from conversation history alone — search first. '
  + 'Modes: discover {query} finds the best matching messages and expands the top hit; '
  + 'read {session_id, message_id, radius} shows messages around one hit; '
  + 'scroll {session_id, around_message_id, direction} pages before/after; '
  + 'browse {session_id?, limit} lists recent sessions (or the latest messages of one session).';

export type SessionSearchDb = Pick<ScallopDatabase,
  | 'searchSessionMessages'
  | 'sessionBelongsToUsers'
  | 'getSessionMessagesAround'
  | 'listSessionsForUsers'
  | 'backfillSessionSearchIndex'
  | 'getLatestSessionMessageId'>;

export interface SessionSearchDeps {
  db: SessionSearchDb;
  /** Single-owner aliases (gateway.canonicalSingleUserIds); a getter is read per call. */
  canonicalSingleUserIds?: readonly string[] | (() => readonly string[]);
  /** Rows indexed per backfill batch (default 2000). */
  backfillBatch?: number;
  /** Max time spent on lazy backfill per call (default 250ms). */
  backfillBudgetMs?: number;
}

export interface SessionSearchCaller {
  userId?: string;
  sessionId?: string;
}

export interface SessionSearchResult {
  success: boolean;
  output: string;
  error?: string;
}

const MAX_MESSAGE_CHARS = 1_500;
const MAX_TOOL_RESULT_CHARS = 1_200;
const EXPAND_RADIUS = 5;

function canonicalIds(deps: SessionSearchDeps): readonly string[] {
  const value = deps.canonicalSingleUserIds;
  return typeof value === 'function' ? value() : value ?? [];
}

/** Identities whose sessions the caller may search. */
export function ownedUserIds(userId: string, canonical: readonly string[]): string[] {
  const ids = new Set(proactiveIdentityCandidates(userId, canonical));
  if (resolveStateUserId(userId, canonical) === DEFAULT_STATE_USER_ID) {
    ids.add(DEFAULT_STATE_USER_ID);
    ids.add(`api:${DEFAULT_STATE_USER_ID}`);
    for (const alias of canonical) if (alias.trim()) ids.add(alias.trim());
  }
  return [...ids];
}

/** Build an FTS5 MATCH expression from free text. Returns null when no usable terms. */
export function buildFtsQuery(query: string, mode: 'phrase' | 'and' | 'or'): string | null {
  const tokens = [...query.normalize('NFKC').matchAll(/[\p{L}\p{N}_]+/gu)]
    .map(match => match[0])
    .filter(token => token.length >= 2 || /\d/.test(token))
    .slice(0, 16);
  if (tokens.length === 0) return null;
  const quoted = tokens.map(token => `"${token.replace(/"/g, '""')}"`);
  if (mode === 'phrase') return tokens.length > 1 ? `"${tokens.join(' ').replace(/"/g, '""')}"` : null;
  return quoted.join(mode === 'and' ? ' ' : ' OR ');
}

function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '?';
  return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ');
}

/** Render one stored message for the model (bounded, reasoning excluded). */
export function renderStoredMessage(row: SessionMessageRow, marker = ''): string {
  const blocks = row.messageKind === 'human_user' ? null : contentBlocks(row.content);
  const parts: string[] = [];
  let label: string = row.role;
  if (row.messageKind === 'tool_result') label = 'tool_result';
  else if (row.messageKind === 'assistant_protocol') label = 'assistant (tool call)';
  if (!blocks) {
    parts.push(row.content);
  } else {
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'tool_use') {
        let input = '';
        try { input = JSON.stringify(block.input ?? {}); } catch { input = '{}'; }
        parts.push(`→ ${String(block.name)}(${truncateMiddle(input, 400)})`);
      } else if (block.type === 'tool_result') {
        parts.push(`${block.is_error ? '[error] ' : ''}${truncateMiddle(toolResultText(block), MAX_TOOL_RESULT_CHARS)}`);
      } else if (block.type === 'image') parts.push('[image]');
    }
  }
  const body = truncateMiddle(parts.join('\n').trim() || '(empty)', MAX_MESSAGE_CHARS);
  return `${marker}#${row.id} [${label}] ${formatDate(row.createdAt)}\n${body}`;
}

function renderWindow(rows: readonly SessionMessageRow[], focusId?: number): string {
  return rows.map(row => renderStoredMessage(row, row.id === focusId ? '>> ' : '')).join('\n\n');
}

function lazyBackfill(deps: SessionSearchDeps): void {
  const started = Date.now();
  const budget = deps.backfillBudgetMs ?? 250;
  const batch = deps.backfillBatch ?? 2_000;
  try {
    while (Date.now() - started < budget) {
      if (deps.db.backfillSessionSearchIndex(batch) === 0) break;
    }
  } catch {
    // Search still works over whatever is indexed.
  }
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function inferMode(args: Record<string, unknown>): string {
  if (typeof args.mode === 'string' && args.mode) return args.mode;
  if (typeof args.query === 'string' && args.query.trim()) return 'discover';
  if (args.around_message_id != null) return 'scroll';
  if (args.session_id && args.message_id != null) return 'read';
  return 'browse';
}

export function runSessionSearch(
  args: Record<string, unknown>,
  caller: SessionSearchCaller,
  deps: SessionSearchDeps,
): SessionSearchResult {
  if (!caller.userId) {
    return { success: false, output: '', error: 'session_search needs the calling user identity' };
  }
  const userIds = ownedUserIds(caller.userId, canonicalIds(deps));
  const mode = inferMode(args);
  lazyBackfill(deps);

  const requireOwnedSession = (): string | SessionSearchResult => {
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (!sessionId) return { success: false, output: '', error: `${mode} needs session_id` };
    if (!deps.db.sessionBelongsToUsers(sessionId, userIds)) {
      return { success: false, output: '', error: `No session ${sessionId} found for this user` };
    }
    return sessionId;
  };

  if (mode === 'discover') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { success: false, output: '', error: 'discover needs a query' };
    const limit = asInt(args.limit, 8, 1, 25);
    const sessionFilter = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : undefined;
    const hits: ReturnType<SessionSearchDb['searchSessionMessages']> = [];
    const seen = new Set<number>();
    for (const shape of ['phrase', 'and', 'or'] as const) {
      if (hits.length >= limit) break;
      const match = buildFtsQuery(query, shape);
      if (!match) continue;
      let rows: ReturnType<SessionSearchDb['searchSessionMessages']> = [];
      try {
        rows = deps.db.searchSessionMessages({ match, userIds, sessionId: sessionFilter, limit: limit * 2 });
      } catch {
        rows = [];
      }
      for (const row of rows) {
        if (seen.has(row.messageId) || hits.length >= limit) continue;
        seen.add(row.messageId);
        hits.push(row);
      }
    }
    if (hits.length === 0) {
      return {
        success: true,
        output: `No messages matched "${query}" in this user's sessions. Try fewer or different words (exact ids, file names, distinctive terms), or browse recent sessions.`,
      };
    }
    const sessions = new Set(hits.map(hit => hit.sessionId));
    const lines = [`session_search discover "${query}" — ${hits.length} hit(s) in ${sessions.size} session(s), best first:`];
    hits.forEach((hit, index) => {
      const current = hit.sessionId === caller.sessionId ? ' (current session)' : '';
      lines.push(`${index + 1}. session ${hit.sessionId}${current} · msg #${hit.messageId} · ${hit.role}/${hit.messageKind} · ${formatDate(hit.createdAt)}\n   ${hit.snippet.replace(/\s+/g, ' ')}`);
    });
    const top = hits[0];
    const window = deps.db.getSessionMessagesAround(top.sessionId, top.messageId, EXPAND_RADIUS, EXPAND_RADIUS);
    lines.push('', `Top hit expanded (session ${top.sessionId}, ±${EXPAND_RADIUS} messages; >> marks the hit):`, renderWindow(window, top.messageId));
    lines.push('', 'Use read {session_id, message_id} to expand another hit, or scroll to page further.');
    return { success: true, output: lines.join('\n') };
  }

  if (mode === 'read') {
    const owned = requireOwnedSession();
    if (typeof owned !== 'string') return owned;
    const messageId = asInt(args.message_id, NaN, 1, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(messageId)) return { success: false, output: '', error: 'read needs message_id' };
    const radius = asInt(args.radius, EXPAND_RADIUS, 0, 20);
    const window = deps.db.getSessionMessagesAround(owned, messageId, radius, radius);
    if (!window.some(row => row.id === messageId)) {
      return { success: false, output: '', error: `Message #${messageId} not found in session ${owned}` };
    }
    return {
      success: true,
      output: `session ${owned}, messages around #${messageId} (radius ${radius}; >> marks it):\n\n${renderWindow(window, messageId)}`,
    };
  }

  if (mode === 'scroll') {
    const owned = requireOwnedSession();
    if (typeof owned !== 'string') return owned;
    const around = asInt(args.around_message_id ?? args.message_id, NaN, 1, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(around)) return { success: false, output: '', error: 'scroll needs around_message_id' };
    const direction = args.direction === 'after' || args.direction === 'forward' || args.direction === 'newer' ? 'after' : 'before';
    const limit = asInt(args.limit, 10, 1, 30);
    const rows = direction === 'before'
      ? deps.db.getSessionMessagesAround(owned, around, limit, 0, false)
      : deps.db.getSessionMessagesAround(owned, around, 0, limit, false);
    if (rows.length === 0) {
      return { success: true, output: `No messages ${direction} #${around} in session ${owned}.` };
    }
    const next = direction === 'before' ? rows[0].id : rows[rows.length - 1].id;
    return {
      success: true,
      output: `session ${owned}, ${rows.length} message(s) ${direction} #${around}:\n\n${renderWindow(rows)}\n\nContinue: scroll {session_id: "${owned}", around_message_id: ${next}, direction: "${direction}"}`,
    };
  }

  if (mode === 'browse') {
    const limit = asInt(args.limit, 10, 1, 30);
    if (typeof args.session_id === 'string' && args.session_id.trim()) {
      const owned = requireOwnedSession();
      if (typeof owned !== 'string') return owned;
      const latest = deps.db.getLatestSessionMessageId(owned);
      if (latest == null) return { success: true, output: `Session ${owned} has no stored messages.` };
      const rows = deps.db.getSessionMessagesAround(owned, latest, limit - 1, 0, true);
      return { success: true, output: `Latest ${rows.length} message(s) of session ${owned}:\n\n${renderWindow(rows)}` };
    }
    const sessions = deps.db.listSessionsForUsers(userIds, limit);
    if (sessions.length === 0) return { success: true, output: 'No stored sessions for this user.' };
    const lines = [`${sessions.length} most recent session(s):`];
    for (const session of sessions) {
      const current = session.id === caller.sessionId ? ' (current)' : '';
      const archived = session.archivedAt ? ' · closed' : '';
      const preview = session.firstUserMessage ? searchableMessageText(session.firstUserMessage).replace(/\s+/g, ' ').trim() : '';
      const first = preview ? ` · "${truncateMiddle(preview, 120)}"` : '';
      lines.push(`- ${session.id}${current} · ${session.channelId ?? '?'} · started ${formatDate(session.createdAt)} · last ${formatDate(session.updatedAt)} · ${session.messageCount} msgs${archived}${first}`);
    }
    lines.push('', 'Use discover {query} to search them, or browse {session_id} for one session\'s latest messages.');
    return { success: true, output: lines.join('\n') };
  }

  return { success: false, output: '', error: `Unknown mode "${mode}". Use discover, read, scroll or browse.` };
}

export function createSessionSearchSkill(deps: SessionSearchDeps): Skill {
  return defineSkill(SESSION_SEARCH_TOOL_NAME, SESSION_SEARCH_DESCRIPTION)
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['discover', 'read', 'scroll', 'browse'], description: 'Call shape. Inferred from the other fields when omitted.' },
        query: { type: 'string', description: 'discover: words, ids, file names or phrases to find.' },
        session_id: { type: 'string', description: 'read/scroll/browse: session to look in (discover: optional filter).' },
        message_id: { type: 'number', description: 'read: message to centre on.' },
        around_message_id: { type: 'number', description: 'scroll: message to page from.' },
        direction: { type: 'string', enum: ['before', 'after'], description: 'scroll: older (before) or newer (after) messages.' },
        radius: { type: 'number', description: 'read: messages either side (default 5, max 20).' },
        limit: { type: 'number', description: 'discover hits / scroll page / browse rows.' },
      },
      required: [],
    })
    .onNativeExecute(async ctx => runSessionSearch(ctx.args, { userId: ctx.userId, sessionId: ctx.sessionId }, deps))
    .build()
    .skill;
}

/** Register session_search on a skill registry. Call once from the gateway. */
export function registerSessionSearchTool(
  registry: { registerSkill(skill: Skill): void },
  deps: SessionSearchDeps,
): Skill {
  const skill = createSessionSearchSkill(deps);
  registry.registerSkill(skill);
  return skill;
}
