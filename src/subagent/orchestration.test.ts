import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { SubAgentRegistry } from './registry.js';

const logger = pino({ level: 'silent' });

describe('sub-agent orchestration policy', () => {
  it('preflights a whole batch instead of partially starting it', () => {
    const registry = new SubAgentRegistry({
      logger,
      config: { maxConcurrentPerSession: 3, maxConcurrentGlobal: 3 },
    });
    registry.createRun('parent', { task: 'existing work' }, 'child-1');
    expect(registry.canSpawn('parent', {}, 2).allowed).toBe(true);
    expect(registry.canSpawn('parent', {}, 3)).toMatchObject({ allowed: false });
    expect(registry.getRunsForParent('parent')).toHaveLength(1);
  });

  it('allows only bounded orchestrators to create nested children', () => {
    const registry = new SubAgentRegistry({ logger, config: { maxSpawnDepth: 1 } });
    expect(registry.canSpawn('leaf', { isSubAgent: true, subAgentRole: 'leaf', subAgentSpawnDepth: 0 }).allowed).toBe(false);
    expect(registry.canSpawn('orchestrator', { isSubAgent: true, subAgentRole: 'orchestrator', subAgentSpawnDepth: 0 }).allowed).toBe(true);
    expect(registry.canSpawn('deep', { isSubAgent: true, subAgentRole: 'orchestrator', subAgentSpawnDepth: 1 }).allowed).toBe(false);
  });

  it('reserves fan-out capacity across concurrent async preparation', () => {
    const registry = new SubAgentRegistry({ logger, config: { maxConcurrentPerSession: 3, maxConcurrentGlobal: 3 } });
    const reservation = registry.reserveSpawn('parent', {}, 2);
    expect(reservation.token).toBeTruthy();
    expect(registry.canSpawn('other-parent', {}, 2).allowed).toBe(false);
    registry.releaseSpawnReservation(reservation.token!);
    expect(registry.canSpawn('other-parent', {}, 2).allowed).toBe(true);
  });

  it('does not leave a phantom run when durable creation fails', () => {
    const registry = new SubAgentRegistry({
      logger,
      persistence: {
        insertSubAgentRun: () => { throw new Error('disk unavailable'); },
        updateSubAgentRun: () => undefined,
      },
    });
    expect(() => registry.createRun('parent', { task: 'durable task' }, 'child')).toThrow('disk unavailable');
    expect(registry.getAllRuns()).toEqual([]);
    expect(registry.getRunsForParent('parent')).toEqual([]);
  });
});
