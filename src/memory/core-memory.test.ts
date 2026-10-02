import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScallopDatabase, type ScallopMemoryEntry } from './db.js';
import {
  CONSOLIDATE_MESSAGE,
  CORE_MEMORY_TOOL_DESCRIPTION,
  CoreMemoryStore,
  createCoreMemorySkill,
  registerCoreMemoryTool,
  renderCoreMemory,
  seedCoreMemory,
  type CoreMemorySeedSource,
} from './core-memory.js';
import type { Skill } from '../skills/types.js';

describe('core memory', () => {
  let dir: string;
  let db: ScallopDatabase;
  let core: CoreMemoryStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-'));
    db = new ScallopDatabase(path.join(dir, 'm.db'));
    core = new CoreMemoryStore(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migration is additive and idempotent (reopen keeps entries)', () => {
    core.apply('u1', { action: 'add', block: 'user', content: 'Lives in Dublin' });
    db.close();
    db = new ScallopDatabase(path.join(dir, 'm.db'));
    expect(new CoreMemoryStore(db).get('u1', 'user')).toEqual(['Lives in Dublin']);
  });

  it('adds, replaces and removes atomically, per user and block', () => {
    expect(core.apply('u1', { action: 'add', block: 'user', content: '- Lives in Dublin' }).success).toBe(true);
    core.apply('u1', { action: 'add', block: 'environment', content: 'Prefers metric units' });
    core.apply('u2', { action: 'add', block: 'user', content: 'Lives in Paris' });

    const replaced = core.apply('u1', { action: 'replace', block: 'user', oldText: 'dublin', content: 'Lives in Cork' });
    expect(replaced.success).toBe(true);
    expect(core.get('u1', 'user')).toEqual(['Lives in Cork']);
    expect(core.get('u2', 'user')).toEqual(['Lives in Paris']);

    expect(core.apply('u1', { action: 'remove', block: 'environment', oldText: 'metric' }).success).toBe(true);
    expect(core.get('u1', 'environment')).toEqual([]);
  });

  it('treats a duplicate add as a no-op', () => {
    core.apply('u1', { action: 'add', block: 'user', content: 'Has two cats' });
    const again = core.apply('u1', { action: 'add', block: 'user', content: 'has two cats.' });
    expect(again).toMatchObject({ success: true, unchanged: true });
    expect(core.get('u1', 'user')).toHaveLength(1);
    expect(core.history('u1')).toHaveLength(1);
  });

  it('rejects ambiguous or missing old_text and lists entries', () => {
    core.apply('u1', { action: 'add', block: 'user', content: 'Sister lives in Dublin' });
    core.apply('u1', { action: 'add', block: 'user', content: 'Brother lives in Dublin' });
    const ambiguous = core.apply('u1', { action: 'remove', block: 'user', oldText: 'lives in Dublin' });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.message).toContain('matches 2');
    const missing = core.apply('u1', { action: 'replace', block: 'user', oldText: 'Berlin', content: 'x' });
    expect(missing.success).toBe(false);
    expect(missing.message).toContain('Sister lives in Dublin');
    expect(core.get('u1', 'user')).toHaveLength(2);
  });

  it('fails an overflowing write and returns ALL entries with the consolidate instruction', () => {
    const small = new CoreMemoryStore(db, { limits: { user: 60 } });
    small.apply('u1', { action: 'add', block: 'user', content: 'Lives in Dublin with partner Sam' });
    const overflow = small.apply('u1', { action: 'add', block: 'user', content: 'Works as a nurse at the Mater hospital' });
    expect(overflow.success).toBe(false);
    expect(overflow.message).toContain(CONSOLIDATE_MESSAGE);
    expect(overflow.message).toContain('Lives in Dublin with partner Sam');
    expect(overflow.entries).toEqual(['Lives in Dublin with partner Sam']);
    expect(small.get('u1', 'user')).toEqual(['Lives in Dublin with partner Sam']);
    // Consolidating via replace succeeds.
    expect(small.apply('u1', { action: 'replace', block: 'user', oldText: 'Dublin', content: 'Dublin; nurse at Mater' }).success).toBe(true);
  });

  it('renders usage headers for the frozen session prompt', () => {
    core.apply('u1', { action: 'add', block: 'user', content: 'x'.repeat(1550) });
    const text = renderCoreMemory(core, 'u1');
    expect(text).toContain('## CORE MEMORY — user (62% of 2500 chars)');
    expect(text).toContain('## CORE MEMORY — environment (0% of 1500 chars)\n(empty)');
    expect(renderCoreMemory(db, 'u1')).toBe(text);
  });

  it('versions every write and rolls back by id', () => {
    const first = core.apply('u1', { action: 'add', block: 'user', content: 'Lives in Dublin' });
    const second = core.apply('u1', { action: 'replace', block: 'user', oldText: 'Dublin', content: 'Lives in Cork' });
    expect(core.rollback(second.historyId!).success).toBe(true);
    expect(core.get('u1', 'user')).toEqual(['Lives in Dublin']);
    expect(core.rollback(second.historyId!).success).toBe(false);
    expect(core.rollback(first.historyId!).success).toBe(true);
    expect(core.get('u1', 'user')).toEqual([]);
    expect(core.history('u1').map(row => row.action)).toEqual(['rollback', 'rollback', 'replace', 'add']);
    expect(core.rollback(99999).success).toBe(false);
  });

  it('seeds once from the static profile and prominent durable facts', () => {
    const memory = (content: string, extra: Partial<ScallopMemoryEntry> = {}): ScallopMemoryEntry => ({
      id: content, userId: 'u1', content, category: 'fact', memoryType: 'regular', importance: 5, confidence: 0.9,
      isLatest: true, source: 'user', documentDate: Date.now(), eventDate: null, prominence: 0.9, lastAccessed: null,
      accessCount: 0, sourceChunk: null, embedding: null, metadata: null, createdAt: 0, updatedAt: 0, ...extra,
    });
    const source: CoreMemorySeedSource = {
      getStaticProfile: () => ({ name: 'Tash', timezone: 'Europe/Dublin' }),
      getTopMemories: () => [
        memory('Prefers short answers', { category: 'preference' }),
        memory('Has a dog called Biscuit'),
        memory('Assistant reflection', { source: 'assistant' }),
        memory('Went to the dentist', { category: 'event', eventDate: Date.now() }),
        memory('Goal: run a marathon', { metadata: { goalType: 'goal' } }),
        memory('Has a dog called Biscuit'),
      ],
    };
    const result = seedCoreMemory(core, source, 'u1');
    expect(result).toEqual({ seeded: true, added: { user: 3, environment: 1 } });
    expect(core.get('u1', 'user')).toEqual(['Name: Tash', 'Timezone: Europe/Dublin', 'Has a dog called Biscuit']);
    expect(core.get('u1', 'environment')).toEqual(['Prefers short answers']);
    // Never re-seeds, even after the user empties it.
    for (const entry of core.get('u1', 'user')) core.apply('u1', { action: 'remove', block: 'user', oldText: entry });
    expect(seedCoreMemory(core, source, 'u1').seeded).toBe(false);
    expect(core.get('u1', 'user')).toEqual([]);
  });

  it('native tool applies ops for the resolved state user and reports failures', async () => {
    const skill = createCoreMemorySkill({ core, resolveUserId: () => 'owner' });
    const run = (args: Record<string, unknown>) => skill.handler!({ args, workspace: dir, sessionId: 's1', userId: 'telegram:1' });
    await expect(run({ action: 'add', block: 'user', content: 'Lives in Dublin' })).resolves.toMatchObject({ success: true });
    expect(core.get('owner', 'user')).toEqual(['Lives in Dublin']);
    await expect(run({ action: 'add', block: 'nope', content: 'x' })).resolves.toMatchObject({ success: false });
    await expect(run({ action: 'explode', block: 'user' })).resolves.toMatchObject({ success: false });
    const removed = await run({ action: 'remove', block: 'user', old_text: 'Dublin' });
    expect(removed.success).toBe(true);
    expect(skill.description).toContain('declarative fact');
    expect(skill.hasScripts).toBe(true);
  });

  it('registers as `memory`, or `core_memory` when `memory` is taken', () => {
    const skills = new Map<string, Skill>();
    const registry = {
      hasSkill: (name: string) => skills.has(name),
      getSkill: (name: string) => skills.get(name),
      registerSkill: (skill: Skill) => { skills.set(skill.name, skill); },
    };
    expect(registerCoreMemoryTool(registry, { core }).name).toBe('memory');
    // Re-registering our own tool keeps the name.
    expect(registerCoreMemoryTool(registry, { core }).name).toBe('memory');
    skills.set('memory', { ...skills.get('memory')!, description: 'someone else' });
    expect(registerCoreMemoryTool(registry, { core }).name).toBe('core_memory');
    expect(skills.get('core_memory')?.description).toBe(CORE_MEMORY_TOOL_DESCRIPTION);
  });
});
