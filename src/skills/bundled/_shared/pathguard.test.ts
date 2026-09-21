import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isWithin, isWithinAny } from './pathguard.js';

describe('isWithin', () => {
  it('accepts the root itself and paths inside it', () => {
    expect(isWithin('/home/u/ws', '/home/u/ws')).toBe(true);
    expect(isWithin('/home/u/ws', '/home/u/ws/a.ts')).toBe(true);
    expect(isWithin('/home/u/ws', '/home/u/ws/deep/dir/a.ts')).toBe(true);
  });

  it('rejects a sibling directory that shares a name prefix', () => {
    // The regression: '/home/u/ws-evil/secret.txt'.startsWith('/home/u/ws')
    // is true, so the old check let a sibling workspace through.
    expect(isWithin('/home/u/ws', '/home/u/ws-evil/secret.txt')).toBe(false);
    expect(isWithin('/home/u/ws', '/home/u/ws.env')).toBe(false);
    expect(isWithin('/home/u/.scallopbot', '/home/u/.scallopbot.evil/keys')).toBe(false);
  });

  it('rejects parents and unrelated paths', () => {
    expect(isWithin('/home/u/ws', '/home/u')).toBe(false);
    expect(isWithin('/home/u/ws', '/etc/passwd')).toBe(false);
    expect(isWithin('/home/u/ws', '/home/u/ws/../ws-evil/a')).toBe(false);
  });

  it('normalizes trailing slashes and relative inputs', () => {
    expect(isWithin('/home/u/ws/', '/home/u/ws/a.ts')).toBe(true);
    const cwd = process.cwd();
    expect(isWithin('.', path.join(cwd, 'a.ts'))).toBe(true);
    expect(isWithin('.', '..')).toBe(false);
  });
});

describe('isWithinAny', () => {
  it('accepts when inside any root and rejects when inside none', () => {
    const roots = ['/home/u/ws', '/home/u/.scallopbot'];
    expect(isWithinAny('/home/u/.scallopbot/skills/x', roots)).toBe(true);
    expect(isWithinAny('/home/u/ws-evil/x', roots)).toBe(false);
    expect(isWithinAny('/etc/passwd', roots)).toBe(false);
  });
});
