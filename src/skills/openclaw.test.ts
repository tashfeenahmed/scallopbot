/**
 * Tests for OpenClaw-compatible skill system
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseFrontmatter,
  SkillParseError,
  isValidSkillName,
  normalizeSkillName,
} from './parser.js';
import { SkillLoader } from './loader.js';
import { SkillRegistry, createSkillRegistry } from './registry.js';

describe('OpenClaw Skill Parser', () => {
  describe('parseFrontmatter', () => {
    it('should parse minimal skill with frontmatter', () => {
      const content = `---
name: my-skill
description: A test skill
---

# Instructions

This is the skill content.
`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('my-skill');
      expect(result.frontmatter.description).toBe('A test skill');
      expect(result.content).toContain('This is the skill content');
    });

    it('should parse skill with all frontmatter fields', () => {
      const content = `---
name: full-skill
description: A fully configured skill
homepage: https://example.com
user-invocable: true
disable-model-invocation: false
command-dispatch: tool
command-tool: bash
command-arg-mode: raw
metadata:
  openclaw:
    always: true
    emoji: "🔧"
    os: darwin
    primaryEnv: MY_API_KEY
    requires:
      bins:
        - git
        - npm
      anyBins:
        - code
        - vim
      env:
        - MY_API_KEY
      config:
        - ~/.myconfig
    install:
      - id: brew
        kind: brew
        formula: myapp
---

Skill instructions here.
`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('full-skill');
      expect(result.frontmatter.homepage).toBe('https://example.com');
      expect(result.frontmatter['user-invocable']).toBe(true);
      expect(result.frontmatter['disable-model-invocation']).toBe(false);
      expect(result.frontmatter['command-dispatch']).toBe('tool');
      expect(result.frontmatter['command-tool']).toBe('bash');
      expect(result.frontmatter['command-arg-mode']).toBe('raw');

      const metadata = result.frontmatter.metadata;
      expect(metadata?.openclaw?.always).toBe(true);
      expect(metadata?.openclaw?.emoji).toBe('🔧');
      expect(metadata?.openclaw?.os).toBe('darwin');
      expect(metadata?.openclaw?.primaryEnv).toBe('MY_API_KEY');
      expect(metadata?.openclaw?.requires?.bins).toContain('git');
      expect(metadata?.openclaw?.requires?.anyBins).toContain('code');
      expect(metadata?.openclaw?.requires?.env).toContain('MY_API_KEY');
      expect(metadata?.openclaw?.requires?.config).toContain('~/.myconfig');
      expect(metadata?.openclaw?.install?.[0].kind).toBe('brew');
    });

    it('should parse skill with array OS restriction', () => {
      const content = `---
name: multi-os
description: Multi-platform skill
metadata:
  openclaw:
    os:
      - darwin
      - linux
---

Content.
`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.metadata?.openclaw?.os).toEqual(['darwin', 'linux']);
    });

    it('should throw on missing frontmatter', () => {
      const content = `# Just Markdown

No frontmatter here.
`;

      expect(() => parseFrontmatter(content)).toThrow(SkillParseError);
      expect(() => parseFrontmatter(content)).toThrow('missing YAML frontmatter');
    });

    it('should throw on missing name', () => {
      const content = `---
description: No name
---

Content.
`;

      expect(() => parseFrontmatter(content)).toThrow(SkillParseError);
      expect(() => parseFrontmatter(content)).toThrow('name');
    });

    it('should throw on missing description', () => {
      const content = `---
name: no-description
---

Content.
`;

      expect(() => parseFrontmatter(content)).toThrow(SkillParseError);
      expect(() => parseFrontmatter(content)).toThrow('description');
    });

    it('should include path in error message', () => {
      const content = `---
name: test
---

Content.
`;

      try {
        parseFrontmatter(content, '/path/to/SKILL.md');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillParseError);
        expect((error as SkillParseError).message).toContain('/path/to/SKILL.md');
      }
    });

    it('should handle empty content after frontmatter', () => {
      const content = `---
name: empty-content
description: Empty content skill
---
`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('empty-content');
      expect(result.content).toBe('');
    });

    it('should handle Windows-style line endings', () => {
      const content = `---\r\nname: windows\r\ndescription: Windows skill\r\n---\r\n\r\nContent.\r\n`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('windows');
    });
  });

  describe('isValidSkillName', () => {
    it('should accept valid skill names', () => {
      expect(isValidSkillName('my-skill')).toBe(true);
      expect(isValidSkillName('skill123')).toBe(true);
      expect(isValidSkillName('a')).toBe(true);
      expect(isValidSkillName('git-commit')).toBe(true);
    });

    it('should reject invalid skill names', () => {
      expect(isValidSkillName('My-Skill')).toBe(false);
      expect(isValidSkillName('123skill')).toBe(false);
      expect(isValidSkillName('skill_name')).toBe(false);
      expect(isValidSkillName('skill.name')).toBe(false);
      expect(isValidSkillName('')).toBe(false);
    });
  });

  describe('normalizeSkillName', () => {
    it('should normalize skill names', () => {
      expect(normalizeSkillName('My-Skill')).toBe('my-skill');
      expect(normalizeSkillName('skill_name')).toBe('skill-name');
      expect(normalizeSkillName('Skill.Name')).toBe('skill-name');
    });
  });
});

describe('OpenClaw Skill Loader', () => {
  let testDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-skill-test-'));
    loader = new SkillLoader({ workspaceDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('loadFromDirectory', () => {
    it('should load skills from directory', async () => {
      // Create skill directory
      const skillDir = path.join(testDir, '.scallopbot', 'skills', 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---

Test content.
`
      );

      const skills = await loader.loadFromDirectory(
        path.join(testDir, '.scallopbot', 'skills'),
        'workspace'
      );

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('test-skill');
      expect(skills[0].source).toBe('workspace');
      expect(skills[0].available).toBe(true);
    });

    it('should return empty array for non-existent directory', async () => {
      const skills = await loader.loadFromDirectory('/nonexistent', 'local');

      expect(skills).toEqual([]);
    });

    it('should skip invalid skill files', async () => {
      const skillDir = path.join(testDir, 'skills', 'invalid-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `No frontmatter here`
      );

      const skills = await loader.loadFromDirectory(
        path.join(testDir, 'skills'),
        'local'
      );

      expect(skills).toHaveLength(0);
    });
  });

  describe('checkGates', () => {
    it('should pass gates when no requirements', async () => {
      const skillDir = path.join(testDir, '.scallopbot', 'skills', 'no-gates');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: no-gates
description: Skill without gates
---

Content.
`
      );

      const skills = await loader.loadAll();
      const skill = skills.find((s) => s.name === 'no-gates');

      expect(skill?.available).toBe(true);
      expect(skill?.unavailableReason).toBeUndefined();
    });

    it('should fail gates for missing binary', async () => {
      const skillDir = path.join(testDir, '.scallopbot', 'skills', 'needs-binary');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: needs-binary
description: Needs a binary
metadata:
  openclaw:
    requires:
      bins:
        - nonexistent-binary-xyz
---

Content.
`
      );

      const skills = await loader.loadAll();
      const skill = skills.find((s) => s.name === 'needs-binary');

      expect(skill?.available).toBe(false);
      expect(skill?.unavailableReason).toContain('nonexistent-binary-xyz');
    });

    it('should fail gates for missing env var', async () => {
      const skillDir = path.join(testDir, '.scallopbot', 'skills', 'needs-env');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: needs-env
description: Needs an env var
metadata:
  openclaw:
    requires:
      env:
        - NONEXISTENT_ENV_VAR_XYZ
---

Content.
`
      );

      const skills = await loader.loadAll();
      const skill = skills.find((s) => s.name === 'needs-env');

      expect(skill?.available).toBe(false);
      expect(skill?.unavailableReason).toContain('NONEXISTENT_ENV_VAR_XYZ');
    });

    it('should pass anyBins gate if at least one exists', async () => {
      const skillDir = path.join(testDir, '.scallopbot', 'skills', 'any-bins');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: any-bins
description: Needs any of these
metadata:
  openclaw:
    requires:
      anyBins:
        - nonexistent-xyz
        - node
        - also-nonexistent
---

Content.
`
      );

      const skills = await loader.loadAll();
      const skill = skills.find((s) => s.name === 'any-bins');

      // Node should exist, so this should pass
      expect(skill?.available).toBe(true);
    });
  });

  describe('loadAll', () => {
    it('should load skills from multiple sources', async () => {
      // Create workspace skill
      const workspaceSkillDir = path.join(testDir, '.scallopbot', 'skills', 'workspace-skill');
      await fs.mkdir(workspaceSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceSkillDir, 'SKILL.md'),
        `---
name: workspace-skill
description: Workspace skill
---

Content.
`
      );

      const skills = await loader.loadAll();

      expect(skills.length).toBeGreaterThanOrEqual(1);
      expect(skills.some((s) => s.name === 'workspace-skill')).toBe(true);
    });

    it('should respect priority (workspace > local)', async () => {
      // Create skill with same name in both workspace and local
      const workspaceSkillDir = path.join(testDir, '.scallopbot', 'skills', 'priority-skill');
      await fs.mkdir(workspaceSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceSkillDir, 'SKILL.md'),
        `---
name: priority-skill
description: Workspace version
---

Workspace content.
`
      );

      // Create local skill dir with same skill name
      const localSkillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-skills-'));
      const localSkill = path.join(localSkillDir, 'priority-skill');
      await fs.mkdir(localSkill, { recursive: true });
      await fs.writeFile(
        path.join(localSkill, 'SKILL.md'),
        `---
name: priority-skill
description: Local version
---

Local content.
`
      );

      const loaderWithLocal = new SkillLoader({
        workspaceDir: testDir,
        localDir: localSkillDir,
      });

      const skills = await loaderWithLocal.loadAll();
      const skill = skills.find((s) => s.name === 'priority-skill');

      // Workspace should win
      expect(skill?.description).toBe('Workspace version');
      expect(skill?.source).toBe('workspace');

      await fs.rm(localSkillDir, { recursive: true, force: true });
    });
  });
});

describe('OpenClaw Skill Registry', () => {
  let testDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-registry-test-'));

    // Create some test skills
    const skill1Dir = path.join(testDir, '.scallopbot', 'skills', 'available-skill');
    await fs.mkdir(skill1Dir, { recursive: true });
    await fs.writeFile(
      path.join(skill1Dir, 'SKILL.md'),
      `---
name: available-skill
description: An available skill
metadata:
  openclaw:
    emoji: "✅"
---

Available skill content.
`
    );

    const skill2Dir = path.join(testDir, '.scallopbot', 'skills', 'command-skill');
    await fs.mkdir(skill2Dir, { recursive: true });
    await fs.writeFile(
      path.join(skill2Dir, 'SKILL.md'),
      `---
name: command-skill
description: A command dispatch skill
user-invocable: true
command-dispatch: tool
command-tool: bash
---

Command skill content.
`
    );

    const skill3Dir = path.join(testDir, '.scallopbot', 'skills', 'hidden-skill');
    await fs.mkdir(skill3Dir, { recursive: true });
    await fs.writeFile(
      path.join(skill3Dir, 'SKILL.md'),
      `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---

Hidden skill content.
`
    );

    registry = createSkillRegistry(testDir);
    await registry.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('getSkill', () => {
    it('should get skill by name', () => {
      const skill = registry.getSkill('available-skill');

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('available-skill');
    });

    it('should return undefined for unknown skill', () => {
      expect(registry.getSkill('nonexistent')).toBeUndefined();
    });
  });

  describe('getAvailableSkills', () => {
    it('should return only available skills', () => {
      const skills = registry.getAvailableSkills();

      expect(skills.length).toBeGreaterThan(0);
      expect(skills.every((s) => s.available)).toBe(true);
    });
  });

  describe('getUserInvocableSkills', () => {
    it('should return user-invocable skills', () => {
      const skills = registry.getUserInvocableSkills();

      // By default, skills are user-invocable
      expect(skills.length).toBeGreaterThan(0);
    });
  });

  describe('getModelSkills', () => {
    it('should exclude skills with disable-model-invocation', () => {
      const skills = registry.getModelSkills();

      expect(skills.find((s) => s.name === 'hidden-skill')).toBeUndefined();
    });
  });

  describe('executeSkill', () => {
    it('should return skill content for regular skills', async () => {
      const result = await registry.executeSkill('available-skill', {
        sessionId: 'test-session',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Available skill content');
    });

    it('should return dispatch info for command-dispatch skills', async () => {
      const result = await registry.executeSkill('command-skill', {
        sessionId: 'test-session',
        args: 'echo hello',
      });

      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.dispatch).toBe('tool');
      expect(output.tool).toBe('bash');
      expect(output.args).toBe('echo hello');
    });

    it('should fail for unknown skill', async () => {
      const result = await registry.executeSkill('nonexistent', {
        sessionId: 'test-session',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('generateSkillPrompt', () => {
    it('should generate prompt with available skills', () => {
      const prompt = registry.generateSkillPrompt();

      expect(prompt).toContain('Available Skills');
      expect(prompt).toContain('available-skill');
      expect(prompt).not.toContain('hidden-skill');
    });
  });

  describe('getSkillHelpText', () => {
    it('should generate help text with user-invocable skills', () => {
      const help = registry.getSkillHelpText();

      expect(help).toContain('/available-skill');
      expect(help).toContain('An available skill');
    });
  });

  describe('reload', () => {
    it('should reload skills from disk', async () => {
      // Add a new skill
      const newSkillDir = path.join(testDir, '.scallopbot', 'skills', 'new-skill');
      await fs.mkdir(newSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(newSkillDir, 'SKILL.md'),
        `---
name: new-skill
description: Newly added skill
---

New content.
`
      );

      // Reload
      await registry.reload();

      expect(registry.hasSkill('new-skill')).toBe(true);
    });
  });

  describe('generateSkillPrompt (lazy-loading)', () => {
    it('should include skill path for lazy-loading instead of full content', () => {
      const prompt = registry.generateSkillPrompt();

      // Documentation skills use lazy-loading - path included, not full content
      expect(prompt).toContain('available_skills');
      expect(prompt).toContain('available-skill');
      expect(prompt).toContain('SKILL.md'); // Path to the skill file
      expect(prompt).not.toContain('Available skill content'); // Content NOT included
    });

    it('should include instructions to read SKILL.md when skill applies', () => {
      const prompt = registry.generateSkillPrompt();

      // Should tell agent to use read_file to load full instructions
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('SKILL.md');
    });
  });
});

describe('Skills Hot Reload', () => {
  let testDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-hotreload-test-'));
  });

  afterEach(async () => {
    if (loader?.isCurrentlyWatching()) {
      await loader.stopWatching();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('watch mode', () => {
    it('should start and stop watching', async () => {
      const skillsDir = path.join(testDir, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });

      loader = new SkillLoader({
        localDir: skillsDir,
        watch: true,
      });

      await loader.loadAll();

      expect(loader.isCurrentlyWatching()).toBe(false);
      await loader.startWatching();
      expect(loader.isCurrentlyWatching()).toBe(true);
      await loader.stopWatching();
      expect(loader.isCurrentlyWatching()).toBe(false);
    });

    it('should emit events when new skills are added', async () => {
      const skillsDir = path.join(testDir, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });

      loader = new SkillLoader({
        localDir: skillsDir,
        watch: true,
      });

      await loader.loadAll();

      const addPromise = new Promise<string>((resolve) => {
        loader.on('skill:added', (name) => resolve(name));
      });

      await loader.startWatching();

      // Small delay to ensure watcher is ready
      await new Promise((r) => setTimeout(r, 100));

      // Add a new skill
      const newSkillDir = path.join(skillsDir, 'new-watched-skill');
      await fs.mkdir(newSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(newSkillDir, 'SKILL.md'),
        `---
name: new-watched-skill
description: A newly added skill
---

New skill content.
`
      );

      const addedName = await Promise.race([
        addPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 3000)
        ),
      ]);

      expect(addedName).toBe('new-watched-skill');
      expect(loader.getSkill('new-watched-skill')).toBeDefined();
    });

    it('should register event handlers', () => {
      loader = new SkillLoader({
        localDir: path.join(testDir, 'skills'),
        watch: true,
      });

      const handler = vi.fn();
      loader.on('skill:changed', handler);
      loader.on('skill:added', handler);
      loader.on('skill:removed', handler);

      // Just verify no errors are thrown
      expect(true).toBe(true);
    });
  });
});

describe('XDG Path Support', () => {
  let testDir: string;
  let loader: SkillLoader;
  let originalXdgConfig: string | undefined;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-xdg-test-'));
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should expand $XDG_CONFIG_HOME in config paths', async () => {
    const xdgDir = path.join(testDir, 'xdg-config');
    process.env.XDG_CONFIG_HOME = xdgDir;

    // Create a config file
    const configPath = path.join(xdgDir, 'myapp', 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{}');

    // Create skill that requires this config
    const skillDir = path.join(testDir, 'skills', 'xdg-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: xdg-skill
description: Uses XDG config
metadata:
  openclaw:
    requires:
      config:
        - $XDG_CONFIG_HOME/myapp/config.json
---

Content.
`
    );

    loader = new SkillLoader({ localDir: path.join(testDir, 'skills') });
    const skills = await loader.loadAll();
    const skill = skills.find((s) => s.name === 'xdg-skill');

    expect(skill?.available).toBe(true);
  });

  it('should fail gate when XDG config file missing', async () => {
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'nonexistent');

    const skillDir = path.join(testDir, 'skills', 'xdg-missing-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: xdg-missing-skill
description: Missing XDG config
metadata:
  openclaw:
    requires:
      config:
        - $XDG_CONFIG_HOME/missing/config.json
---

Content.
`
    );

    loader = new SkillLoader({ localDir: path.join(testDir, 'skills') });
    const skills = await loader.loadAll();
    const skill = skills.find((s) => s.name === 'xdg-missing-skill');

    expect(skill?.available).toBe(false);
    expect(skill?.unavailableReason).toContain('config');
  });
});
