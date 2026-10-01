import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillExecutor } from '../../../executor.js';
import type { Skill } from '../../../types.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const bashSkill: Skill = {
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
const runCodeDir = join(scriptsDir, '..', '..', 'run_code', 'scripts');
const runCodeSkill: Skill = {
  ...bashSkill,
  name: 'run_code',
  path: join(runCodeDir, '..', 'SKILL.md'),
  frontmatter: { name: 'run_code', description: 'run code' },
  scriptsDir: runCodeDir,
};

const hasSeatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const ENV_KEYS = ['AGENT_WORKSPACE', 'SANDBOX_MODE', 'SANDBOX_BACKEND', 'SANDBOX_NETWORK', 'SANDBOX_HIDE_PATHS'] as const;

describe.runIf(hasSeatbelt)('bash / run_code routed through the seatbelt sandbox', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-sbx-')));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    outside = mkdtempSync(join(homedir(), '.bash-sbx-outside-'));
    process.env.AGENT_WORKSPACE = workspace;
    process.env.SANDBOX_MODE = 'seatbelt';
    delete process.env.SANDBOX_BACKEND;
    delete process.env.SANDBOX_HIDE_PATHS;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('bash can write inside the workspace', async () => {
    const result = await new SkillExecutor().execute(bashSkill, {
      skillName: 'bash', cwd: workspace, args: { command: 'echo ok > a.txt && cat a.txt' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('ok');
  });

  it('bash cannot write outside the workspace', async () => {
    const target = join(outside, 'escape.txt');
    const result = await new SkillExecutor().execute(bashSkill, {
      skillName: 'bash', cwd: workspace, args: { command: `echo pwned > '${target}'` },
    });
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('run_code python/javascript cannot write outside the workspace', async () => {
    const target = join(outside, 'escape-js.txt');
    const result = await new SkillExecutor().execute(runCodeSkill, {
      skillName: 'run_code',
      cwd: workspace,
      args: { language: 'javascript', code: `require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); console.log('wrote')` },
    });
    expect(result.output).not.toContain('"success":true');
    expect(existsSync(target)).toBe(false);
  });

  it('run_code still runs normal programs', async () => {
    const result = await new SkillExecutor().execute(runCodeSkill, {
      skillName: 'run_code', cwd: workspace, args: { language: 'javascript', code: 'console.log(6*7)' },
    });
    expect(result.output).toContain('42');
  });

  it('an unavailable explicit backend refuses instead of running unsandboxed', async () => {
    process.env.SANDBOX_MODE = 'bwrap';
    const result = await new SkillExecutor().execute(bashSkill, {
      skillName: 'bash', cwd: workspace, args: { command: 'echo should-not-run' },
    });
    expect(result.success).toBe(false);
    expect(`${result.output}${result.error ?? ''}`).toMatch(/Sandbox unavailable/);
    expect(result.output).not.toContain('should-not-run\\n');
  });
});
