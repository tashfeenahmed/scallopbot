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

describe('glob skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find files matching pattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'code');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'code');
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'code');

    const result = runSkill({ pattern: '*.ts' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
    expect(result.output).not.toContain('c.js');
  });

  it('should find files recursively with **', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'root');
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'app');
    fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'util.ts'), 'util');

    const result = runSkill({ pattern: '**/*.ts' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('index.ts');
    expect(result.output).toContain('app.ts');
    expect(result.output).toContain('util.ts');
  });

  it('should support brace alternatives', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'code');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'code');
    fs.writeFileSync(path.join(tmpDir, 'c.py'), 'code');

    const result = runSkill({ pattern: '*.{ts,js}' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.js');
    expect(result.output).not.toContain('c.py');
  });

  it('should respect .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'bundle');
    fs.writeFileSync(path.join(tmpDir, 'src.js'), 'code');

    const result = runSkill({ pattern: '**/*.js' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('src.js');
    expect(result.output).not.toContain('bundle.js');
  });

  it('should search within subdirectory', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'root.ts'), 'root');
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'app');

    const result = runSkill({ pattern: '*.ts', path: 'src' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('app.ts');
    expect(result.output).not.toContain('root.ts');
  });

  it('should return no matches message', () => {
    const result = runSkill({ pattern: '*.xyz' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('(no matches)');
  });

  it('should error on missing pattern', () => {
    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern');
  });

  it('should error on path outside workspace', () => {
    const result = runSkill({ pattern: '*.ts', path: '/etc' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path blocked');
  });

  it('should return sorted results', () => {
    fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'c');
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');

    const result = runSkill({ pattern: '*.ts' }, tmpDir);
    const files = result.output.split('\n');
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
