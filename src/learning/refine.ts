/**
 * Refine pass (Prime "continual harness").
 *
 * Every 25 user turns, or after a compaction, a cheap yes/no review decides
 * whether the harness should change. If yes, one refine call returns strict
 * JSON edits that are applied through the existing versioned stores:
 *
 *   core_memory → CoreMemoryStore      (core_memory_history; rollback by id)
 *   prompt_note → prompt_overrides     (promotePromptEvolution ledger; rollback by id)
 *   skill       → SkillAuthor          (verified + evolution_versions; rollback by id)
 *
 * 20-minute cooldown per user. Runs after the reply (non-blocking schedule),
 * single-flight per user. Every applied edit returns a receipt ref
 * ("core:<id>", "prompt:<id>", "skill:<id>") accepted by rollback(ref).
 */

import type { Logger } from 'pino';
import type { ContentBlock, LLMProvider } from '../providers/types.js';
import { extractJsonObject } from '../evolution/reflect.js';
import { findUnsafeEvolutionContentReason } from '../evolution/privacy.js';
import { isCoreMemoryBlock, type CoreMemoryStore } from '../memory/core-memory.js';
import type { SkillAuthor } from './skill-author.js';

export const REFINE_TURN_INTERVAL = 25;
export const REFINE_COOLDOWN_MS = 20 * 60 * 1000;
/** Prompt-note fragments owned by the refine pass. */
export const PROMPT_NOTE_PREFIX = 'refine_note:';
const MAX_PROMPT_NOTE_CHARS = 600;
const MAX_PROMPT_NOTES = 8;
const MAX_EDITS = 8;
const SAFE_NOTE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export type RefineEditKind = 'core_memory' | 'prompt_note' | 'skill';
export type RefineEditAction = 'add' | 'replace' | 'remove';

export interface RefineEdit {
  action: RefineEditAction;
  kind: RefineEditKind;
  /** core_memory: 'user' | 'environment'; prompt_note: note slug; skill: skill name. */
  id: string;
  content?: string;
  /** core_memory replace/remove: unique substring of the entry. */
  old_text?: string;
  /** skill add: one-line "when to use". */
  description?: string;
  reason: string;
}

export interface RefinePlan {
  summary: string;
  rationale: string;
  expectedOutcome: string;
  edits: RefineEdit[];
}

export interface RefineEditResult {
  edit: RefineEdit;
  applied: boolean;
  message: string;
  /** Rollback handle: core:<historyId> | prompt:<evolutionVersionId> | skill:<versionId>. */
  ref?: string;
}

export interface RefineOutcome {
  ran: boolean;
  skipped?: 'not_due' | 'cooldown' | 'no_provider' | 'review_said_no' | 'bad_json' | 'error' | 'busy';
  plan?: RefinePlan;
  results: RefineEditResult[];
  error?: string;
}

export interface RefineDb {
  getRuntimeKey(key: string): string | null;
  setRuntimeKey(key: string, value: string): void;
  getActivePromptOverride(fragmentId: string): { content: string; version: number } | null;
  getActivePromptOverrides(): Array<{ fragmentId: string; content: string; version: number }>;
  promotePromptEvolution(input: {
    fragmentId: string; content: string; at: number; baselineFitness?: number | null; snapshot?: string | null; detail?: Record<string, unknown> | null;
  }): { promptVersion: number; evolutionVersionId: number };
  recordEvolutionVersion(v: {
    target: string; kind: string; at: number; baselineFitness?: number | null; snapshot?: string | null; detail?: Record<string, unknown> | null;
  }): number;
  rollbackPromptOverride(fragmentId: string, restoreContent: string | null, at: number): void;
  getEvolutionVersionById(id: number): { id: number; target: string; kind: string; status: string; snapshot: string | null } | null;
  markEvolutionVersionRolledBack(id: number): void;
  recordEvolutionDecision(d: {
    at: number; stage: string; outcome: string; reason?: string | null; target?: string | null; detail?: Record<string, unknown> | null;
  }): void;
}

export interface RefineContext {
  /** Recent conversation, compact text (the caller bounds it). */
  transcript: string;
  /** Skills index text (buildSkillIndex), optional. */
  skills?: string;
}

export interface RefineDeps {
  db: RefineDb;
  core: CoreMemoryStore;
  skillAuthor?: SkillAuthor;
  /** Cheap model for the yes/no review. */
  getReviewProvider: () => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  /** Model for the refine call (defaults to the review provider). */
  getRefineProvider?: () => LLMProvider | undefined | Promise<LLMProvider | undefined>;
  getContext: (sessionId: string, userId: string) => RefineContext | Promise<RefineContext>;
  turnInterval?: number;
  cooldownMs?: number;
  now?: () => number;
  schedule?: (fn: () => void) => void;
  logger?: Logger;
  onComplete?: (outcome: RefineOutcome, input: RefineTriggerInput) => void;
}

export interface RefineTriggerInput {
  sessionId: string;
  userId: string;
  /** Cumulative user turns in this session. */
  turnCount: number;
  compacted?: boolean;
}

export const REFINE_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'rationale', 'expectedOutcome', 'edits'],
  properties: {
    summary: { type: 'string' },
    rationale: { type: 'string' },
    expectedOutcome: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'kind', 'id', 'reason'],
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          kind: { type: 'string', enum: ['core_memory', 'prompt_note', 'skill'] },
          id: { type: 'string' },
          content: { type: 'string' },
          old_text: { type: 'string' },
          description: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const REVIEW_SYSTEM = 'You review an AI assistant\'s working harness. Answer with exactly one word: yes or no.';

const REFINE_SYSTEM = `You refine an AI assistant's harness between conversations. You may edit:
- core_memory: curated declarative facts. id "user" (facts about the user) or "environment" (setup, preferences, how they like things done). add {content}; replace {old_text, content}; remove {old_text}.
- prompt_note: short standing guidance appended to the assistant's instructions (≤600 chars, general, no personal data). id is a lowercase slug. add/replace {content}; remove.
- skill: procedural how-to skills. add {id: new_skill_name, description, content: markdown body}; replace {id, content: new markdown body}. Only agent-owned skills can be replaced.
Rules: make few, high-value edits; prefer replace over add; lessons not logs; user corrections are first-class; never encode transient/environment failures; no secrets or personal identifiers in prompt notes or skills.
Respond with STRICT JSON only: {"summary","rationale","expectedOutcome","edits":[{"action","kind","id","content","old_text","description","reason"}]}. Use "edits": [] if nothing should change.`;

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Parse and validate the refine call's JSON. Returns null when unusable. */
export function parseRefinePlan(text: string): RefinePlan | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.edits)) return null;
  const edits: RefineEdit[] = [];
  for (const item of obj.edits.slice(0, MAX_EDITS)) {
    if (!item || typeof item !== 'object') continue;
    const edit = item as Record<string, unknown>;
    const action = edit.action;
    const kind = edit.kind;
    if (action !== 'add' && action !== 'replace' && action !== 'remove') continue;
    if (kind !== 'core_memory' && kind !== 'prompt_note' && kind !== 'skill') continue;
    if (typeof edit.id !== 'string' || !edit.id.trim()) continue;
    edits.push({
      action,
      kind,
      id: edit.id.trim(),
      content: typeof edit.content === 'string' ? edit.content : undefined,
      old_text: typeof edit.old_text === 'string' ? edit.old_text : undefined,
      description: typeof edit.description === 'string' ? edit.description : undefined,
      reason: typeof edit.reason === 'string' ? edit.reason : '',
    });
  }
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    expectedOutcome: typeof obj.expectedOutcome === 'string' ? obj.expectedOutcome : '',
    edits,
  };
}

/** Active refine prompt notes, for the frozen session prompt. */
export function renderPromptNotes(db: Pick<RefineDb, 'getActivePromptOverrides'>): string {
  const notes = db.getActivePromptOverrides().filter(note => note.fragmentId.startsWith(PROMPT_NOTE_PREFIX));
  if (notes.length === 0) return '';
  return `## LEARNED NOTES\n${notes.map(note => `- ${note.content.replace(/\s+/g, ' ').trim()}`).join('\n')}`;
}

export class RefinePass {
  private readonly turnInterval: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly lastTurnBySession = new Map<string, number>();
  private readonly running = new Map<string, Promise<RefineOutcome>>();

  constructor(private readonly deps: RefineDeps) {
    this.turnInterval = deps.turnInterval ?? REFINE_TURN_INTERVAL;
    this.cooldownMs = deps.cooldownMs ?? REFINE_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? (fn => { setImmediate(fn); });
  }

  private cooldownKey(userId: string): string {
    return `refine:lastRunAt:${userId}`;
  }

  /** Due by turn count or compaction (does not check the cooldown). */
  isDue(input: RefineTriggerInput): boolean {
    const last = this.lastTurnBySession.get(input.sessionId) ?? 0;
    return !!input.compacted || input.turnCount - last >= this.turnInterval;
  }

  inCooldown(userId: string): boolean {
    const last = Number(this.deps.db.getRuntimeKey(this.cooldownKey(userId)) ?? 0);
    return this.now() - last < this.cooldownMs;
  }

  /** Non-blocking: schedules a refine run when due. Never throws. */
  maybeScheduleRefine(input: RefineTriggerInput): boolean {
    if (!this.isDue(input) || this.running.has(input.userId)) return false;
    let cooling = false;
    try {
      cooling = this.inCooldown(input.userId);
    } catch {
      cooling = true;
    }
    if (cooling) return false;
    this.lastTurnBySession.set(input.sessionId, input.turnCount);
    const promise = new Promise<RefineOutcome>(resolveRun => {
      this.schedule(() => {
        this.run(input, { force: true })
          .catch(error => ({ ran: false, skipped: 'error' as const, results: [], error: (error as Error).message }))
          .then(outcome => {
            try {
              this.deps.onComplete?.(outcome, input);
            } catch {
              // ignore observer errors
            }
            this.running.delete(input.userId);
            resolveRun(outcome);
          });
      });
    });
    this.running.set(input.userId, promise);
    return true;
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  /**
   * Run the pass. Without `force` it applies the due/cooldown checks itself.
   * The cooldown starts when the yes/no review runs, whatever it answers.
   */
  async run(input: RefineTriggerInput, options: { force?: boolean } = {}): Promise<RefineOutcome> {
    if (!options.force) {
      if (!this.isDue(input)) return { ran: false, skipped: 'not_due', results: [] };
      if (this.inCooldown(input.userId)) return { ran: false, skipped: 'cooldown', results: [] };
      this.lastTurnBySession.set(input.sessionId, input.turnCount);
    }
    const reviewProvider = await this.deps.getReviewProvider();
    if (!reviewProvider) return { ran: false, skipped: 'no_provider', results: [] };

    const context = await this.deps.getContext(input.sessionId, input.userId);
    const coreText = this.deps.core.render(input.userId);
    const notes = renderPromptNotes(this.deps.db) || '(no learned notes)';
    const harness = `${coreText}\n\n${notes}${context.skills ? `\n\n${context.skills}` : ''}`;
    this.deps.db.setRuntimeKey(this.cooldownKey(input.userId), String(this.now()));

    const review = await reviewProvider.complete({
      system: REVIEW_SYSTEM,
      messages: [{
        role: 'user',
        content: `Current harness:\n${harness}\n\nRecent conversation:\n${context.transcript}\n\n` +
          'Did this conversation reveal something durable that the harness should change ' +
          '(a corrected preference, a recurring mistake, a missing or wrong procedure, a stale fact)? Answer yes or no.',
      }],
      maxTokens: 8,
      temperature: 0,
      enableThinking: false,
      purpose: 'refine_review',
      traceSessionId: input.sessionId,
    });
    if (!/^\W*yes\b/i.test(textOf(review.content))) {
      this.decide('review_said_no', input.userId);
      return { ran: false, skipped: 'review_said_no', results: [] };
    }

    const refineProvider = (await this.deps.getRefineProvider?.()) ?? reviewProvider;
    const response = await refineProvider.complete({
      system: REFINE_SYSTEM,
      messages: [{
        role: 'user',
        content: `Current harness:\n${harness}\n\nRecent conversation:\n${context.transcript}\n\nReturn the JSON plan.`,
      }],
      maxTokens: 2048,
      temperature: 0.2,
      enableThinking: false,
      structuredOutput: { name: 'harness_refine_plan', schema: REFINE_PLAN_SCHEMA },
      purpose: 'refine',
      traceSessionId: input.sessionId,
    });
    const plan = parseRefinePlan(textOf(response.content));
    if (!plan) {
      this.decide('bad_json', input.userId);
      return { ran: false, skipped: 'bad_json', results: [] };
    }
    const results: RefineEditResult[] = [];
    for (const edit of plan.edits) {
      results.push(await this.applyEdit(input.userId, edit));
    }
    this.decide('applied', input.userId, {
      summary: plan.summary.slice(0, 300),
      expectedOutcome: plan.expectedOutcome.slice(0, 300),
      applied: results.filter(result => result.applied).map(result => result.ref),
      rejected: results.filter(result => !result.applied).map(result => `${result.edit.kind}:${result.edit.id}: ${result.message}`.slice(0, 200)),
    });
    this.deps.logger?.info(
      { userId: input.userId, edits: plan.edits.length, applied: results.filter(result => result.applied).length },
      'Refine pass applied',
    );
    return { ran: true, plan, results };
  }

  private decide(outcome: string, userId: string, detail: Record<string, unknown> = {}): void {
    try {
      this.deps.db.recordEvolutionDecision({
        at: this.now(), stage: 'refine', outcome, target: `user:${userId}`, detail,
      });
    } catch {
      // observability only
    }
  }

  /** Apply one edit through its versioned store. */
  async applyEdit(userId: string, edit: RefineEdit): Promise<RefineEditResult> {
    const fail = (message: string): RefineEditResult => ({ edit, applied: false, message });
    try {
      if (edit.kind === 'core_memory') {
        if (!isCoreMemoryBlock(edit.id)) return fail('core_memory id must be "user" or "environment"');
        const meta = { source: 'refine', reason: edit.reason };
        const result = edit.action === 'add'
          ? this.deps.core.apply(userId, { action: 'add', block: edit.id, content: edit.content ?? '' }, meta)
          : edit.action === 'replace'
            ? this.deps.core.apply(userId, { action: 'replace', block: edit.id, oldText: edit.old_text ?? '', content: edit.content ?? '' }, meta)
            : this.deps.core.apply(userId, { action: 'remove', block: edit.id, oldText: edit.old_text ?? edit.content ?? '' }, meta);
        if (!result.success) return fail(result.message);
        return { edit, applied: !result.unchanged, message: result.message, ref: result.historyId ? `core:${result.historyId}` : undefined };
      }

      if (edit.kind === 'prompt_note') {
        const slug = edit.id.toLowerCase();
        if (!SAFE_NOTE_ID.test(slug)) return fail('prompt_note id must be a lowercase slug');
        const fragmentId = `${PROMPT_NOTE_PREFIX}${slug}`;
        const prior = this.deps.db.getActivePromptOverride(fragmentId);
        const at = this.now();
        if (edit.action === 'remove') {
          if (!prior) return fail('no such prompt note');
          const versionId = this.deps.db.recordEvolutionVersion({
            target: `prompt:${fragmentId}`,
            kind: 'remove_prompt_note',
            at,
            snapshot: JSON.stringify({ content: prior.content }),
            detail: { reason: edit.reason.slice(0, 300), source: 'refine' },
          });
          this.deps.db.rollbackPromptOverride(fragmentId, null, at);
          return { edit, applied: true, message: 'Prompt note removed.', ref: `prompt:${versionId}` };
        }
        const content = (edit.content ?? '').replace(/\s+/g, ' ').trim();
        if (!content) return fail('content is required');
        if (content.length > MAX_PROMPT_NOTE_CHARS) return fail(`prompt note exceeds ${MAX_PROMPT_NOTE_CHARS} chars`);
        const unsafe = findUnsafeEvolutionContentReason(content);
        if (unsafe) return fail(`rejected: ${unsafe}`);
        if (!prior) {
          const active = this.deps.db.getActivePromptOverrides().filter(note => note.fragmentId.startsWith(PROMPT_NOTE_PREFIX));
          if (active.length >= MAX_PROMPT_NOTES) return fail(`already ${MAX_PROMPT_NOTES} notes; replace or remove one first`);
        }
        if (prior?.content === content) return { edit, applied: false, message: 'unchanged' };
        const promoted = this.deps.db.promotePromptEvolution({
          fragmentId,
          content,
          at,
          snapshot: prior ? JSON.stringify({ content: prior.content }) : null,
          detail: { reason: edit.reason.slice(0, 300), source: 'refine' },
        });
        return { edit, applied: true, message: 'Prompt note saved.', ref: `prompt:${promoted.evolutionVersionId}` };
      }

      // skill
      const author = this.deps.skillAuthor;
      if (!author) return fail('skill authoring is not available');
      if (edit.action === 'remove') return fail('skills are retired by the curator, not removed by refine');
      const body = edit.content ?? '';
      const result = edit.action === 'add'
        ? await author.create({
            name: edit.id,
            description: edit.description || edit.reason || edit.id,
            body,
            rationale: edit.reason,
          })
        : body.trimStart().startsWith('---')
          ? await author.patch(edit.id, { content: body }, edit.reason)
          : await this.replaceSkillBody(author, edit.id, body, edit.reason);
      if (!result.success) return fail(result.message);
      return { edit, applied: true, message: result.message, ref: result.versionId ? `skill:${result.versionId}` : undefined };
    } catch (error) {
      return fail((error as Error).message);
    }
  }

  private async replaceSkillBody(author: SkillAuthor, name: string, body: string, reason: string) {
    const view = await author.view(name);
    const current = view.files?.['SKILL.md'];
    if (!current) return { success: false, message: `"${name}" is not an agent-owned skill` };
    const match = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (!match) return { success: false, message: 'current SKILL.md has no frontmatter' };
    return author.patch(name, { content: `${match[0]}\n${body.trim()}\n` }, reason);
  }

  /** Roll back one applied edit by its receipt ref. */
  async rollback(ref: string): Promise<{ success: boolean; message: string }> {
    const [kind, rawId] = ref.split(':');
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return { success: false, message: `Bad ref "${ref}"` };
    if (kind === 'core') {
      const result = this.deps.core.rollback(id, { source: 'refine_rollback' });
      return { success: result.success, message: result.message };
    }
    if (kind === 'skill') {
      if (!this.deps.skillAuthor) return { success: false, message: 'skill authoring is not available' };
      return this.deps.skillAuthor.rollback(id);
    }
    if (kind === 'prompt') {
      const version = this.deps.db.getEvolutionVersionById(id);
      if (!version || !version.target.startsWith(`prompt:${PROMPT_NOTE_PREFIX}`)) {
        return { success: false, message: `No prompt-note version ${id}` };
      }
      if (version.status !== 'active') return { success: false, message: `Version ${id} is ${version.status}` };
      const fragmentId = version.target.slice('prompt:'.length);
      let restore: string | null = null;
      try {
        restore = version.snapshot ? (JSON.parse(version.snapshot) as { content?: string }).content ?? null : null;
      } catch {
        restore = null;
      }
      this.deps.db.rollbackPromptOverride(fragmentId, restore, this.now());
      this.deps.db.markEvolutionVersionRolledBack(id);
      return { success: true, message: `Rolled back ${fragmentId} version ${id}` };
    }
    return { success: false, message: `Unknown ref kind "${kind}"` };
  }
}

/** Default transcript builder: last N persisted messages, compact, bounded. */
export function buildRefineTranscript(
  messages: Array<{ role: string; content: string }>,
  options: { maxMessages?: number; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 12_000;
  const lines = messages.slice(-(options.maxMessages ?? 40)).map(message => {
    let text = message.content;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        text = parsed
          .map(block => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
            ? block.text
            : block && typeof block === 'object' && 'type' in block && block.type === 'tool_use' && 'name' in block
              ? `[tool ${String(block.name)}]`
              : ''))
          .filter(Boolean)
          .join(' ');
      }
    } catch {
      // plain text
    }
    return `${message.role}: ${text.replace(/\s+/g, ' ').trim().slice(0, 1200)}`;
  }).filter(line => !/^\w+:\s*$/.test(line));
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}
