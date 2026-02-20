import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { execFileSync } from 'child_process';

function runSkill(args: Record<string, unknown>): { success: boolean; output: string; error?: string; exitCode: number } {
  try {
    const result = execFileSync('npx', ['tsx', path.join(__dirname, 'run.ts')], {
      env: {
        ...process.env,
        SKILL_ARGS: JSON.stringify(args),
      },
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

describe('question skill', () => {
  it('should format a simple question', () => {
    const result = runSkill({ question: 'What is your name?' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('What is your name?');
  });

  it('should format question with options', () => {
    const result = runSkill({
      question: 'Which framework?',
      options: ['React', 'Vue', 'Angular'],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Which framework?');
    expect(result.output).toContain('1. React');
    expect(result.output).toContain('2. Vue');
    expect(result.output).toContain('3. Angular');
  });

  it('should handle empty options array', () => {
    const result = runSkill({ question: 'Continue?', options: [] });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Continue?');
    expect(result.output).not.toContain('Options:');
  });

  it('should error on missing question', () => {
    const result = runSkill({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('question');
  });

  it('should error on missing SKILL_ARGS', () => {
    try {
      const result = execFileSync('npx', ['tsx', path.join(__dirname, 'run.ts')], {
        env: { ...process.env, SKILL_ARGS: undefined },
        encoding: 'utf-8',
        timeout: 10000,
      });
      const parsed = JSON.parse(result.trim().split('\n').pop()!);
      expect(parsed.success).toBe(false);
    } catch (e: unknown) {
      const err = e as { stdout?: string };
      const lastLine = (err.stdout || '').trim().split('\n').pop() || '';
      const parsed = JSON.parse(lastLine);
      expect(parsed.success).toBe(false);
    }
  });

  it('should handle single option', () => {
    const result = runSkill({
      question: 'Confirm?',
      options: ['Yes'],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1. Yes');
  });
});
