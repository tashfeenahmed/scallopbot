import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import { SubAgentRegistry } from './registry.js';

describe('durable sub-agent delivery outbox', () => {
  let db: ScallopDatabase;
  beforeEach(() => { db = new ScallopDatabase(':memory:'); });
  afterEach(() => db.close());

  it('deduplicates by run and leases one worker at a time', () => {
    const registry = new SubAgentRegistry({ logger: pino({ level: 'silent' }), persistence: db });
    const run = registry.createRun('parent', { task: 'Produce a verified report' }, 'child');
    const delivery = { runId: run.id, parentSessionId: 'parent', userId: 'api:user', payloadJson: '{}' };
    expect(db.enqueueSubAgentDelivery(delivery)).toBe(true);
    expect(db.enqueueSubAgentDelivery(delivery)).toBe(false);
    const first = db.claimSubAgentDeliveries();
    expect(first).toHaveLength(1);
    expect(db.claimSubAgentDeliveries()).toHaveLength(0);
    expect(db.completeSubAgentDelivery(run.id, first[0].leaseToken!)).toBe(true);
    expect(db.claimSubAgentDeliveries()).toHaveLength(0);
  });
});
