import { describe, it, expect } from 'vitest';
import { CredentialPool, buildCredentialPool, maskKey } from './credential-pool.js';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CredentialPool construction', () => {
  it('throws with no usable keys', () => {
    expect(() => new CredentialPool([])).toThrow();
    expect(() => new CredentialPool(['', ''])).toThrow();
  });

  it('dedupes keys', () => {
    const pool = new CredentialPool(['a', 'a', 'b']);
    expect(pool.size()).toBe(2);
  });
});

describe('round_robin rotation', () => {
  it('cycles through keys in order', () => {
    const pool = new CredentialPool(['k1', 'k2', 'k3'], { strategy: 'round_robin' });
    expect(pool.next()).toBe('k1');
    expect(pool.next()).toBe('k2');
    expect(pool.next()).toBe('k3');
    expect(pool.next()).toBe('k1');
  });
});

describe('least_used rotation', () => {
  it('always hands out the least-used healthy key', () => {
    const pool = new CredentialPool(['k1', 'k2'], { strategy: 'least_used' });
    expect(pool.next()).toBe('k1'); // both 0 uses → first
    expect(pool.next()).toBe('k2'); // k1 now 1 use → k2
    expect(pool.next()).toBe('k1'); // tie at 1 → first
  });
});

describe('cooldown + recovery', () => {
  it('benches a failed key and skips it until cooldown expires', () => {
    const c = clock();
    const pool = new CredentialPool(['k1', 'k2'], { cooldownMs: 1000, now: c.now });
    expect(pool.next()).toBe('k1');
    pool.reportFailure('k1');
    expect(pool.availableCount()).toBe(1);
    // k1 benched → next() must return k2 repeatedly
    expect(pool.next()).toBe('k2');
    expect(pool.next()).toBe('k2');
    // after cooldown, k1 is healthy again
    c.advance(1001);
    expect(pool.availableCount()).toBe(2);
  });

  it('reportSuccess clears cooldown immediately', () => {
    const c = clock();
    const pool = new CredentialPool(['k1', 'k2'], { cooldownMs: 5000, now: c.now });
    pool.reportFailure('k1');
    expect(pool.availableCount()).toBe(1);
    pool.reportSuccess('k1');
    expect(pool.availableCount()).toBe(2);
  });

  it('grows cooldown with consecutive failures', () => {
    const c = clock();
    const pool = new CredentialPool(['k1', 'k2'], { cooldownMs: 1000, now: c.now });
    pool.reportFailure('k1'); // 1x = 1000ms
    c.advance(1001);
    expect(pool.availableCount()).toBe(2);
    pool.reportFailure('k1'); // 2nd consecutive = 2000ms
    c.advance(1001);
    expect(pool.availableCount()).toBe(1); // still benched (needs 2000ms)
    c.advance(1000);
    expect(pool.availableCount()).toBe(2);
  });

  it('never returns null even when all keys are benched (soonest-to-recover)', () => {
    const c = clock();
    const pool = new CredentialPool(['k1', 'k2'], { cooldownMs: 1000, now: c.now });
    pool.next(); pool.next();
    pool.reportFailure('k2'); // benched until 2000
    pool.reportFailure('k1'); // benched until 1000 (failed later but same window from now)
    expect(pool.availableCount()).toBe(0);
    const fallback = pool.next();
    expect(['k1', 'k2']).toContain(fallback); // returns soonest-to-recover, not null
  });
});

describe('canRotate / stats', () => {
  it('canRotate reflects pool size', () => {
    expect(new CredentialPool(['only']).canRotate()).toBe(false);
    expect(new CredentialPool(['a', 'b']).canRotate()).toBe(true);
  });

  it('stats masks keys', () => {
    const pool = new CredentialPool(['supersecretkey1', 'supersecretkey2']);
    const s = pool.stats();
    expect(s[0].key).not.toContain('secret');
    expect(s[0].healthy).toBe(true);
  });
});

describe('maskKey', () => {
  it('masks long and short keys', () => {
    expect(maskKey('sk-1234567890ab')).toBe('sk-1…ab');
    expect(maskKey('short')).toBe('***');
  });
});

describe('buildCredentialPool', () => {
  it('returns null for zero or one key', () => {
    expect(buildCredentialPool(undefined, undefined)).toBeNull();
    expect(buildCredentialPool('solo', undefined)).toBeNull();
    expect(buildCredentialPool(undefined, ['solo'])).toBeNull();
  });

  it('builds a pool from an apiKeys array', () => {
    const pool = buildCredentialPool('primary', ['primary', 'backup']);
    expect(pool).not.toBeNull();
    expect(pool!.size()).toBe(2);
  });

  it('splits a packed comma/space separated single key', () => {
    const pool = buildCredentialPool('key1, key2 key3', undefined);
    expect(pool).not.toBeNull();
    expect(pool!.size()).toBe(3);
  });
});
