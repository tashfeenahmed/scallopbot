/**
 * Verified, versioned skill authoring for the learning loop.
 *
 * The background review fork (and, optionally, the main agent) create and patch
 * procedural skills through this one path, which reuses the evolution engine's
 * safety boundary instead of writing SKILL.md files directly:
 *
 *   build files → verifyMutation (deterministic: documentation-only shape,
 *   size cap, privacy/secret/injection scan) → optional LLM judge → stage →
 *   snapshot live → atomic promote → registry hot-reload → evolution_versions
 *   ledger row (rollback snapshot) → usage provenance (createdBy: 'agent').
 *
 * Every write gets an evolution_versions id; rollback(id) restores the
 * snapshot (or deletes a created skill), and the existing rollback watchdog
 * can auto-revert a regressing version.
 *
 * Ownership: only agent-created local documentation skills can be patched.
 * Bundled, user-installed, workspace and executable skills are immutable here;
 * the right move for those is a new umbrella/companion skill.
 */

import yaml from 'js-yaml';
import type { Logger } from 'pino';
import type { SkillStore, SkillFiles } from '../evolution/skill-store.js';
import { verifyMutation } from '../evolution/verify.js';
import { describeMutationForJudge, type JudgeVerdict } from '../evolution/judge.js';
import { parseFrontmatter } from '../skills/parser.js';
import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';

const SAFE_SKILL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const REFERENCE_FILE = /^references\/[a-z0-9][a-z0-9_-]{0,63}\.md$/;

export interface SkillAuthorDb {
  recordEvolutionVersion(v: {
    target: string; kind: string; at: number; baselineFitness?: number | null; snapshot?: string | null; detail?: Record<string, unknown> | null;
  }): number;
  recordEvolutionDecision(d: {
    at: number; stage: string; outcome: string; reason?: string | null; target?: string | null; detail?: Record<string, unknown> | null;
  }): void;
  getEvolutionVersionById(id: number): {
    id: number; target: string; kind: string; at: number; status: string; snapshot: string | null;
  } | null;
  markEvolutionVersionRolledBack(id: number): void;
}

export interface SkillTargetInfo {
  exists: boolean;
  source?: 'workspace' | 'local' | 'bundled' | 'sdk';
  hasScripts?: boolean;
  /** Instructions body, for viewing non-owned skills. */
  content?: string;
}

export interface SkillAuthorDeps {
  store: SkillStore;
  db: SkillAuthorDb;
  reloadFromDisk: () => Promise<void>;
  /** Live registry lookup (SkillRegistry.getSkill). */
  resolveTarget: (name: string) => SkillTargetInfo;
  /** Optional fail-closed LLM safety judge (evolution judgeMutation). */
  judge?: (description: string) => Promise<JudgeVerdict>;
  /** Tag stored in the version ledger detail (e.g. 'background_review'). */
  source?: string;
  logger?: Logger;
  now?: () => number;
}

export interface SkillAuthorResult {
  success: boolean;
  message: string;
  versionId?: number;
  target?: string;
}

export type SkillPatch =
  | { oldText: string; newText: string; file?: string }
  | { content: string; file?: string };

/** Compose a documentation-only SKILL.md that passes verifyMutation's shape gate. */
export function composeSkillMarkdown(name: string, description: string, body: string): string {
  const frontmatter = yaml.dump(
    { name, description: description.replace(/\s+/g, ' ').trim(), 'user-invocable': false },
    { lineWidth: 1000 },
  ).trimEnd();
  return `---\n${frontmatter}\n---\n\n${body.trim()}\n`;
}

/** Replace exactly one occurrence; falls back to a whitespace-insensitive match. */
export function applyTextPatch(source: string, oldText: string, newText: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (!oldText) return { ok: false, reason: 'old_text is empty' };
  const exactCount = source.split(oldText).length - 1;
  if (exactCount === 1) return { ok: true, text: source.replace(oldText, () => newText) };
  if (exactCount > 1) return { ok: false, reason: `old_text occurs ${exactCount} times; include more surrounding text` };
  if (source.includes(newText) && newText.trim()) {
    return { ok: false, reason: 'old_text not found, and new_text is already present (patch already applied?)' };
  }
  const escaped = oldText.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!escaped) return { ok: false, reason: 'old_text is empty' };
  const matches = [...source.matchAll(new RegExp(escaped, 'g'))];
  if (matches.length === 1) {
    const match = matches[0];
    return { ok: true, text: source.slice(0, match.index) + newText + source.slice(match.index! + match[0].length) };
  }
  return {
    ok: false,
    reason: matches.length > 1
      ? `old_text matches ${matches.length} places; include more surrounding text`
      : 'old_text not found in the skill; view it first and copy the exact text',
  };
}

function artifactText(files: SkillFiles): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, content]) => `--- ${file} ---\n${content}`)
    .join('\n\n');
}

export class SkillAuthor {
  private readonly now: () => number;

  constructor(private readonly deps: SkillAuthorDeps) {
    this.now = deps.now ?? Date.now;
  }

  private decide(stage: string, outcome: string, target: string, extra: { reason?: string; detail?: Record<string, unknown> } = {}): void {
    try {
      this.deps.db.recordEvolutionDecision({
        at: this.now(),
        stage,
        outcome,
        reason: extra.reason ?? null,
        target,
        detail: { source: this.deps.source ?? 'learning', ...extra.detail },
      });
    } catch {
      // The decision log is observability only.
    }
  }

  /** True when the curator owns this skill (agent-created, local, documentation-only). */
  async isAgentOwned(name: string): Promise<boolean> {
    if (!SAFE_SKILL_NAME.test(name)) return false;
    const target = this.deps.resolveTarget(name);
    if (!target.exists || target.source !== 'local' || target.hasScripts) return false;
    const usage = await this.deps.store.getUsage();
    return usage[name]?.createdBy === 'agent';
  }

  async view(name: string): Promise<SkillAuthorResult & { files?: SkillFiles }> {
    if (!SAFE_SKILL_NAME.test(name) && !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
      return { success: false, message: 'Invalid skill name.' };
    }
    if (await this.isAgentOwned(name)) {
      const files = await this.deps.store.snapshotLive(name);
      if (files) {
        return { success: true, message: `${artifactText(files)}\n\n(agent-owned: you can patch this skill)`, files, target: name };
      }
    }
    const target = this.deps.resolveTarget(name);
    if (!target.exists) return { success: false, message: `No skill named "${name}".` };
    return {
      success: true,
      target: name,
      message: `${target.content ?? '(no instructions)'}\n\n(read-only: ${target.source ?? 'unknown'} skill; ` +
        'capture improvements in a new agent-owned umbrella skill instead)',
    };
  }

  async create(input: { name: string; description: string; body: string; rationale?: string }): Promise<SkillAuthorResult> {
    const name = input.name.trim();
    if (!SAFE_SKILL_NAME.test(name)) {
      return { success: false, message: 'name must be lowercase snake/kebab case: ^[a-z][a-z0-9_-]{0,63}$' };
    }
    if (!input.description?.trim()) return { success: false, message: 'description is required (one line: when to use it).' };
    if (!input.body?.trim()) return { success: false, message: 'body is required (the procedure, as markdown).' };
    const target = this.deps.resolveTarget(name);
    const usage = await this.deps.store.getUsage();
    if (target.exists || usage[name]) {
      return { success: false, message: `A skill named "${name}" already exists (or is archived). Patch it or choose another name.` };
    }
    const files: SkillFiles = { 'SKILL.md': composeSkillMarkdown(name, input.description, input.body) };
    return this.commit('create_skill', name, files, input.rationale ?? 'created by learning review');
  }

  async patch(name: string, patch: SkillPatch, rationale?: string): Promise<SkillAuthorResult> {
    if (!(await this.isAgentOwned(name))) {
      return {
        success: false,
        message: `"${name}" is not an agent-owned procedural skill, so it cannot be patched. ` +
          'Create a new umbrella skill that covers it (or patch one you created).',
      };
    }
    const current = await this.deps.store.snapshotLive(name);
    if (!current?.['SKILL.md']) return { success: false, message: `Could not load "${name}".` };
    const file = patch.file?.trim() || 'SKILL.md';
    if (file !== 'SKILL.md' && !REFERENCE_FILE.test(file)) {
      return { success: false, message: 'file must be SKILL.md or references/<name>.md' };
    }
    let nextText: string;
    if ('content' in patch) {
      nextText = patch.content;
    } else {
      const existing = current[file];
      if (existing === undefined) return { success: false, message: `${file} does not exist; use write_reference to create it.` };
      const applied = applyTextPatch(existing, patch.oldText, patch.newText);
      if (!applied.ok) return { success: false, message: applied.reason };
      nextText = applied.text;
    }
    if (nextText === current[file]) return { success: true, message: 'No change (content identical).', target: name };
    return this.commit('patch_skill', name, { ...current, [file]: nextText }, rationale ?? 'patched by learning review');
  }

  async writeReference(name: string, file: string, content: string, rationale?: string): Promise<SkillAuthorResult> {
    const path = file.startsWith('references/') ? file : `references/${file}`;
    const normalized = path.endsWith('.md') ? path : `${path}.md`;
    if (!REFERENCE_FILE.test(normalized)) {
      return { success: false, message: 'reference file must be references/<lowercase-name>.md' };
    }
    if (!content.trim()) return { success: false, message: 'content is required.' };
    return this.patch(name, { file: normalized, content }, rationale ?? `reference ${normalized} written by learning review`);
  }

  /** Verify → judge → stage → snapshot → promote → reload → ledger → provenance. */
  private async commit(kind: 'create_skill' | 'patch_skill', name: string, files: SkillFiles, rationale: string): Promise<SkillAuthorResult> {
    const verdict = await verifyMutation({ kind, target: name, rationale, files }, {});
    if (!verdict.ok) {
      this.decide('verify', 'rejected', name, { reason: verdict.reason, detail: verdict.detail });
      const why = typeof verdict.detail?.why === 'string' ? `: ${verdict.detail.why}` : '';
      return { success: false, message: `Rejected by verification (${verdict.reason}${why}). Fix and retry.` };
    }
    try {
      parseFrontmatter(files['SKILL.md']);
    } catch (error) {
      return { success: false, message: `SKILL.md does not parse: ${(error as Error).message}` };
    }
    if (this.deps.judge) {
      const judged = await this.deps.judge(describeMutationForJudge(kind, name, artifactText(files)));
      if (!judged.approved) {
        this.decide('verify', 'rejected', name, { reason: 'judge_rejected', detail: { judge: judged.reason } });
        return { success: false, message: `Rejected by safety review: ${judged.reason}` };
      }
    }

    const at = this.now();
    try {
      await this.deps.store.stage(name, files);
    } catch (error) {
      this.decide('verify', 'rejected', name, { reason: 'stage_failed', detail: { why: (error as Error).message } });
      return { success: false, message: `Could not stage skill: ${(error as Error).message}` };
    }
    const snapshot = await this.deps.store.snapshotLive(name);
    let promoted = false;
    try {
      await this.deps.store.promote(name);
      promoted = true;
      await this.deps.reloadFromDisk();
      const versionId = this.deps.db.recordEvolutionVersion({
        target: name,
        kind,
        at,
        baselineFitness: null,
        snapshot: snapshot ? JSON.stringify(snapshot) : null,
        detail: { rationale: rationale.slice(0, 300), source: this.deps.source ?? 'learning' },
      });
      try {
        await this.deps.store.markAgentCreated(name, kind === 'patch_skill' ? 'patch' : 'create', at);
      } catch (error) {
        this.decide('promote', 'telemetry_failed', name, { reason: 'usage_metadata_failed', detail: { why: (error as Error).message } });
      }
      this.decide('promote', 'promoted', name, { detail: { kind, versionId, hadPrior: !!snapshot } });
      this.deps.logger?.info({ skill: name, kind, versionId }, 'Learning: skill promoted');
      return {
        success: true,
        target: name,
        versionId,
        message: `${kind === 'create_skill' ? 'Created' : 'Patched'} skill "${name}" (version ${versionId}; rollback by id).`,
      };
    } catch (error) {
      await this.deps.store.discardStaged(name).catch(() => undefined);
      if (promoted) {
        try {
          await this.deps.store.rollback(name, snapshot);
          await this.deps.reloadFromDisk();
        } catch {
          // Reported below; the version ledger never recorded this promotion.
        }
      }
      this.decide('promote', 'failed', name, { reason: 'promote_failed', detail: { why: (error as Error).message } });
      return { success: false, message: `Promotion failed: ${(error as Error).message}` };
    }
  }

  /** Restore the snapshot behind one ledger row (delete when the skill was created). */
  async rollback(versionId: number): Promise<SkillAuthorResult> {
    const version = this.deps.db.getEvolutionVersionById(versionId);
    if (!version || (version.kind !== 'create_skill' && version.kind !== 'patch_skill')) {
      return { success: false, message: `No skill version ${versionId}.` };
    }
    if (version.status !== 'active') {
      return { success: false, message: `Version ${versionId} is ${version.status}; only the active version can be rolled back.` };
    }
    let snapshot: SkillFiles | null = null;
    if (version.snapshot) {
      try {
        snapshot = JSON.parse(version.snapshot) as SkillFiles;
      } catch {
        return { success: false, message: `Version ${versionId} has an unreadable snapshot.` };
      }
    }
    await this.deps.store.rollback(version.target, snapshot);
    await this.deps.reloadFromDisk();
    this.deps.db.markEvolutionVersionRolledBack(versionId);
    this.decide('rollback', 'rolled_back', version.target, { reason: 'manual', detail: { versionId } });
    return { success: true, target: version.target, message: `Rolled back ${version.target} version ${versionId}.` };
  }
}

export const SKILL_MANAGE_TOOL_NAME = 'skill_manage';

/**
 * Native tool over SkillAuthor. Actions:
 *   view {name}
 *   create {name, description, body}
 *   patch {name, old_text, new_text, file?} | {name, content, file?}
 *   write_reference {name, file, content}
 */
export function createSkillManageSkill(author: SkillAuthor): Skill {
  return defineSkill(
    SKILL_MANAGE_TOOL_NAME,
    'Create or improve procedural skills (reusable how-to instructions loaded with load_procedure). ' +
    'Prefer patching an existing agent-owned skill over creating a new one; create class-level skills, not one-off logs. ' +
    'Every write is safety-verified and versioned with rollback.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['view', 'create', 'patch', 'write_reference'], description: 'view | create | patch | write_reference' },
        name: { type: 'string', description: 'Skill name (lowercase, e.g. deploy_static_site)' },
        description: { type: 'string', description: 'create: one line saying when to use it (≤300 chars)' },
        body: { type: 'string', description: 'create: the procedure in markdown (steps, pitfalls, checks)' },
        old_text: { type: 'string', description: 'patch: exact text to replace (unique)' },
        new_text: { type: 'string', description: 'patch: replacement text' },
        content: { type: 'string', description: 'patch: full new file content; write_reference: the reference text' },
        file: { type: 'string', description: 'patch/write_reference: SKILL.md (default) or references/<name>.md' },
        reason: { type: 'string', description: 'Why (the lesson learned)' },
      },
      required: ['action', 'name'],
    })
    .onNativeExecute(async ctx => {
      const str = (key: string) => (typeof ctx.args[key] === 'string' ? (ctx.args[key] as string) : '');
      const action = str('action');
      const name = str('name').trim();
      let result: SkillAuthorResult;
      try {
        switch (action) {
          case 'view':
            result = await author.view(name);
            break;
          case 'create':
            result = await author.create({ name, description: str('description'), body: str('body'), rationale: str('reason') });
            break;
          case 'patch':
            result = str('old_text')
              ? await author.patch(name, { oldText: str('old_text'), newText: str('new_text'), file: str('file') || undefined }, str('reason') || undefined)
              : str('content')
                ? await author.patch(name, { content: str('content'), file: str('file') || undefined }, str('reason') || undefined)
                : { success: false, message: 'patch needs old_text + new_text, or content.' };
            break;
          case 'write_reference':
            result = await author.writeReference(name, str('file'), str('content'), str('reason') || undefined);
            break;
          default:
            result = { success: false, message: 'action must be view, create, patch or write_reference.' };
        }
      } catch (error) {
        result = { success: false, message: `skill_manage failed: ${(error as Error).message}` };
      }
      return result.success
        ? { success: true, output: result.message }
        : { success: false, output: result.message, error: result.message };
    })
    .build()
    .skill;
}
