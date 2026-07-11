import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ScallopDatabase } from '../memory/db.js';
import { SubAgentRegistry } from './registry.js';

const logger = pino({ level: 'silent' });

describe('SubAgentRegistry persistence', () => {
  let db: ScallopDatabase;
  let registry: SubAgentRegistry;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
    registry = new SubAgentRegistry({ logger, persistence: db });
  });

  afterEach(() => db.close());

  it('persists creation, lifecycle, result, and token usage', () => {
    const run = registry.createRun('parent-1', {
      task: 'Research the release',
      label: 'research',
      skills: ['web_search'],
    }, 'child-1');

    expect(db.getSubAgentRunsByParent('parent-1')).toHaveLength(1);
    registry.updateStatus(run.id, 'running');
    registry.updateTokenUsage(run.id, { inputTokens: 120, outputTokens: 30 });
    registry.updateStatus(run.id, 'completed', {
      response: 'Release verified',
      iterationsUsed: 2,
      taskComplete: true,
    });

    const stored = db.getSubAgentRunsByParent('parent-1')[0];
    expect(stored).toMatchObject({
      status: 'completed',
      resultResponse: 'Release verified',
      resultIterations: 2,
      resultTaskComplete: true,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(stored.startedAt).not.toBeNull();
    expect(stored.completedAt).not.toBeNull();
  });

  it('durably marks interrupted work lost without inferring failure or success', () => {
    const run = registry.createRun('parent-2', { task: 'Long task' }, 'child-2');
    registry.updateStatus(run.id, 'running');

    const freshRegistry = new SubAgentRegistry({ logger, persistence: db });
    const row = db.getActiveSubAgentRuns()[0];
    const orphaned = freshRegistry.loadFromPersistence([{
      id: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      task: row.task,
      label: row.label,
      status: 'running',
      allowedSkills: [],
      modelTier: 'fast',
      timeoutMs: row.timeoutMs,
      idleTimeoutMs: row.idleTimeoutMs ?? 300_000,
      hardTimeoutMs: row.hardTimeoutMs ?? row.timeoutMs,
      contextMode: 'brief',
      role: 'leaf',
      workspaceMode: 'shared',
      spawnDepth: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      createdAt: row.createdAt,
    }]);

    expect(orphaned).toBe(1);
    expect(db.getActiveSubAgentRuns()).toHaveLength(0);
    expect(db.getSubAgentRunsByParent('parent-2')[0]).toMatchObject({
      status: 'lost',
      error: 'Process restarted while this sub-agent was active; no success was inferred',
    });
  });
});
