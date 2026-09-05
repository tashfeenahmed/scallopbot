import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotionCache, bestTitleMatch, resolveCachePath, scoreTitleMatch } from './cache.js';
import { normalizeNotionId, sameNotionId } from './ids.js';

const DB = '1801c5f6-386c-927e-228b-2a0b29321df0';
const DS = '7c048c39-72bd-9912-2f02-d0707ac427b1';

describe('normalizeNotionId', () => {
  it('accepts dashed, undashed, and URL forms and rejects titles', () => {
    expect(normalizeNotionId(DB)).toBe(DB);
    expect(normalizeNotionId(DB.replace(/-/g, ''))).toBe(DB);
    expect(normalizeNotionId(DB.toUpperCase())).toBe(DB);
    expect(normalizeNotionId(`https://www.notion.so/tash/Gym-Tracker-${DB.replace(/-/g, '')}?v=abc`)).toBe(DB);
    expect(normalizeNotionId('gym_tracker')).toBeNull();
    expect(normalizeNotionId('1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c')).toBe('1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c');
    expect(normalizeNotionId('')).toBeNull();
    expect(normalizeNotionId(undefined)).toBeNull();
    expect(sameNotionId(DB, DB.replace(/-/g, ''))).toBe(true);
  });
});

describe('title matching', () => {
  const gym = { title: '🏋️ Gym Volume Tracker' };
  const recipes = { title: 'Recipes' };
  const gymPlan = { title: 'Gym Plan' };

  it('scores fuzzy titles the way a model would type them', () => {
    expect(scoreTitleMatch('gym_tracker', gym.title)).toBeGreaterThan(0.8);
    expect(scoreTitleMatch('notion gym tracker', gym.title)).toBeGreaterThan(0.8);
    expect(scoreTitleMatch('Gym Volume Tracker', gym.title)).toBe(1);
    expect(scoreTitleMatch('recipes', gym.title)).toBe(0);
  });

  it('picks a unique best match and reports ties as ambiguous', () => {
    expect(bestTitleMatch('gym tracker', [gym, recipes, gymPlan]).match).toBe(gym);
    expect(bestTitleMatch('gym', [gym, gymPlan]).ambiguous).toEqual([gym, gymPlan]);
    expect(bestTitleMatch('taxes', [gym, recipes])).toEqual({});
  });
});

describe('NotionCache', () => {
  const dirs: string[] = [];
  const tempPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'notion-cache-'));
    dirs.push(dir);
    return join(dir, 'nested', 'notion-cache.json');
  };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('resolves the path from SCALLOPBOT_HOME, then SCALLOPBOT_DATA_DIR, then ~/.scallopbot', () => {
    expect(resolveCachePath({ SCALLOPBOT_HOME: '/x' })).toBe('/x/notion-cache.json');
    expect(resolveCachePath({ SCALLOPBOT_DATA_DIR: '/y' })).toBe('/y/notion-cache.json');
    expect(resolveCachePath({})).toMatch(/\.scallopbot\/notion-cache\.json$/);
  });

  it('persists atomically with owner-only permissions and reloads', () => {
    const path = tempPath();
    let clock = Date.parse('2026-09-05T10:00:00Z');
    const now = () => new Date(clock);
    const cache = new NotionCache(path, now);
    cache.remember({ title: 'Gym', database_id: DB.replace(/-/g, ''), data_source_id: DS, schema: { Name: { type: 'title' } } });
    cache.save();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, '..')).filter(name => name.endsWith('.tmp'))).toEqual([]);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.data_sources[0]).toMatchObject({ title: 'Gym', database_id: DB, data_source_id: DS });

    const reloaded = new NotionCache(path, now);
    expect(reloaded.findById(DB.replace(/-/g, ''))?.data_source_id).toBe(DS);
    expect(reloaded.freshSchema(DS)).toEqual({ Name: { type: 'title' } });
    clock += 25 * 60 * 60 * 1000;
    expect(reloaded.freshSchema(DS)).toBeUndefined();
  });

  it('starts empty on a corrupt or missing file and overwrites it on save', () => {
    const path = tempPath();
    expect(new NotionCache(path).list()).toEqual([]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json', { mode: 0o600 });
    const cache = new NotionCache(path);
    expect(cache.list()).toEqual([]);
    cache.remember({ title: 'Gym', data_source_id: DS });
    cache.save();
    expect(JSON.parse(readFileSync(path, 'utf8')).data_sources).toHaveLength(1);
  });

  it('merges repeated sightings and orders by last use', () => {
    const path = tempPath();
    let clock = 1_000_000;
    const cache = new NotionCache(path, () => new Date(clock));
    cache.remember({ title: 'Gym', data_source_id: DS });
    clock += 1000;
    cache.remember({ title: 'Recipes', data_source_id: '1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c' });
    clock += 1000;
    cache.remember({ database_id: DB, data_source_id: DS });
    expect(cache.list().map(entry => entry.title)).toEqual(['Gym', 'Recipes']);
    expect(cache.findById(DS)).toMatchObject({ title: 'Gym', database_id: DB });
    cache.forget(DB);
    expect(cache.list().map(entry => entry.title)).toEqual(['Recipes']);
  });
});
