import { afterEach, describe, expect, it } from 'vitest';
import { ScallopDatabase } from './db.js';

const originalTraceDays = process.env.LLM_TRACE_RETENTION_DAYS;
const originalDecisionDays = process.env.PROACTIVE_DECISION_RETENTION_DAYS;

afterEach(() => {
  if (originalTraceDays === undefined) delete process.env.LLM_TRACE_RETENTION_DAYS;
  else process.env.LLM_TRACE_RETENTION_DAYS = originalTraceDays;
  if (originalDecisionDays === undefined) delete process.env.PROACTIVE_DECISION_RETENTION_DAYS;
  else process.env.PROACTIVE_DECISION_RETENTION_DAYS = originalDecisionDays;
});

describe('diagnostic retention maintenance', () => {
  it('prunes by timestamps at startup-compatible intervals, not insert counts', () => {
    const db = new ScallopDatabase(':memory:');
    const now = Date.UTC(2026, 6, 11);
    const day = 24 * 60 * 60 * 1000;
    for (const ts of [now - 10 * day, now - day]) {
      db.insertLlmTrace({
        ts, purpose: 'rerank', model: 'm', provider: 'p', prompt: '{}', response: '{}',
        parsedOk: 1, sessionId: null, latencyMs: 1,
      });
    }
    db.recordProactiveDecision({ userId: 'u', at: now - 40 * day, stage: 'evaluate', outcome: 'skipped', reason: 'old' });
    db.recordProactiveDecision({ userId: 'u', at: now - day, stage: 'evaluate', outcome: 'skipped', reason: 'new' });
    process.env.LLM_TRACE_RETENTION_DAYS = '7';
    process.env.PROACTIVE_DECISION_RETENTION_DAYS = '30';

    expect(db.runRetentionMaintenance(now)).toEqual({
      tracesDeleted: 1,
      proactiveDecisionsDeleted: 1,
    });
    expect(db.raw<{ count: number }>('SELECT COUNT(*) AS count FROM llm_traces')[0].count).toBe(1);
    expect(db.getRecentProactiveDecisions(10).map(row => row.reason)).toEqual(['new']);
    db.close();
  });
});
