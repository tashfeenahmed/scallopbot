import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('webfetch skill', () => {
  it('should error on missing url', () => {
    const result = runSkill({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('url');
  });

  it('should error on invalid url', () => {
    const result = runSkill({ url: 'not-a-url' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('should block non-http protocols', () => {
    const result = runSkill({ url: 'ftp://example.com/file' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('http');
  });

  it('should block localhost', () => {
    const result = runSkill({ url: 'http://localhost:8080' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
  });

  it('should block 127.0.0.1', () => {
    const result = runSkill({ url: 'http://127.0.0.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
  });

  it('should block 10.x IPs', () => {
    const result = runSkill({ url: 'http://10.0.0.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
  });

  it('should block 192.168.x IPs', () => {
    const result = runSkill({ url: 'http://192.168.1.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
  });

  it('should block 172.16-31.x IPs', () => {
    const result = runSkill({ url: 'http://172.16.0.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
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
      expect(parsed.error).toContain('SKILL_ARGS');
    }
  });
});
