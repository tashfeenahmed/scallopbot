import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillStore } from '../evolution/skill-store.js';
import { composeSkillMarkdown } from './skill-author.js';
import { CURATOR_ARCHIVE_DAYS, SkillCurator } from './curator.js';
import { DEFAULT_EVOLUTION_CONFIG } from '../evolution/config.js';

const DAY = 24 * 60 * 60 * 1000;

describe('SkillCurator', () => {
  let dir: string;
  let store: SkillStore;
  let keys: Map<string, string>;
  const t0 = 1_700_000_000_000;

  async function agentSkill(name: string, at: number) {
    await store.stage(name, { 'SKILL.md': composeSkillMarkdown(name, `${name} procedure`, 'steps') });
    await store.promote(name);
    await store.markAgentCreated(name, 'create', at);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
    store = new SkillStore({ localDir: dir });
    keys = new Map();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function curator(reload = vi.fn(async () => undefined)) {
    return {
      reload,
      curator: new SkillCurator({
        store,
        reloadFromDisk: reload,
        runtimeKeys: { getRuntimeKey: key => keys.get(key) ?? null, setRuntimeKey: (key, value) => { keys.set(key, value); } },
      }),
    };
  }

  it('defaults to archiving after 30 idle days (evolution config agrees)', () => {
    expect(CURATOR_ARCHIVE_DAYS).toBe(30);
    expect(DEFAULT_EVOLUTION_CONFIG.curatorArchiveDays).toBe(30);
  });

  it('archives agent-created skills unused for 30 days; used, pinned and hand-written skills stay', async () => {
    await agentSkill('old_unused', t0);
    await agentSkill('old_but_used', t0);
    await agentSkill('pinned_one', t0);
    fs.mkdirSync(path.join(dir, 'hand_written'));
    fs.writeFileSync(path.join(dir, 'hand_written', 'SKILL.md'), composeSkillMarkdown('hand_written', 'mine', 'x'));
    await store.recordUse('hand_written', t0); // usage entry without createdBy: agent
    await store.pin('pinned_one');

    const { curator: c, reload } = curator();
    await c.recordSkillUse('old_but_used', t0 + 25 * DAY);
    const summary = await c.runNightly(t0 + 31 * DAY);

    expect(summary?.archived).toEqual(['old_unused']);
    expect(summary?.skippedPinned).toEqual(['pinned_one']);
    expect(fs.existsSync(path.join(dir, 'old_unused'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.archive', 'old_unused', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old_but_used'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'hand_written'))).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    // Recoverable.
    expect(await store.restoreArchived('old_unused', t0 + 32 * DAY)).toBe(true);
  });

  it('marks skills stale before archiving and runs at most once per night', async () => {
    await agentSkill('getting_old', t0);
    const { curator: c } = curator();
    const stale = await c.runNightly(t0 + 15 * DAY);
    expect(stale?.stale).toEqual(['getting_old']);
    expect(await c.runNightly(t0 + 15 * DAY + 60_000)).toBeNull();
    expect(await c.runNightly(t0 + 15 * DAY + 60_000, true)).not.toBeNull();
  });

  it('can be disabled', async () => {
    const c = new SkillCurator({ store, reloadFromDisk: async () => undefined, enabled: false });
    expect(await c.runNightly(t0)).toBeNull();
  });
});
