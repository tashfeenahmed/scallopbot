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

describe('apply_patch skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-patch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should apply a simple replacement hunk', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'line 2',
      'old line',
      'line 4',
      'line 5',
    ].join('\n'));

    const patch = [
      '@@ -2,3 +2,3 @@',
      ' line 2',
      '-old line',
      '+new line',
      ' line 4',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toContain('new line');
    expect(content).not.toContain('old line');
  });

  it('should apply an addition hunk', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -2,2 +2,3 @@',
      ' line 2',
      '+inserted line',
      ' line 3',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content.split('\n')).toContain('inserted line');
  });

  it('should apply a deletion hunk', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'line 2',
      'delete me',
      'line 4',
    ].join('\n'));

    const patch = [
      '@@ -2,3 +2,2 @@',
      ' line 2',
      '-delete me',
      ' line 4',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).not.toContain('delete me');
  });

  it('should strip diff headers', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'old line',
      'line 3',
    ].join('\n'));

    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-old line',
      '+new line',
      ' line 3',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toContain('new line');
  });

  it('should apply with fuzz tolerance', () => {
    // The hunk header says line 3 but content actually starts at line 4
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'extra line',
      'line 2',
      'context',
      'old line',
      'line 5',
    ].join('\n'));

    const patch = [
      '@@ -3,3 +3,3 @@',
      ' context',
      '-old line',
      '+new line',
      ' line 5',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8');
    expect(content).toContain('new line');
  });

  it('should fail when context lines do not match', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' wrong context',
      '-line 2',
      '+new line 2',
      ' line 3',
    ].join('\n');

    const result = runSkill({ path: 'file.ts', patch }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("don't match");
  });

  it('should error on empty patch', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    const result = runSkill({ path: 'file.ts', patch: 'no hunks here' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No valid hunks');
  });

  it('should error on missing path', () => {
    const result = runSkill({ patch: '@@ -1,1 +1,1 @@\n-a\n+b' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('path');
  });

  it('should error on missing patch', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    const result = runSkill({ path: 'file.ts' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('patch');
  });

  it('should error on file not found', () => {
    const result = runSkill({ path: 'nope.ts', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should error on path outside workspace', () => {
    const result = runSkill({
      path: '/etc/passwd',
      patch: '@@ -1,1 +1,1 @@\n-a\n+b',
    }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path blocked');
  });
});
