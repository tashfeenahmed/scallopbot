import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScallopDatabase } from './db.js';

describe('proactive_decisions persistence', () => {
  let dir: string;
  let db: ScallopDatabase;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proactive-dec-'));
    db = new ScallopDatabase(path.join(dir, 'test.db'));
  });
  afterEach(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records and reads back decisions newest-first', () => {
    db.recordProactiveDecision({ userId: 'default', at: 100, stage: 'evaluate', outcome: 'skipped', reason: 'no_signals', detail: { dial: 'moderate' } });
    db.recordProactiveDecision({ userId: 'default', at: 200, stage: 'evaluate', outcome: 'created', detail: { itemsCreated: 1 } });
    db.recordProactiveDecision({ userId: 'default', at: 300, stage: 'deliver', outcome: 'suppressed', reason: 'min_gap' });

    const rows = db.getRecentProactiveDecisions(10);
    expect(rows.length).toBe(3);
    expect(rows[0].at).toBe(300); // newest first
    expect(rows[0].reason).toBe('min_gap');
    expect(rows[2].reason).toBe('no_signals');
  });

  it('round-trips the detail JSON blob', () => {
    db.recordProactiveDecision({ userId: 'default', stage: 'evaluate', outcome: 'skipped', reason: 'cooldown', detail: { cooldownRemainingMs: 3600000, dial: 'moderate' } });
    const [row] = db.getRecentProactiveDecisions(1);
    expect(row.detail).toEqual({ cooldownRemainingMs: 3600000, dial: 'moderate' });
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      db.recordProactiveDecision({ userId: 'default', at: i, stage: 'evaluate', outcome: 'skipped' });
    }
    expect(db.getRecentProactiveDecisions(2).length).toBe(2);
  });

  it('handles a null detail', () => {
    db.recordProactiveDecision({ userId: 'default', stage: 'deliver', outcome: 'queued' });
    const [row] = db.getRecentProactiveDecisions(1);
    expect(row.detail).toBeNull();
    expect(row.outcome).toBe('queued');
  });

  it('prunes old decisions', () => {
    db.recordProactiveDecision({ userId: 'default', at: 100, stage: 'evaluate', outcome: 'skipped' });
    db.recordProactiveDecision({ userId: 'default', at: 5000, stage: 'evaluate', outcome: 'created' });
    const removed = db.pruneProactiveDecisions(1000);
    expect(removed).toBe(1);
    expect(db.getRecentProactiveDecisions(10).length).toBe(1);
  });

  it('does not let cache-hit diagnostics slide a signal cache window', () => {
    db.recordProactiveDecision({
      userId: 'default',
      at: 100,
      stage: 'evaluate',
      outcome: 'skipped',
      reason: 'llm_skipped_all',
      detail: { signalFingerprint: 'same-signal' },
    });
    for (let at = 200; at <= 2_000; at += 100) {
      db.recordProactiveDecision({
        userId: 'default',
        at,
        stage: 'evaluate',
        outcome: 'skipped',
        reason: 'unchanged_signals',
        detail: { signalFingerprint: 'same-signal' },
      });
    }
    db.recordProactiveDecision({
      userId: 'other',
      at: 3_000,
      stage: 'evaluate',
      outcome: 'created',
      detail: { signalFingerprint: 'other-signal' },
    });

    expect(db.getLatestProactiveEvaluationAnchor('default')).toMatchObject({
      at: 100,
      reason: 'llm_skipped_all',
      detail: { signalFingerprint: 'same-signal' },
    });
  });
});
