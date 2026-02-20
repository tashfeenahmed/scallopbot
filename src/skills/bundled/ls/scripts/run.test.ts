import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

function runSkill(args: Record<string, unknown>, cwd: string): { success: boolean; output: string; error?: string; exitCode: number } {
  try {
    const result = execFileSync('npx', ['tsx', path.join(__dirname, 'run.ts')], {
      env: {
        ...process.env,
        SKILL_ARGS: JSON.stringify(args),
        SKILL_CWD: cwd,
      },
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    });
    return JSON.parse(result.trim().split('\n').pop()!);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    const stdout = err.stdout || '';
    const lastLine = stdout.trim().split('\n').pop() || '';
    try {
      return JSON.parse(lastLine);
    } catch {
      return { success: false, output: '', error: err.stderr || 'Script failed', exitCode: 1 };
    }
  }
}

describe('ls skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should list files in current directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'code');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'code');

    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('should show directories with trailing slash', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'code');

    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/');
    expect(result.output).toContain('index.ts');
  });

  it('should sort directories first', () => {
    fs.writeFileSync(path.join(tmpDir, 'zebra.ts'), 'code');
    fs.mkdirSync(path.join(tmpDir, 'alpha'));

    const result = runSkill({}, tmpDir);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('alpha/');
    expect(lines[1]).toBe('zebra.ts');
  });

  it('should hide hidden files by default', () => {
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret');
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'code');

    const result = runSkill({}, tmpDir);
    expect(result.output).not.toContain('.hidden');
    expect(result.output).toContain('visible.ts');
  });

  it('should show hidden files with all flag', () => {
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret');
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'code');

    const result = runSkill({ all: true }, tmpDir);
    expect(result.output).toContain('.hidden');
    expect(result.output).toContain('visible.ts');
  });

  it('should show details in long mode', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'some content');

    const result = runSkill({ long: true }, tmpDir);
    expect(result.success).toBe(true);
    // Long mode should show type, size, and date
    expect(result.output).toMatch(/^- /);
    expect(result.output).toContain('file.ts');
  });

  it('should list subdirectory', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'code');

    const result = runSkill({ path: 'src' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('main.ts');
  });

  it('should error on missing directory', () => {
    const result = runSkill({ path: 'nonexistent' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should error on file path', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'code');
    const result = runSkill({ path: 'file.ts' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a directory');
  });

  it('should error on path outside workspace', () => {
    const result = runSkill({ path: '/etc' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path blocked');
  });

  it('should handle empty directory', () => {
    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
  });
});
