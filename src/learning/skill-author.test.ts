import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScallopDatabase } from '../memory/db.js';
import { SkillStore } from '../evolution/skill-store.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { verifyMutation } from '../evolution/verify.js';
import {
  SkillAuthor,
  applyTextPatch,
  composeSkillMarkdown,
  createSkillManageSkill,
} from './skill-author.js';

describe('SkillAuthor (verified, versioned skill writes)', () => {
  let dir: string;
  let localDir: string;
  let db: ScallopDatabase;
  let store: SkillStore;
  let registry: SkillRegistry;
  let author: SkillAuthor;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-author-'));
    localDir = path.join(dir, 'skills');
    fs.mkdirSync(localDir);
    db = new ScallopDatabase(path.join(dir, 'm.db'));
    store = new SkillStore({ localDir });
    registry = new SkillRegistry(new SkillLoader({ localDir, workspaceDir: path.join(dir, 'ws') }));
    await registry.initialize();
    author = new SkillAuthor({
      store,
      db,
      reloadFromDisk: () => registry.reloadFromDisk(),
      resolveTarget: name => {
        const skill = registry.getSkill(name);
        return skill ? { exists: true, source: skill.source, hasScripts: skill.hasScripts, content: skill.content } : { exists: false };
      },
      source: 'test',
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a documentation skill through verify → promote → ledger → provenance', async () => {
    const result = await author.create({
      name: 'deploy_static_site',
      description: 'Deploy a static site to Cloudflare Pages',
      body: '## Steps\n1. npm run build\n2. wrangler pages deploy dist',
      rationale: 'repeated deploy workflow',
    });
    expect(result.success).toBe(true);
    expect(result.versionId).toBeGreaterThan(0);
    const live = registry.getSkill('deploy_static_site');
    expect(live?.source).toBe('local');
    expect(live?.content).toContain('wrangler pages deploy');
    expect((await store.getUsage()).deploy_static_site.createdBy).toBe('agent');
    expect(db.getEvolutionVersionById(result.versionId!)).toMatchObject({ kind: 'create_skill', status: 'active', snapshot: null });
    // Duplicate names are refused.
    expect((await author.create({ name: 'deploy_static_site', description: 'x', body: 'y' })).success).toBe(false);
  });

  it('rejects unsafe content at the deterministic verify gate', async () => {
    const result = await author.create({ name: 'bad_one', description: 'Cleanup', body: 'Run rm -rf / to clean up' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('safety_failed');
    expect(registry.getSkill('bad_one')).toBeUndefined();
  });

  it('patches agent-owned skills (old/new text), versions them, and rolls back by id', async () => {
    await author.create({ name: 'weekly_report', description: 'Write the weekly report', body: '1. Gather numbers\n2. Send' });
    const patched = await author.patch('weekly_report', { oldText: '2. Send', newText: '2. Check totals\n3. Send' }, 'missed the check');
    expect(patched.success).toBe(true);
    expect(registry.getSkill('weekly_report')?.content).toContain('Check totals');
    expect((await store.getUsage()).weekly_report.patchCount).toBe(1);

    const rolled = await author.rollback(patched.versionId!);
    expect(rolled.success).toBe(true);
    expect(registry.getSkill('weekly_report')?.content).not.toContain('Check totals');
    expect(db.getEvolutionVersionById(patched.versionId!)?.status).toBe('rolled_back');
    expect((await author.rollback(patched.versionId!)).success).toBe(false);
  });

  it('rolling back a create removes the skill', async () => {
    const created = await author.create({ name: 'temp_skill', description: 'Temporary', body: 'steps' });
    // Creating superseded nothing; rollback deletes the live override.
    expect((await author.rollback(created.versionId!)).success).toBe(true);
    expect(registry.getSkill('temp_skill')).toBeUndefined();
  });

  it('writes references files that load_procedure can serve', async () => {
    await author.create({ name: 'tax_return', description: 'File the tax return', body: 'See references/forms.md' });
    const ref = await author.writeReference('tax_return', 'forms', '# Forms\nForm 11 for self-assessed income.');
    expect(ref.success).toBe(true);
    expect(fs.readFileSync(path.join(localDir, 'tax_return', 'references', 'forms.md'), 'utf8')).toContain('Form 11');
    expect((await author.writeReference('tax_return', '../escape', 'x')).success).toBe(false);
  });

  it('refuses to patch skills it does not own', async () => {
    const userDir = path.join(localDir, 'hand_written');
    fs.mkdirSync(userDir);
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), composeSkillMarkdown('hand_written', 'User skill', 'body'));
    await registry.reloadFromDisk();
    expect(registry.getSkill('hand_written')).toBeDefined();
    const result = await author.patch('hand_written', { content: 'new' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('not an agent-owned');
    const view = await author.view('hand_written');
    expect(view.message).toContain('read-only');
  });

  it('runs the optional fail-closed judge', async () => {
    const judge = vi.fn().mockResolvedValue({ approved: false, reason: 'net negative' });
    const judged = new SkillAuthor({
      store, db, reloadFromDisk: () => registry.reloadFromDisk(),
      resolveTarget: name => (registry.getSkill(name) ? { exists: true } : { exists: false }),
      judge,
    });
    const result = await judged.create({ name: 'judged_skill', description: 'x', body: 'y' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('net negative');
    expect(judge).toHaveBeenCalledOnce();
  });

  it('skill_manage tool dispatches actions', async () => {
    const skill = createSkillManageSkill(author);
    const run = (args: Record<string, unknown>) => skill.handler!({ args, workspace: dir, sessionId: 's' });
    expect((await run({ action: 'create', name: 'tool_made', description: 'Made via tool', body: '1. do it' })).success).toBe(true);
    expect((await run({ action: 'view', name: 'tool_made' })).output).toContain('1. do it');
    expect((await run({ action: 'patch', name: 'tool_made', old_text: '1. do it', new_text: '1. do it well' })).success).toBe(true);
    expect((await run({ action: 'patch', name: 'tool_made' })).success).toBe(false);
    expect((await run({ action: 'nope', name: 'tool_made' })).success).toBe(false);
  });
});

describe('applyTextPatch', () => {
  it('replaces a unique exact match, falls back to whitespace-insensitive, and detects re-application', () => {
    expect(applyTextPatch('a b c', 'b', 'B')).toEqual({ ok: true, text: 'a B c' });
    expect(applyTextPatch('step one\n   step   two', 'step two', 'step 2')).toEqual({ ok: true, text: 'step one\n   step 2' });
    expect(applyTextPatch('x x', 'x', 'y')).toMatchObject({ ok: false });
    expect(applyTextPatch('already new', 'old', 'new')).toMatchObject({ ok: false, reason: expect.stringContaining('already') });
    expect(applyTextPatch('abc', 'zzz', 'q')).toMatchObject({ ok: false });
  });
});

describe('verify gate: references files', () => {
  it('allows references/<name>.md but nothing else', async () => {
    const base = composeSkillMarkdown('ref_skill', 'Has references', 'body');
    await expect(verifyMutation({ kind: 'create_skill', target: 'ref_skill', rationale: 't', files: { 'SKILL.md': base, 'references/guide.md': '# Guide' } }, {}))
      .resolves.toMatchObject({ ok: true });
    await expect(verifyMutation({ kind: 'create_skill', target: 'ref_skill', rationale: 't', files: { 'SKILL.md': base, 'references/sub/guide.md': '# Guide' } }, {}))
      .resolves.toMatchObject({ ok: false, reason: 'documentation_only_failed' });
    await expect(verifyMutation({ kind: 'create_skill', target: 'ref_skill', rationale: 't', files: { 'SKILL.md': base, 'references/run.sh': 'echo' } }, {}))
      .resolves.toMatchObject({ ok: false, reason: 'documentation_only_failed' });
  });
});
