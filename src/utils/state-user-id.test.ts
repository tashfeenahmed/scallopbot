import { describe, expect, it } from 'vitest';
import { resolveStateUserId, resolveStateUserTimezone } from './state-user-id.js';

describe('resolveStateUserId', () => {
  const aliases = ['owner-example', 'telegram:owner-example'];

  it('maps only the declared channel owner and its unprefixed legacy alias', () => {
    expect(resolveStateUserId('telegram:owner-example', aliases)).toBe('default');
    expect(resolveStateUserId('owner-example', aliases)).toBe('default');
  });

  it('does not collapse a different channel with the same raw identifier', () => {
    expect(resolveStateUserId('api:owner-example', aliases)).toBe('api:owner-example');
  });

  it('keeps undeclared identities isolated', () => {
    expect(resolveStateUserId('telegram:someone-else', aliases)).toBe('telegram:someone-else');
    expect(resolveStateUserId('api:someone-else', aliases)).toBe('api:someone-else');
  });

  it('treats explicit default identities as canonical', () => {
    expect(resolveStateUserId('default', [])).toBe('default');
    expect(resolveStateUserId('api:default', [])).toBe('default');
  });

  it('uses the configured owner timezone for canonical default state', () => {
    const timezones = new Map([
      ['default', 'UTC'],
      ['owner-example', 'Europe/Dublin'],
      ['telegram:owner-example', 'Europe/Dublin'],
    ]);
    const lookup = (userId: string) => timezones.get(userId) ?? 'UTC';

    expect(resolveStateUserTimezone('default', aliases, lookup)).toBe('Europe/Dublin');
    expect(resolveStateUserTimezone('telegram:owner-example', aliases, lookup)).toBe('Europe/Dublin');
  });

  it('does not borrow a single-owner timezone for an unrelated user', () => {
    const lookup = (userId: string) => userId === 'owner-example' ? 'Europe/Dublin' : 'UTC';
    expect(resolveStateUserTimezone('telegram:someone-else', aliases, lookup)).toBe('UTC');
  });
});
