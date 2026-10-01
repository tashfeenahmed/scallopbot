import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { zipSync, strToU8 } from 'fflate';
import { SkillLoader, hasExecutableEntrypoint } from './loader.js';
import { SkillRegistry } from './registry.js';
import { parseFrontmatter } from './parser.js';
import { createLoadProcedureSkill } from '../evolution/procedure-skill.js';
import { installSkillFromGitHub, parseGitHubSkillUrl } from './github-install.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agentskills');
const TMP = path.join(os.tmpdir(), `smartbot-agentskills-${process.pid}-${Date.now()}`);
const BODY_MARKER = 'RELEASE_NOTES_BODY_MARKER';

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function loadRegistry(): Promise<SkillRegistry> {
  const registry = new SkillRegistry(new SkillLoader({ localDir: FIXTURES }));
  await registry.initialize();
  return registry;
}

const ctx = (args: Record<string, unknown>) => ({ args, workspace: TMP, sessionId: 's', userId: 'u' });

describe('agentskills.io / Anthropic SKILL.md compatibility', () => {
  it('parses the optional spec fields', () => {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(FIXTURES, 'release-notes', 'SKILL.md'), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      name: 'release-notes',
      license: 'Apache-2.0',
      compatibility: 'Requires git for scripts/collect_changes.sh',
      'allowed-tools': ['Bash(git:*)', 'Read'],
      metadata: { author: 'example-org', version: '1.0' },
    });
    expect(parsed.frontmatter.metadata?.openclaw).toBeUndefined();

    const minimal = parseFrontmatter('---\nname: tiny\ndescription: Does one thing.\n---\nBody');
    expect(minimal.frontmatter).toEqual({ name: 'tiny', description: 'Does one thing.' });
  });

  it('loads the fixture as an instruction-only skill even though it bundles scripts', async () => {
    const loader = new SkillLoader({ localDir: FIXTURES });
    const skill = (await loader.loadFromDirectory(FIXTURES, 'local')).find(s => s.name === 'release-notes');
    expect(skill).toBeDefined();
    expect(skill!.available).toBe(true);
    expect(skill!.hasScripts).toBe(false);
    expect(skill!.description).toMatch(/^Drafts user-facing release notes/);
  });

  it('lists the description but injects the body only when invoked', async () => {
    const registry = await loadRegistry();
    const prompt = registry.generateSkillPrompt();
    expect(prompt).toContain('# Procedural Skills (load on demand)');
    expect(prompt).toContain('**release-notes**: Drafts user-facing release notes');
    expect(prompt).not.toContain(BODY_MARKER);
    expect(registry.getToolDefinitions().map(t => t.name)).not.toContain('release-notes');

    const loadProcedure = createLoadProcedureSkill(registry);
    const loaded = await loadProcedure.handler!(ctx({ name: 'release-notes' }));
    expect(loaded.success).toBe(true);
    expect(loaded.output).toContain(BODY_MARKER);
    expect(loaded.output).toContain('- references/STYLE.md');
    expect(loaded.output).toContain('- scripts/collect_changes.sh');
    expect(loaded.output).toContain('Tools this skill expects: Bash(git:*), Read');
    // Level 3: bundled reference text stays out until explicitly requested.
    expect(loaded.output).not.toContain('STYLE_GUIDE_MARKER');
  });

  it('reads bundled files on demand, confined to the skill folder', async () => {
    const loadProcedure = createLoadProcedureSkill(await loadRegistry());
    const style = await loadProcedure.handler!(ctx({ name: 'release-notes', file: 'references/STYLE.md' }));
    expect(style.success).toBe(true);
    expect(style.output).toContain('STYLE_GUIDE_MARKER');
    for (const file of ['../release-notes/SKILL.md', '/etc/passwd', 'references/../../x', 'missing.md']) {
      const denied = await loadProcedure.handler!(ctx({ name: 'release-notes', file }));
      expect(denied.success).toBe(false);
    }
  });

  it('keeps OpenClaw-style executables executable', async () => {
    const dir = path.join(TMP, 'exe');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    expect(await hasExecutableEntrypoint(dir, {})).toBe(false);
    expect(await hasExecutableEntrypoint(dir, { inputSchema: { type: 'object', properties: {} } })).toBe(true);
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
    expect(await hasExecutableEntrypoint(dir, {})).toBe(true);
  });
});

describe('GitHub skill install', () => {
  it('parses supported GitHub URLs', () => {
    expect(parseGitHubSkillUrl('https://github.com/anthropics/skills/tree/main/skills/pdf'))
      .toEqual({ owner: 'anthropics', repo: 'skills', ref: 'main', dir: 'skills/pdf' });
    expect(parseGitHubSkillUrl('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r', dir: '' });
    expect(parseGitHubSkillUrl('https://github.com/o/r/blob/v1/a/SKILL.md'))
      .toEqual({ owner: 'o', repo: 'r', ref: 'v1', dir: 'a' });
    expect(parseGitHubSkillUrl('http://github.com/o/r')).toBeNull();
    expect(parseGitHubSkillUrl('https://evil.com/o/r')).toBeNull();
    expect(parseGitHubSkillUrl('https://github.com/o/r/tree/main/a%2F..%2Fb')).toBeNull();
  });

  it('extracts only the chosen folder and drops hidden/traversal entries', async () => {
    const skillMd = fs.readFileSync(path.join(FIXTURES, 'release-notes', 'SKILL.md'), 'utf8');
    const archive = zipSync({
      'repo-main/README.md': strToU8('root readme'),
      'repo-main/skills/release-notes/SKILL.md': strToU8(skillMd),
      'repo-main/skills/release-notes/references/STYLE.md': strToU8('style'),
      'repo-main/skills/release-notes/scripts/collect_changes.sh': strToU8('echo'),
      'repo-main/skills/release-notes/.env': strToU8('SECRET=1'),
      'repo-main/skills/release-notes/../../escape.txt': strToU8('nope'),
      'repo-main/skills/other/SKILL.md': strToU8('---\nname: other\ndescription: x\n---\n'),
    });
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.byteLength) } });
    }) as unknown as typeof fetch;

    const skillsDir = path.join(TMP, 'skills');
    const result = await installSkillFromGitHub(
      'https://github.com/acme/repo/tree/main/skills/release-notes',
      { skillsDir, fetchImpl },
    );
    expect(result.success).toBe(true);
    expect(requested).toEqual(['https://github.com/acme/repo/archive/main.zip']);
    expect(result.skill).toMatchObject({ name: 'release-notes', hasScripts: false, source: 'local' });
    const installed = path.join(skillsDir, 'release-notes');
    expect(fs.readdirSync(installed).sort()).toEqual(['.version.json', 'SKILL.md', 'references', 'scripts']);
    expect(fs.existsSync(path.join(TMP, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'escape.txt'))).toBe(false);
    expect(fs.readdirSync(skillsDir)).toEqual(['release-notes']);

    // And the loader picks it up as an instruction-only skill.
    const loaded = await new SkillLoader({ localDir: skillsDir }).loadFromDirectory(skillsDir, 'local');
    expect(loaded.map(s => [s.name, s.hasScripts])).toEqual([['release-notes', false]]);
  });

  it('fails cleanly when the folder has no SKILL.md', async () => {
    const archive = zipSync({ 'repo-main/docs/README.md': strToU8('x') });
    const fetchImpl = (async () => new Response(archive)) as unknown as typeof fetch;
    const result = await installSkillFromGitHub('https://github.com/acme/repo/tree/main/docs', {
      skillsDir: path.join(TMP, 'skills'), fetchImpl,
    });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/No SKILL.md/);
  });
});
