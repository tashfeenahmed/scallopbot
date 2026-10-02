/**
 * Core memory (Hermes style).
 *
 * Two small, curated blocks per user, frozen into the session prompt at
 * session start:
 *   - user        (~2,500 chars) facts about the user
 *   - environment (~1,500 chars) facts about the environment, preferences and
 *                  how the user likes things done
 *
 * Writes are atomic add/replace/remove operations through one native tool.
 * An edit that would overflow a block fails and returns every current entry
 * so the model can consolidate first. Every write lands in an append-only
 * history (core_memory_history) and can be rolled back by id.
 *
 * Recall memory (hybrid BM25 + embeddings + graph) is unchanged; this layer is
 * small and high-signal so the frozen prompt stays cacheable.
 */

import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import type { CoreMemoryHistoryRow, ScallopMemoryEntry } from './db.js';
import { resolveStateUserId } from '../utils/state-user-id.js';

export type CoreMemoryBlock = 'user' | 'environment';
export const CORE_MEMORY_BLOCKS: readonly CoreMemoryBlock[] = ['user', 'environment'];

/** Character caps per block (Hermes: MEMORY.md 2,200 / USER.md 1,375). */
export const CORE_MEMORY_LIMITS: Readonly<Record<CoreMemoryBlock, number>> = {
  user: 2500,
  environment: 1500,
};

export const CORE_MEMORY_TOOL_NAME = 'memory';

export const CONSOLIDATE_MESSAGE = 'Over the cap — consolidate now: replace/remove entries, then retry';

/** The subset of ScallopDatabase core memory needs (keeps tests light). */
export interface CoreMemoryDb {
  getCoreMemoryEntries(userId: string, block: string): string[];
  writeCoreMemoryEntries(input: {
    userId: string;
    block: string;
    entries: string[];
    action: string;
    source?: string | null;
    reason?: string | null;
    at?: number;
    expectedBefore?: string[];
  }): number;
  getCoreMemoryHistory(userId: string, limit?: number): CoreMemoryHistoryRow[];
  getCoreMemoryHistoryEntry(id: number): CoreMemoryHistoryRow | null;
  markCoreMemoryHistoryRolledBack(id: number): void;
}

export type CoreMemoryOp =
  | { action: 'add'; block: CoreMemoryBlock; content: string }
  | { action: 'replace'; block: CoreMemoryBlock; oldText: string; content: string }
  | { action: 'remove'; block: CoreMemoryBlock; oldText: string };

export interface CoreMemoryWriteMeta {
  /** Who wrote it: 'tool' | 'background_review' | 'refine' | 'seed' | 'rollback' | ... */
  source?: string;
  reason?: string;
  at?: number;
}

export interface CoreMemoryResult {
  success: boolean;
  /** Text for the model (tool output or error). */
  message: string;
  entries: string[];
  chars: number;
  limit: number;
  historyId?: number;
  /** True when the op changed nothing (e.g. duplicate add). */
  unchanged?: boolean;
}

export function isCoreMemoryBlock(value: unknown): value is CoreMemoryBlock {
  return value === 'user' || value === 'environment';
}

/** Normalise an entry: one line, collapsed whitespace, no leading bullet. */
export function normalizeCoreEntry(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .trim();
}

function entryKey(text: string): string {
  return normalizeCoreEntry(text).toLowerCase().replace(/[.!\s]+$/, '');
}

/** Characters a block uses: entries joined by newlines. */
export function coreMemoryChars(entries: readonly string[]): number {
  return entries.join('\n').length;
}

function formatEntries(entries: readonly string[]): string {
  if (entries.length === 0) return '(empty)';
  return entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n');
}

function usageLine(block: CoreMemoryBlock, chars: number, limit: number): string {
  const pct = Math.round((chars / limit) * 100);
  return `${block} block: ${pct}% (${chars}/${limit} chars)`;
}

export class CoreMemoryStore {
  private readonly limits: Record<CoreMemoryBlock, number>;

  constructor(
    private readonly db: CoreMemoryDb,
    options: { limits?: Partial<Record<CoreMemoryBlock, number>> } = {},
  ) {
    this.limits = { ...CORE_MEMORY_LIMITS, ...options.limits };
  }

  limit(block: CoreMemoryBlock): number {
    return this.limits[block];
  }

  get(userId: string, block: CoreMemoryBlock): string[] {
    return this.db.getCoreMemoryEntries(userId, block);
  }

  usage(userId: string, block: CoreMemoryBlock): { chars: number; limit: number; percent: number } {
    const chars = coreMemoryChars(this.get(userId, block));
    const limit = this.limit(block);
    return { chars, limit, percent: Math.round((chars / limit) * 100) };
  }

  isEmpty(userId: string): boolean {
    return CORE_MEMORY_BLOCKS.every(block => this.get(userId, block).length === 0);
  }

  /** True once anything (even a later removal) has been written for this user. */
  hasHistory(userId: string): boolean {
    return this.db.getCoreMemoryHistory(userId, 1).length > 0;
  }

  history(userId: string, limit = 50): CoreMemoryHistoryRow[] {
    return this.db.getCoreMemoryHistory(userId, limit);
  }

  /** Apply one atomic add/replace/remove. Overflow fails with every entry listed. */
  apply(userId: string, op: CoreMemoryOp, meta: CoreMemoryWriteMeta = {}): CoreMemoryResult {
    const block = op.block;
    const limit = this.limit(block);
    const before = this.get(userId, block);
    const fail = (message: string): CoreMemoryResult => ({
      success: false,
      message,
      entries: before,
      chars: coreMemoryChars(before),
      limit,
    });

    let after: string[];
    if (op.action === 'add') {
      const content = normalizeCoreEntry(op.content ?? '');
      if (!content) return fail('content is required for add.');
      if (before.some(entry => entryKey(entry) === entryKey(content))) {
        return {
          success: true,
          unchanged: true,
          message: `Already in core memory; nothing changed. ${usageLine(block, coreMemoryChars(before), limit)}.`,
          entries: before,
          chars: coreMemoryChars(before),
          limit,
        };
      }
      after = [...before, content];
    } else {
      const needle = normalizeCoreEntry(op.oldText ?? '').toLowerCase();
      if (!needle) return fail(`old_text is required for ${op.action}: a unique substring of the entry to change.`);
      const matches = before
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.toLowerCase().includes(needle));
      if (matches.length === 0) {
        return fail(`No ${block} entry contains "${op.oldText}". Current entries:\n${formatEntries(before)}`);
      }
      // An exact match wins over substring ambiguity.
      const exact = matches.filter(({ entry }) => entryKey(entry) === entryKey(op.oldText));
      const chosen = exact.length === 1 ? exact : matches;
      if (chosen.length > 1) {
        return fail(
          `old_text matches ${chosen.length} ${block} entries; use a longer, unique substring:\n` +
          chosen.map(({ entry, index }) => `${index + 1}. ${entry}`).join('\n'),
        );
      }
      const target = chosen[0].index;
      if (op.action === 'remove') {
        after = before.filter((_, index) => index !== target);
      } else {
        const content = normalizeCoreEntry(op.content ?? '');
        if (!content) return fail('content is required for replace (use remove to delete).');
        after = before.map((entry, index) => (index === target ? content : entry));
        // Replacing into a duplicate of another entry collapses the two.
        after = after.filter((entry, index) =>
          index === target || entryKey(entry) !== entryKey(content));
      }
    }

    const chars = coreMemoryChars(after);
    if (chars > limit) {
      return fail(
        `${CONSOLIDATE_MESSAGE}. The ${block} block would be ${chars}/${limit} chars ` +
        `(currently ${coreMemoryChars(before)}). Current ${block} entries:\n${formatEntries(before)}`,
      );
    }

    const historyId = this.db.writeCoreMemoryEntries({
      userId,
      block,
      entries: after,
      action: op.action,
      source: meta.source ?? 'tool',
      reason: meta.reason ?? null,
      at: meta.at,
      expectedBefore: before,
    });
    const verb = op.action === 'add' ? 'Added' : op.action === 'replace' ? 'Replaced' : 'Removed';
    return {
      success: true,
      message: `${verb}. ${usageLine(block, chars, limit)}, ${after.length} entries. ` +
        'Applies from the next session (this session keeps its start-of-session snapshot).',
      entries: after,
      chars,
      limit,
      historyId,
    };
  }

  /**
   * Undo one history row: restore the block to its `before` state. The undo is
   * itself a versioned write, so it can be rolled back too.
   */
  rollback(historyId: number, meta: CoreMemoryWriteMeta = {}): CoreMemoryResult {
    const row = this.db.getCoreMemoryHistoryEntry(historyId);
    if (!row || !isCoreMemoryBlock(row.block)) {
      return { success: false, message: `No core memory edit with id ${historyId}.`, entries: [], chars: 0, limit: 0 };
    }
    const block = row.block;
    const limit = this.limit(block);
    if (row.rolledBack) {
      const entries = this.get(row.userId, block);
      return { success: false, message: `Edit ${historyId} was already rolled back.`, entries, chars: coreMemoryChars(entries), limit };
    }
    const newId = this.db.writeCoreMemoryEntries({
      userId: row.userId,
      block,
      entries: row.before,
      action: 'rollback',
      source: meta.source ?? 'rollback',
      reason: meta.reason ?? `rollback of edit ${historyId}`,
      at: meta.at,
    });
    this.db.markCoreMemoryHistoryRolledBack(historyId);
    return {
      success: true,
      message: `Rolled back edit ${historyId}.`,
      entries: row.before,
      chars: coreMemoryChars(row.before),
      limit,
      historyId: newId,
    };
  }

  /** Render both blocks with usage headers, for the frozen session prompt. */
  render(userId: string): string {
    return CORE_MEMORY_BLOCKS.map(block => {
      const entries = this.get(userId, block);
      const chars = coreMemoryChars(entries);
      const limit = this.limit(block);
      const pct = Math.round((chars / limit) * 100);
      const body = entries.length > 0 ? entries.map(entry => `- ${entry}`).join('\n') : '(empty)';
      return `## CORE MEMORY — ${block} (${pct}% of ${limit} chars)\n${body}`;
    }).join('\n\n');
  }
}

/**
 * Block text for the session prompt, e.g.
 *   ## CORE MEMORY — user (62% of 2500 chars)
 *   - Lives in Dublin
 * Freeze the result at session start; do not re-render per turn.
 */
export function renderCoreMemory(store: CoreMemoryStore | CoreMemoryDb, userId: string): string {
  const core = store instanceof CoreMemoryStore ? store : new CoreMemoryStore(store);
  return core.render(userId);
}

// ─── Seeding ───────────────────────────────────────────────────────────

export interface CoreMemorySeedSource {
  /** Static profile key/values (ProfileManager.getStaticProfile). */
  getStaticProfile(userId: string): Record<string, string>;
  /** Highest-prominence memories first. */
  getTopMemories(userId: string, limit: number): ScallopMemoryEntry[];
}

/** Adapter from a ScallopMemoryStore to the seed source shape. */
export function seedSourceFromStore(store: {
  getProfileManager(): { getStaticProfile(userId: string): Record<string, string> };
  getDatabase(): { getMemoriesByUser(userId: string, options: { minProminence?: number; isLatest?: boolean; limit?: number }): ScallopMemoryEntry[] };
}): CoreMemorySeedSource {
  return {
    getStaticProfile: userId => store.getProfileManager().getStaticProfile(userId),
    getTopMemories: (userId, limit) =>
      store.getDatabase().getMemoriesByUser(userId, { minProminence: 0.3, isLatest: true, limit }),
  };
}

function isSeedableMemory(memory: ScallopMemoryEntry): boolean {
  return memory.source !== 'assistant'
    && memory.learnedFrom !== 'self_reflection'
    && memory.memoryType !== 'superseded'
    && memory.metadata?.audience !== 'assistant'
    && memory.metadata?.subject !== 'agent'
    && !memory.metadata?.goalType
    // Dated events are episodic recall, not durable core facts.
    && memory.eventDate == null
    && memory.category !== 'event'
    && memory.content.length <= 240;
}

export interface SeedResult {
  seeded: boolean;
  added: Record<CoreMemoryBlock, number>;
}

/**
 * One-off: when a user's core memory has never been written, build it from the
 * static profile and the most prominent durable facts. Preferences go to the
 * environment block, everything else to the user block. Fills to ~80% of each
 * cap so the model has room to add. Never re-seeds once any history exists
 * (a deliberately emptied block stays empty).
 */
export function seedCoreMemory(
  core: CoreMemoryStore,
  source: CoreMemorySeedSource,
  userId: string,
  options: { fillRatio?: number; maxFacts?: number; at?: number } = {},
): SeedResult {
  const added: Record<CoreMemoryBlock, number> = { user: 0, environment: 0 };
  if (core.hasHistory(userId) || !core.isEmpty(userId)) return { seeded: false, added };

  const fillRatio = options.fillRatio ?? 0.8;
  const candidates: Array<{ block: CoreMemoryBlock; content: string }> = [];
  for (const [key, value] of Object.entries(source.getStaticProfile(userId))) {
    if (!value?.trim()) continue;
    const label = key.replace(/[_-]+/g, ' ').trim();
    candidates.push({ block: 'user', content: `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${value.trim()}` });
  }
  for (const memory of source.getTopMemories(userId, options.maxFacts ?? 60)) {
    if (!isSeedableMemory(memory)) continue;
    const subject = typeof memory.metadata?.subject === 'string' && memory.metadata.subject !== 'user'
      ? `[About ${memory.metadata.subject}] `
      : '';
    candidates.push({
      block: memory.category === 'preference' ? 'environment' : 'user',
      content: `${subject}${memory.content}`,
    });
  }

  const entries: Record<CoreMemoryBlock, string[]> = { user: [], environment: [] };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const content = normalizeCoreEntry(candidate.content);
    const key = entryKey(content);
    if (!content || seen.has(key)) continue;
    const next = [...entries[candidate.block], content];
    if (coreMemoryChars(next) > core.limit(candidate.block) * fillRatio) continue;
    seen.add(key);
    entries[candidate.block] = next;
  }

  let seeded = false;
  for (const block of CORE_MEMORY_BLOCKS) {
    if (entries[block].length === 0) continue;
    // Write through the history so the seed itself can be rolled back.
    for (const content of entries[block]) {
      const result = core.apply(userId, { action: 'add', block, content }, { source: 'seed', at: options.at });
      if (result.success && !result.unchanged) {
        added[block]++;
        seeded = true;
      }
    }
  }
  return { seeded, added };
}

// ─── Native tool ───────────────────────────────────────────────────────

export const CORE_MEMORY_TOOL_DESCRIPTION =
  'Edit your curated core memory: two small blocks shown at the top of every session. ' +
  '"user" = durable facts about the user (identity, people, work, situation). ' +
  '"environment" = facts about their setup, preferences and how they like things done. ' +
  'Write each entry as a declarative fact ("Prefers metric units", "Deploys go through CI on main"), ' +
  'never a command to yourself. Keep it high-signal: prefer replacing or merging an existing entry over adding a near-duplicate. ' +
  'Actions: add {content}; replace {old_text, content}; remove {old_text}. old_text is a unique substring of the entry. ' +
  'If a write would exceed the cap it fails and returns every entry: consolidate (replace/remove), then retry. ' +
  'Changes apply from the next session. Episodic or one-off details belong in recall memory, not here.';

export interface CoreMemoryToolDeps {
  core: CoreMemoryStore;
  /** Map a channel user id to the durable state owner (resolveStateUserId). */
  canonicalSingleUserIds?: readonly string[];
  /** Override the user resolver entirely. */
  resolveUserId?: (userId: string | undefined) => string;
  /** History source tag (default 'tool'). */
  source?: string;
}

export function createCoreMemorySkill(deps: CoreMemoryToolDeps, name: string = CORE_MEMORY_TOOL_NAME): Skill {
  const resolveUserId = deps.resolveUserId
    ?? ((userId: string | undefined) => resolveStateUserId(userId, deps.canonicalSingleUserIds ?? []));
  return defineSkill(name, CORE_MEMORY_TOOL_DESCRIPTION)
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add | replace | remove' },
        block: { type: 'string', enum: ['user', 'environment'], description: 'user (facts about the user) or environment (setup, preferences, how they like things done)' },
        content: { type: 'string', description: 'The declarative fact to store (add/replace)' },
        old_text: { type: 'string', description: 'Unique substring of the existing entry (replace/remove)' },
      },
      required: ['action', 'block'],
    })
    .onNativeExecute(async ctx => {
      const action = ctx.args.action;
      const block = ctx.args.block;
      if (action !== 'add' && action !== 'replace' && action !== 'remove') {
        return { success: false, output: '', error: 'action must be add, replace or remove.' };
      }
      if (!isCoreMemoryBlock(block)) {
        return { success: false, output: '', error: 'block must be "user" or "environment".' };
      }
      const content = typeof ctx.args.content === 'string' ? ctx.args.content : '';
      const oldText = typeof ctx.args.old_text === 'string' ? ctx.args.old_text : '';
      const op: CoreMemoryOp = action === 'add'
        ? { action, block, content }
        : action === 'replace'
          ? { action, block, oldText, content }
          : { action, block, oldText };
      try {
        const result = deps.core.apply(resolveUserId(ctx.userId), op, { source: deps.source ?? 'tool' });
        return result.success
          ? { success: true, output: result.message }
          : { success: false, output: result.message, error: result.message };
      } catch (error) {
        return { success: false, output: '', error: `Core memory write failed: ${(error as Error).message}` };
      }
    })
    .build()
    .skill;
}

/**
 * Register the core-memory tool once (gateway). Uses the name `memory`; falls
 * back to `core_memory` if something else already owns `memory`.
 */
export function registerCoreMemoryTool(
  registry: { hasSkill(name: string): boolean; getSkill?(name: string): Skill | undefined; registerSkill(skill: Skill): void },
  deps: CoreMemoryToolDeps,
): Skill {
  const existing = registry.getSkill?.(CORE_MEMORY_TOOL_NAME);
  const taken = registry.hasSkill(CORE_MEMORY_TOOL_NAME)
    && existing?.description !== CORE_MEMORY_TOOL_DESCRIPTION;
  const skill = createCoreMemorySkill(deps, taken ? 'core_memory' : CORE_MEMORY_TOOL_NAME);
  registry.registerSkill(skill);
  return skill;
}
