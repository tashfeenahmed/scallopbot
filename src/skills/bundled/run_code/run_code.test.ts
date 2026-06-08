import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { pino } from 'pino';
import { SkillExecutor } from '../../executor.js';
import type { Skill, SkillFrontmatter } from '../../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function runCodeSkill(): Skill {
  const frontmatter: SkillFrontmatter = {
    name: 'run_code',
    description: 'Execute a throwaway program',
    scripts: { run: 'scripts/run.ts' },
  } as SkillFrontmatter;
  return {
    name: 'run_code',
    description: 'Execute a throwaway program',
    path: path.join(here, 'SKILL.md'),
    source: 'bundled',
    frontmatter,
    content: '',
    available: true,
    hasScripts: true,
    scriptsDir: path.join(here, 'scripts'),
  } as Skill;
}

function hasBin(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('run_code skill (integration)', () => {
  const executor = new SkillExecutor(pino({ level: 'silent' }));

  it('executes a multi-line javascript program and captures stdout', async () => {
    const result = await executor.execute(runCodeSkill(), {
      skillName: 'run_code',
      args: {
        language: 'javascript',
        code: 'const xs=[1,2,3,4];\nconsole.log(JSON.stringify({sum: xs.reduce((a,b)=>a+b,0)}));',
      },
      cwd: here,
    });
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output!);
    expect(payload.success).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(JSON.parse(payload.output.trim())).toEqual({ sum: 10 });
  }, 30000);

  it('reports a non-zero exit and stderr for a failing program', async () => {
    const result = await executor.execute(runCodeSkill(), {
      skillName: 'run_code',
      args: {
        language: 'javascript',
        code: 'console.error("boom"); process.exit(3);',
      },
      cwd: here,
    });
    const payload = JSON.parse(result.output!);
    expect(payload.success).toBe(false);
    expect(payload.exitCode).toBe(3);
    expect(payload.error).toContain('boom');
  }, 30000);

  it('rejects an unsupported language', async () => {
    const result = await executor.execute(runCodeSkill(), {
      skillName: 'run_code',
      args: { language: 'rust', code: 'fn main(){}' },
      cwd: here,
    });
    const payload = JSON.parse(result.output!);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/Unsupported language/);
  }, 30000);

  it('rejects empty code', async () => {
    const result = await executor.execute(runCodeSkill(), {
      skillName: 'run_code',
      args: { language: 'javascript', code: '   ' },
      cwd: here,
    });
    const payload = JSON.parse(result.output!);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/No code provided/);
  }, 30000);

  it.runIf(hasBin('python3'))('executes a python program', async () => {
    const result = await executor.execute(runCodeSkill(), {
      skillName: 'run_code',
      args: {
        language: 'python',
        code: 'import json\nprint(json.dumps({"product": 2*3*7}))',
      },
      cwd: here,
    });
    const payload = JSON.parse(result.output!);
    expect(payload.success).toBe(true);
    expect(JSON.parse(payload.output.trim())).toEqual({ product: 42 });
  }, 30000);
});
