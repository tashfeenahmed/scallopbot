/**
 * Credential Pool — multi-key rotation with cooldown.
 *
 * The no-paid-models constraint means relying on FREE API keys, which are
 * aggressively rate-limited. Nous's Hermes Agent harness mitigates this with
 * "credential pools": several keys per provider, a rotation strategy, and
 * temporary cooldown of a key that just failed. This is the same idea, kept
 * small and pure so it is trivially unit-testable.
 *
 * On a rate-limit / auth failure, `reportFailure(key)` benches that key for a
 * cooldown window; `next()` skips benched keys and round-robins (or picks the
 * least-recently-used) among the rest. When every key is cooling down, `next()`
 * returns the one whose cooldown expires soonest so the caller always has
 * something to try rather than hard-failing.
 *
 * The clock is injectable so cooldown/recovery can be tested without timers.
 */

export type RotationStrategy = 'round_robin' | 'least_used';

export interface CredentialPoolOptions {
  /** Cooldown applied to a key after a failure, in ms. Default 60s. */
  cooldownMs?: number;
  /** Rotation strategy among healthy keys. Default round_robin. */
  strategy?: RotationStrategy;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

interface KeyState {
  key: string;
  /** Timestamp until which this key is benched (0 = healthy). */
  cooldownUntil: number;
  /** Number of times this key has been handed out. */
  uses: number;
  /** Consecutive failures (resets on success). */
  failures: number;
  /** Last time this key was handed out. */
  lastUsed: number;
}

export class CredentialPool {
  private states: KeyState[];
  private cooldownMs: number;
  private strategy: RotationStrategy;
  private now: () => number;
  private cursor = 0;

  constructor(keys: string[], options: CredentialPoolOptions = {}) {
    const deduped = Array.from(new Set(keys.filter((k) => k && k.length > 0)));
    if (deduped.length === 0) {
      throw new Error('CredentialPool requires at least one non-empty key');
    }
    this.states = deduped.map((key) => ({ key, cooldownUntil: 0, uses: 0, failures: 0, lastUsed: 0 }));
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.strategy = options.strategy ?? 'round_robin';
    this.now = options.now ?? Date.now;
  }

  /** Total number of keys in the pool. */
  size(): number {
    return this.states.length;
  }

  /** How many keys are currently usable (not cooling down). */
  availableCount(): number {
    const t = this.now();
    return this.states.filter((s) => s.cooldownUntil <= t).length;
  }

  /** True if more than one key exists (rotation is meaningful). */
  canRotate(): boolean {
    return this.states.length > 1;
  }

  /**
   * Return the next key to use. Prefers healthy keys per the strategy; if all
   * are cooling down, returns the one recovering soonest (never null).
   */
  next(): string {
    const t = this.now();
    const healthy = this.states.filter((s) => s.cooldownUntil <= t);

    let chosen: KeyState;
    if (healthy.length === 0) {
      // Everyone benched — pick the soonest to recover.
      chosen = this.states.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
    } else if (this.strategy === 'least_used') {
      chosen = healthy.reduce((a, b) => (a.uses <= b.uses ? a : b));
    } else {
      // round_robin: advance the cursor to the next healthy key.
      chosen = this.pickRoundRobin(healthy);
    }

    chosen.uses++;
    chosen.lastUsed = t;
    return chosen.key;
  }

  private pickRoundRobin(healthy: KeyState[]): KeyState {
    const n = this.states.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const state = this.states[idx];
      if (healthy.includes(state)) {
        this.cursor = (idx + 1) % n;
        return state;
      }
    }
    return healthy[0];
  }

  /** Bench a key after a failure for the cooldown window. */
  reportFailure(key: string): void {
    const state = this.states.find((s) => s.key === key);
    if (!state) return;
    state.failures++;
    // Exponential-ish backoff: cooldown grows with consecutive failures, capped.
    const multiplier = Math.min(2 ** (state.failures - 1), 8);
    state.cooldownUntil = this.now() + this.cooldownMs * multiplier;
  }

  /** Mark a key healthy again after a successful call. */
  reportSuccess(key: string): void {
    const state = this.states.find((s) => s.key === key);
    if (!state) return;
    state.failures = 0;
    state.cooldownUntil = 0;
  }

  /** Snapshot for telemetry/debugging. */
  stats(): Array<{ key: string; healthy: boolean; uses: number; failures: number }> {
    const t = this.now();
    return this.states.map((s) => ({
      key: maskKey(s.key),
      healthy: s.cooldownUntil <= t,
      uses: s.uses,
      failures: s.failures,
    }));
  }
}

/** Mask a key for logs: keep a short prefix/suffix only. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

/**
 * Build a pool from ProviderOptions-style inputs. Accepts an explicit list
 * (`apiKeys`), a single `apiKey`, or a comma/whitespace-separated string, and
 * returns null when there is nothing to rotate (≤1 key) so callers can keep the
 * simple single-key path.
 */
export function buildCredentialPool(
  apiKey: string | undefined,
  apiKeys: string[] | undefined,
  options?: CredentialPoolOptions
): CredentialPool | null {
  const collected: string[] = [];
  if (apiKeys && apiKeys.length) collected.push(...apiKeys);
  if (apiKey) {
    // Allow "key1,key2" or "key1 key2" packed into a single env var.
    collected.push(...apiKey.split(/[,\s]+/).filter(Boolean));
  }
  const deduped = Array.from(new Set(collected.filter(Boolean)));
  if (deduped.length <= 1) return null;
  return new CredentialPool(deduped, options);
}
