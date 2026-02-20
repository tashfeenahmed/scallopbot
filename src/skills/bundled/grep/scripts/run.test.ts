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
      timeout: 15000,
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

describe('grep skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find simple text matches', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const hello = "world";\nconst foo = "bar";\n');

    const result = runSkill({ pattern: 'hello' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('file.ts');
  });

  it('should find regex matches', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'function add(a: number) {}\nfunction sub(b: number) {}\n');

    const result = runSkill({ pattern: 'function\\s+\\w+' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('function add');
    expect(result.output).toContain('function sub');
  });

  it('should search in subdirectories', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const API_KEY = "test";');

    const result = runSkill({ pattern: 'API_KEY' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('API_KEY');
  });

  it('should filter by glob pattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'hello world');
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'hello world');

    const result = runSkill({ pattern: 'hello', glob: '*.ts' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('file.ts');
    expect(result.output).not.toContain('file.js');
  });

  it('should return no matches message', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'nothing here');

    const result = runSkill({ pattern: 'nonexistent_pattern_xyz' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('(no matches)');
  });

  it('should error on missing pattern', () => {
    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern');
  });

  it('should error on path outside workspace', () => {
    const result = runSkill({ pattern: 'test', path: '/etc' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path blocked');
  });

  it('should search within specified path', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.mkdirSync(path.join(tmpDir, 'lib'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'target');
    fs.writeFileSync(path.join(tmpDir, 'lib', 'b.ts'), 'target');

    const result = runSkill({ pattern: 'target', path: 'src' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).not.toContain('b.ts');
  });

  it('should respect .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'target text');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'target text');

    const result = runSkill({ pattern: 'target' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('src.ts');
    expect(result.output).not.toContain('bundle.js');
  });
});
