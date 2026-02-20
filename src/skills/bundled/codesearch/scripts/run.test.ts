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

describe('codesearch skill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesearch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find TypeScript function definitions', () => {
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), [
      'export function calculateTotal(items: number[]): number {',
      '  return items.reduce((a, b) => a + b, 0);',
      '}',
    ].join('\n'));

    const result = runSkill({ query: 'calculateTotal' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('calculateTotal');
    expect(result.output).toContain('utils.ts');
  });

  it('should find class definitions', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.ts'), [
      'export class UserModel {',
      '  name: string;',
      '}',
    ].join('\n'));

    const result = runSkill({ query: 'UserModel' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('class UserModel');
  });

  it('should find interface definitions', () => {
    fs.writeFileSync(path.join(tmpDir, 'types.ts'), [
      'export interface Config {',
      '  port: number;',
      '}',
    ].join('\n'));

    const result = runSkill({ query: 'Config' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('interface Config');
  });

  it('should find Python function definitions', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.py'), [
      'def process_data(data):',
      '    return data',
    ].join('\n'));

    const result = runSkill({ query: 'process_data', language: 'py' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('def process_data');
  });

  it('should find Go function definitions', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.go'), [
      'func HandleRequest(w http.ResponseWriter, r *http.Request) {',
      '    fmt.Fprintf(w, "Hello")',
      '}',
    ].join('\n'));

    const result = runSkill({ query: 'HandleRequest', language: 'go' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('func HandleRequest');
  });

  it('should auto-detect language from extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'function myFunc() {}');
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'def myFunc():');

    // Without language filter, should find both
    const result = runSkill({ query: 'myFunc' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('app.ts');
    expect(result.output).toContain('app.py');
  });

  it('should filter by language', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'function myFunc() {}');
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'def myFunc():');

    const result = runSkill({ query: 'myFunc', language: 'ts' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('app.ts');
    expect(result.output).not.toContain('app.py');
  });

  it('should group results by file', () => {
    fs.writeFileSync(path.join(tmpDir, 'multi.ts'), [
      'function render() {}',
      'class RenderEngine {}',
    ].join('\n'));

    const result = runSkill({ query: 'render' }, tmpDir);
    expect(result.success).toBe(true);
    // Should have file header
    expect(result.output).toContain('## multi.ts');
  });

  it('should return no results message', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const x = 1;');

    const result = runSkill({ query: 'nonExistentFunction' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('(no definitions found)');
  });

  it('should error on missing query', () => {
    const result = runSkill({}, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('query');
  });
});
