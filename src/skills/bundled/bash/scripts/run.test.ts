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

  it('requires fail mode for mutating curl requests', async () => {
    const result = await new SkillExecutor().execute(skill, {
      skillName: 'bash',
      cwd: workspace,
      args: { command: "curl -s -X POST https://example.invalid/items -d '{}'" },
    });
    expect(result.success).toBe(false);
    expect(`${result.output ?? ''}${result.error ?? ''}`).toMatch(/--fail-with-body/);
  });

  it('requires typed status checks for other raw HTTP clients', async () => {
    const commands = [
      'http POST https://example.invalid/items name=x',
      `python -c "import requests; requests.post('https://example.invalid/items')"`,
      `node -e "fetch('https://example.invalid/items',{method:'POST'})"`,
    ];
    for (const command of commands) {
      const result = await new SkillExecutor().execute(skill, {
        skillName: 'bash',
        cwd: workspace,
        args: { command },
      });
      expect(result.success).toBe(false);
      expect(`${result.output ?? ''}${result.error ?? ''}`).toMatch(/status|non-2xx/i);
    }
  }, 30_000);

  it('blocks shared Python package replacement but allows an isolated venv pip', async () => {
    const run = (command: string) => new SkillExecutor().execute(skill, {
      skillName: 'bash', cwd: workspace, args: { command },
    });
    const uninstall = await run('pip uninstall -y fpdf pypdf');
    expect(uninstall.success).toBe(false);
    expect(`${uninstall.output ?? ''}${uninstall.error ?? ''}`).toMatch(/virtual environment/i);

    const globalInstall = await run('pip install fpdf2');
    expect(globalInstall.success).toBe(false);
    expect(`${globalInstall.output ?? ''}${globalInstall.error ?? ''}`).toMatch(/venv/i);

    const isolated = await run('/tmp/pdfvenv/bin/pip install --help >/dev/null');
    expect(`${isolated.output ?? ''}${isolated.error ?? ''}`).not.toMatch(/Shared pip install is blocked/i);
  });
});
