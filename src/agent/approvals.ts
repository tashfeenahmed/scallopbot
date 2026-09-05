/**
 * Hermes-style approvals: when the current-turn intent gate blocks a write,
 * the user gets ONE tap (once / this session / always / no) instead of a dead
 * end. Grants are keyed by user and a coarse `tool[:action]` pattern so a
 * later re-issue of the same kind of call passes the gate deterministically.
 *
 * Hard floors (rm -rf, force push, mkfs, HTTP DELETE, ...) can never be
 * granted; `grantPatternFor` returns null for them so no prompt is offered.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolUseContent } from '../providers/types.js';

export type ApprovalScope = 'once' | 'session' | 'always';

export interface PendingApproval {
  id: string;
  sessionId: string;
  userId: string;
  toolUse: ToolUseContent;
  pattern: string;
  /** "Do you want me to notion create: name=Leg Press, ...?" */
  question: string;
  /** Human-phrased call summary used for the deny acknowledgement turn. */
  description: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalDenial {
  pattern: string;
  reason?: string;
  at: number;
}

interface SessionGrant {
  expiresAt: number;
  once: boolean;
}

interface PersistedGrant {
  grantedAt: number;
}

interface PersistedFile {
  version: 1;
  always: Record<string, Record<string, PersistedGrant>>;
}

export interface ApprovalStoreOptions {
  /** Defaults to $SCALLOPBOT_DATA_DIR or ~/.scallopbot. */
  dataDir?: string;
  now?: () => number;
  /** Session-scope grant lifetime. Default 24h. */
  sessionTtlMs?: number;
  /** Pending prompt lifetime. Default 10 minutes. */
  pendingTtlMs?: number;
}

export const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1_000;
export const SESSION_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;
export const APPROVAL_PROMPT_HINT = 'A yes/no prompt with buttons will be shown to the user; do not ask twice.';

/** Bare affirmative reply (whole message), used when the user types instead of tapping. */
const BARE_AFFIRMATIVE =
  /^\s*(?:yes|yes[,!.]?\s*(?:please|do it|go ahead|do that)|y|yep|yeah|yup|sure|ok(?:ay)?|confirm(?:ed)?|please(?:\s+do)?|go ahead|do it|do that|proceed|go for it|approve(?:d)?|absolutely|of course)\s*[.!]*\s*$/i;
/** Bare negative reply (whole message). */
const BARE_NEGATIVE =
  /^\s*(?:no|nope|nah|n|don['’]?t|do not|cancel|stop|never\s*mind|not now|not yet|deny|denied|skip(?:\s+it)?)\s*[.!,]*(?:\s+(?:thanks|thank you|please))?\s*[.!]*\s*$/i;

export function isBareAffirmative(text: string): boolean {
  return BARE_AFFIRMATIVE.test(stripReplyWrapper(text));
}

export function isBareNegative(text: string): boolean {
  return BARE_NEGATIVE.test(stripReplyWrapper(text));
}

/** Telegram reply wrappers ("[Replying to ...: "..."]\n\nYes") are context, not the answer. */
function stripReplyWrapper(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[Replying to ')) return trimmed;
  const closingQuote = trimmed.lastIndexOf('"]');
  if (closingQuote < 0) return trimmed;
  const tail = trimmed.slice(closingQuote + 2).trim();
  return tail || trimmed;
}

function executableContent(toolUse: ToolUseContent): string {
  const input = toolUse.input ?? {};
  if (toolUse.name === 'bash' && typeof input.command === 'string') return input.command;
  if (toolUse.name === 'run_code' && typeof input.code === 'string') return input.code;
  if (typeof input.command === 'string') return input.command;
  return '';
}

function actionFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['action', 'operation', 'method']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/)[0].toLowerCase();
  }
  return null;
}

function httpMethod(command: string): string | null {
  const explicit = command.match(/(?:-X|--request|--method[=\s])\s*['"]?(GET|POST|PUT|PATCH|DELETE|HEAD)\b/i)?.[1]
    ?? command.match(/\b(?:requests|httpx|axios|got)\s*\.\s*(post|put|patch|delete|get)\s*\(/i)?.[1]
    ?? command.match(/\bmethod\s*[:=]\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)?.[1]
    ?? command.match(/\b(POST|PUT|PATCH|DELETE)\b/)?.[1];
  if (explicit) return explicit.toUpperCase();
  // curl with a body and no explicit method POSTs.
  if (/\bcurl\b/i.test(command) && /(?:--data(?:-raw|-binary|-urlencode)?|-d)\s/i.test(command)) return 'POST';
  return null;
}

function firstHost(command: string): string | null {
  const match = command.match(/https?:\/\/([^/'"\s?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Operations that are never grantable through a one-tap prompt. The pattern
 * for these is null so the agent offers no buttons and the model must stop.
 */
export function hardFloorReason(toolUse: ToolUseContent): string | null {
  const name = toolUse.name.toLowerCase();
  const input = toolUse.input ?? {};
  const command = executableContent(toolUse);
  if (command) {
    if (/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i.test(command) || /\brm\s+-r\s+-f\b|\brm\s+-f\s+-r\b/i.test(command)) {
      return 'rm -rf is never approvable';
    }
    if (/\bgit\s+push\b[^\n;&|]*(?:--force\b|-f\b|--force-with-lease\b)/i.test(command)) {
      return 'git push --force is never approvable';
    }
    if (/\bmkfs(?:\.\w+)?\b/i.test(command) || /:\(\)\s*\{\s*:\|:\s*&\s*\}/.test(command)) {
      return 'destructive system command is never approvable';
    }
    if (httpMethod(command) === 'DELETE') return 'HTTP DELETE is never approvable';
  }
  if (typeof input.method === 'string' && input.method.trim().toUpperCase() === 'DELETE') {
    return 'HTTP DELETE is never approvable';
  }
  if (/^(?:send_file|send_message|telegram_send)$/.test(name)) {
    const target = ['chat_id', 'chatId', 'chat', 'to', 'recipient', 'channel', 'channel_id', 'target']
      .map(key => input[key])
      .find(value => value !== undefined && value !== null && String(value).trim() !== '');
    if (target !== undefined) return 'sending to a different chat is never approvable';
  }
  if (name === 'manage_skills' && /^set_key$/i.test(actionFromInput(input) ?? '')) {
    return 'manage_skills set_key is never approvable';
  }
  return null;
}

/**
 * Coarse grant key for a tool call: `notion:create`, `bash:POST api.notion.com`,
 * `bash:git push`, `write_file`. Null when the call sits on a hard floor.
 */
export function grantPatternFor(toolUse: ToolUseContent): string | null {
  if (hardFloorReason(toolUse)) return null;
  const name = toolUse.name.toLowerCase();
  const input = toolUse.input ?? {};
  if (name === 'bash' || name === 'run_code') {
    const command = executableContent(toolUse);
    const host = firstHost(command);
    if (host) {
      const method = httpMethod(command) ?? 'GET';
      return `${name}:${method} ${host}`;
    }
    const words = command.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return name;
    const head = words[0].toLowerCase();
    if (/^(?:git|gh|npm|npx|pnpm|yarn|docker|pm2|systemctl)$/.test(head) && words[1] && !words[1].startsWith('-')) {
      return `${name}:${head} ${words[1].toLowerCase()}`;
    }
    return `${name}:${head}`;
  }
  const action = actionFromInput(input);
  return action ? `${name}:${action}` : name;
}

function defaultDataDir(): string {
  return process.env.SCALLOPBOT_DATA_DIR || join(homedir(), '.scallopbot');
}

function newId(): string {
  return randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 8);
}

export class ApprovalStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly pendingTtlMs: number;
  private always: Record<string, Record<string, PersistedGrant>> | null = null;
  private sessionGrants = new Map<string, Map<string, SessionGrant>>();
  private pending = new Map<string, PendingApproval>();
  private denials = new Map<string, ApprovalDenial>();

  constructor(options: ApprovalStoreOptions = {}) {
    this.filePath = join(options.dataDir ?? defaultDataDir(), 'approvals.json');
    this.now = options.now ?? (() => Date.now());
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_GRANT_TTL_MS;
    this.pendingTtlMs = options.pendingTtlMs ?? PENDING_APPROVAL_TTL_MS;
  }

  get path(): string {
    return this.filePath;
  }

  // ---- grants -----------------------------------------------------------

  /** True when a grant covers `pattern` for this user (always) or session. */
  has(userId: string, sessionId: string, pattern: string | null): boolean {
    if (!pattern) return false;
    const sessionKey = this.sessionKey(userId, sessionId);
    const grants = this.sessionGrants.get(sessionKey);
    const grant = grants?.get(pattern);
    if (grant) {
      if (grant.expiresAt > this.now()) return true;
      grants!.delete(pattern);
    }
    return !!this.loadAlways()[userId]?.[pattern];
  }

  /**
   * Record a grant. Returns false (and records nothing) when the pattern is
   * null, i.e. the call sits on a hard floor.
   */
  grant(userId: string, sessionId: string, pattern: string | null, scope: ApprovalScope): boolean {
    if (!pattern) return false;
    if (scope === 'always') {
      const always = this.loadAlways();
      always[userId] = { ...(always[userId] ?? {}), [pattern]: { grantedAt: this.now() } };
      this.persist();
      return true;
    }
    const sessionKey = this.sessionKey(userId, sessionId);
    const grants = this.sessionGrants.get(sessionKey) ?? new Map<string, SessionGrant>();
    grants.set(pattern, { expiresAt: this.now() + this.sessionTtlMs, once: scope === 'once' });
    this.sessionGrants.set(sessionKey, grants);
    return true;
  }

  /** Drop `once` grants after the turn they authorized has finished. */
  consumeOnceGrants(sessionId: string): void {
    for (const [key, grants] of this.sessionGrants) {
      if (!key.endsWith(`\n${sessionId}`)) continue;
      for (const [pattern, grant] of grants) {
        if (grant.once) grants.delete(pattern);
      }
      if (grants.size === 0) this.sessionGrants.delete(key);
    }
  }

  listAlways(userId: string): Array<{ pattern: string; grantedAt: number }> {
    const entries = this.loadAlways()[userId] ?? {};
    return Object.entries(entries)
      .map(([pattern, grant]) => ({ pattern, grantedAt: grant.grantedAt }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  clearAlways(userId: string, pattern?: string): number {
    const always = this.loadAlways();
    const entries = always[userId];
    if (!entries) return 0;
    let removed = 0;
    if (pattern) {
      if (entries[pattern]) {
        delete entries[pattern];
        removed = 1;
      }
    } else {
      removed = Object.keys(entries).length;
      delete always[userId];
    }
    if (removed > 0) this.persist();
    return removed;
  }

  clearSession(sessionId: string): void {
    for (const key of [...this.sessionGrants.keys()]) {
      if (key.endsWith(`\n${sessionId}`)) this.sessionGrants.delete(key);
    }
    this.pending.delete(sessionId);
    this.denials.delete(sessionId);
  }

  // ---- pending prompts --------------------------------------------------

  /** Register the blocked call the user is about to be asked about. Newest wins per session. */
  registerPending(input: {
    sessionId: string;
    userId: string;
    toolUse: ToolUseContent;
    question: string;
    description: string;
  }): PendingApproval | null {
    const pattern = grantPatternFor(input.toolUse);
    if (!pattern) return null;
    const createdAt = this.now();
    const pending: PendingApproval = {
      id: newId(),
      sessionId: input.sessionId,
      userId: input.userId,
      toolUse: input.toolUse,
      pattern,
      question: input.question,
      description: input.description,
      createdAt,
      expiresAt: createdAt + this.pendingTtlMs,
    };
    this.pending.set(input.sessionId, pending);
    return pending;
  }

  getPending(sessionId: string): PendingApproval | undefined {
    const pending = this.pending.get(sessionId);
    if (!pending) return undefined;
    if (pending.expiresAt <= this.now()) {
      this.pending.delete(sessionId);
      return undefined;
    }
    return pending;
  }

  findPendingById(id: string): PendingApproval | undefined {
    for (const sessionId of [...this.pending.keys()]) {
      const pending = this.getPending(sessionId);
      if (pending?.id === id) return pending;
    }
    return undefined;
  }

  /** Grant the pending call at `scope` and clear it. Undefined when expired/unknown. */
  approve(id: string, scope: ApprovalScope): PendingApproval | undefined {
    const pending = this.findPendingById(id);
    if (!pending) return undefined;
    this.pending.delete(pending.sessionId);
    this.denials.delete(pending.sessionId);
    this.grant(pending.userId, pending.sessionId, pending.pattern, scope);
    return pending;
  }

  /** Deny the pending call and clear it. Undefined when expired/unknown. */
  deny(id: string, reason?: string): PendingApproval | undefined {
    const pending = this.findPendingById(id);
    if (!pending) return undefined;
    this.pending.delete(pending.sessionId);
    this.recordDenial(pending.sessionId, pending.pattern, reason);
    return pending;
  }

  recordDenial(sessionId: string, pattern: string, reason?: string): void {
    this.denials.set(sessionId, { pattern, reason, at: this.now() });
  }

  getDenial(sessionId: string): ApprovalDenial | undefined {
    return this.denials.get(sessionId);
  }

  /**
   * A typed "yes"/"no" answers the pending prompt just like a button tap.
   * Returns what happened so the caller can log it; the turn still runs.
   */
  applyTextReply(sessionId: string, text: string): 'granted' | 'denied' | null {
    const pending = this.getPending(sessionId);
    if (!pending) return null;
    if (isBareAffirmative(text)) {
      this.approve(pending.id, 'session');
      return 'granted';
    }
    if (isBareNegative(text)) {
      this.deny(pending.id, stripReplyWrapper(text));
      return 'denied';
    }
    return null;
  }

  // ---- persistence ------------------------------------------------------

  private sessionKey(userId: string, sessionId: string): string {
    return `${userId}\n${sessionId}`;
  }

  private loadAlways(): Record<string, Record<string, PersistedGrant>> {
    if (this.always) return this.always;
    this.always = {};
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedFile>;
        if (parsed && typeof parsed === 'object' && parsed.always && typeof parsed.always === 'object') {
          for (const [userId, grants] of Object.entries(parsed.always)) {
            if (!grants || typeof grants !== 'object') continue;
            const clean: Record<string, PersistedGrant> = {};
            for (const [pattern, grant] of Object.entries(grants)) {
              if (typeof pattern !== 'string' || !pattern) continue;
              const grantedAt = typeof grant?.grantedAt === 'number' ? grant.grantedAt : this.now();
              clean[pattern] = { grantedAt };
            }
            if (Object.keys(clean).length > 0) this.always[userId] = clean;
          }
        }
      }
    } catch {
      // Corrupt or unreadable file: start empty; the next persist rewrites it.
      this.always = {};
    }
    return this.always;
  }

  private persist(): void {
    const payload: PersistedFile = { version: 1, always: this.loadAlways() };
    const dir = dirname(this.filePath);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* best effort on non-POSIX */ }
      renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best effort; in-memory state stays authoritative for this process.
    }
  }
}
