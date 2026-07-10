import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SkillExecutor } from '../../../executor.js';
import type { Skill } from '../../../types.js';

describe('bash skill workspace confinement', () => {
  let root: string;
  let workspace: string;
  let sibling: string;
  let previousWorkspace: string | undefined;

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const skill: Skill = {
    name: 'bash',
    description: 'test bash skill',
    path: join(scriptsDir, '..', 'SKILL.md'),
    source: 'bundled',
    frontmatter: { name: 'bash', description: 'test bash skill' },
    content: '',
    available: true,
    hasScripts: true,
    scriptsDir,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bash-boundary-'));
    workspace = join(root, 'workspace');
    sibling = join(root, 'workspace-evil');
    await mkdir(workspace);
    await mkdir(sibling);
    previousWorkspace = process.env.AGENT_WORKSPACE;
    process.env.AGENT_WORKSPACE = workspace;
  });

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = previousWorkspace;
    await rm(root, { recursive: true, force: true });
  });

  it('runs relative to the workspace, not the installed skill directory', async () => {
    const result = await new SkillExecutor().execute(skill, {
      skillName: 'bash',
      cwd: workspace,
      args: { command: 'pwd' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(workspace);
    expect(result.output).not.toContain(join('bundled', 'bash'));
  });

  it('blocks a prefix-collision sibling such as workspace-evil', async () => {
    const result = await new SkillExecutor().execute(skill, {
      skillName: 'bash',
      cwd: workspace,
      args: { command: 'pwd', cwd: sibling },
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('escapes workspace');
  });
});
