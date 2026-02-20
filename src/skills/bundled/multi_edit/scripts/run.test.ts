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

describe('multi_edit skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should apply a single edit', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const x = 1;\nconst y = 2;\n');

    const result = runSkill({
      path: 'file.ts',
      edits: [{ old_string: 'const x = 1', new_string: 'const x = 10' }],
    }, tmpDir);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toContain('const x = 10');
    expect(content).toContain('const y = 2');
  });

  it('should apply multiple edits', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.ts'), 'const PORT = 3000;\nconst HOST = "localhost";\n');

    const result = runSkill({
      path: 'config.ts',
      edits: [
        { old_string: 'const PORT = 3000', new_string: 'const PORT = 8080' },
        { old_string: 'const HOST = "localhost"', new_string: 'const HOST = "0.0.0.0"' },
      ],
    }, tmpDir);

    expect(result.success).toBe(true);
    expect(result.output).toContain('2 edit(s)');
    const content = fs.readFileSync(path.join(tmpDir, 'config.ts'), 'utf-8');
    expect(content).toContain('PORT = 8080');
    expect(content).toContain('HOST = "0.0.0.0"');
  });

  it('should fail if old_string not found', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const x = 1;\n');

    const result = runSkill({
      path: 'file.ts',
      edits: [{ old_string: 'const y = 2', new_string: 'const y = 3' }],
    }, tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');

    // File should be unchanged
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toBe('const x = 1;\n');
  });

  it('should fail atomically — no partial writes', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const a = 1;\nconst b = 2;\n');

    const result = runSkill({
      path: 'file.ts',
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' },
        { old_string: 'const c = 3', new_string: 'const c = 30' }, // doesn't exist
      ],
    }, tmpDir);

    expect(result.success).toBe(false);

    // File should be completely unchanged
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('should fail on ambiguous matches', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'hello\nhello\n');

    const result = runSkill({
      path: 'file.ts',
      edits: [{ old_string: 'hello', new_string: 'world' }],
    }, tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('occurrences');
  });

  it('should error on missing path', () => {
    const result = runSkill({ edits: [{ old_string: 'a', new_string: 'b' }] }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('path');
  });

  it('should error on empty edits', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'code');
    const result = runSkill({ path: 'file.ts', edits: [] }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('edits');
  });

  it('should error on file not found', () => {
    const result = runSkill({
      path: 'nope.ts',
      edits: [{ old_string: 'a', new_string: 'b' }],
    }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should error on path outside workspace', () => {
    const result = runSkill({
      path: '/etc/passwd',
      edits: [{ old_string: 'a', new_string: 'b' }],
    }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path blocked');
  });

  it('should handle edits that depend on previous edits', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const x = OLD;\n');

    const result = runSkill({
      path: 'file.ts',
      edits: [
        { old_string: 'const x = OLD', new_string: 'const x = NEW' },
        { old_string: 'const x = NEW', new_string: 'const x = FINAL' },
      ],
    }, tmpDir);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toContain('const x = FINAL');
  });
});
