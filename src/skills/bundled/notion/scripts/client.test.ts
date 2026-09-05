import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolOutputIndicatesFailure } from '../../../../agent/tool-safety.js';
import { executeNotion, type FetchLike, type NotionArgs } from './client.js';

const DB = '1801c5f6-386c-927e-228b-2a0b29321df0';
const DS = '7c048c39-72bd-9912-2f02-d0707ac427b1';
const UNDASHED_DB = DB.replace(/-/g, '');
const HALLUCINATED = '16302487c95e80b2a2fbd92d393164a3';

const gymDataSource = {
  object: 'data_source',
  id: DS,
  title: [{ plain_text: '🏋️ Gym Volume Tracker' }],
  parent: { type: 'database_id', database_id: DB },
  properties: {
    Name: { id: 'title', type: 'title', title: {} },
    Date: { type: 'date', date: {} },
    Type: { type: 'select', select: { options: [{ name: 'Cardio' }, { name: 'Strength' }, { name: 'Machine' }] } },
    Sets: { type: 'number', number: { format: 'number' } },
    Reps: { type: 'number', number: {} },
    'Weight (kg)': { type: 'number', number: {} },
    'Duration (min)': { type: 'number', number: {} },
    Notes: { type: 'rich_text', rich_text: {} },
  },
};

const gymDatabase = {
  object: 'database', id: DB, title: [{ plain_text: '🏋️ Gym Volume Tracker' }], data_sources: [{ id: DS, name: 'Gym' }],
};

const createdPage = {
  object: 'page', id: 'page-1', url: 'https://www.notion.so/page-1',
  created_time: '2026-08-21T10:00:00.000Z', last_edited_time: '2026-08-21T10:00:00.000Z',
  parent: { type: 'data_source_id', data_source_id: DS, database_id: DB },
  icon: null, cover: null, archived: false, in_trash: false,
  properties: {
    Name: { id: 'title', type: 'title', title: [{ type: 'text', text: { content: 'Pectoral machine' }, plain_text: 'Pectoral machine', annotations: {} }] },
    Date: { type: 'date', date: { start: '2026-08-21', end: null } },
    Type: { type: 'select', select: { id: 'x', name: 'Machine', color: 'blue' } },
    Sets: { type: 'number', number: 3 },
    Reps: { type: 'number', number: 6 },
    'Weight (kg)': { type: 'number', number: 45 },
    'Duration (min)': { type: 'number', number: null },
    Notes: { type: 'rich_text', rich_text: [] },
  },
};

const notFound = {
  code: 'object_not_found',
  message: 'Could not find database with ID: x. Make sure the relevant pages and databases are shared with your integration.',
};

function response(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** Route mocked fetch calls by method + path so call order does not matter. */
function router(routes: Record<string, Record<string, unknown> | ((body: Record<string, unknown>) => [number, Record<string, unknown>])>) {
  return vi.fn<FetchLike>(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.notion.com/v1', '')}`;
    const route = routes[key];
    if (!route) return response(404, { ...notFound, message: `unmocked ${key}` });
    if (typeof route === 'function') {
      const [status, body] = route(init?.body ? JSON.parse(init.body) as Record<string, unknown> : {});
      return response(status, body);
    }
    return response(200, route);
  });
}

const calls = (fetchImpl: ReturnType<typeof vi.fn<FetchLike>>) =>
  fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url.replace('https://api.notion.com/v1', '')}`);

const body = (fetchImpl: ReturnType<typeof vi.fn<FetchLike>>, index: number) =>
  JSON.parse(fetchImpl.mock.calls[index][1]?.body ?? '{}') as Record<string, unknown>;

describe('typed Notion client', () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notion-client-'));
    cachePath = join(dir, 'notion-cache.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: NotionArgs, fetchImpl: FetchLike, token = 'secret') =>
    executeNotion(args, { token, fetchImpl, cachePath });

  /** Seed the cache the way a real prior search would. */
  const prime = async () => {
    const fetchImpl = router({ 'POST /search': { object: 'list', results: [gymDataSource], has_more: false } });
    await run({ action: 'search', query: 'gym' }, fetchImpl);
  };

  // Updated: identifiers are now validated as UUIDs, so the fixtures use real-looking ones.
  it('resolves a database to its current data source before querying', async () => {
    const fetchImpl = router({
      [`GET /databases/${DB}`]: gymDatabase,
      [`POST /data_sources/${DS}/query`]: { results: [{ id: 'page-1' }] },
    });
    const result = await run({ action: 'query', database_id: DB, page_size: 5 }, fetchImpl);
    expect(calls(fetchImpl)).toEqual([`GET /databases/${DB}`, `POST /data_sources/${DS}/query`]);
    expect(result).toMatchObject({ success: true, data_source_id: DS, database_id: DB, title: '🏋️ Gym Volume Tracker' });
  });

  // Updated: the data-source endpoint is now fetched (and cached) rather than blindly retried.
  it('self-corrects when a search data-source ID is supplied as database_id', async () => {
    const fetchImpl = router({
      [`GET /data_sources/${DS}`]: gymDataSource,
      [`POST /data_sources/${DS}/query`]: { results: [], has_more: false },
    });
    const result = await run({ action: 'query', database_id: DS }, fetchImpl);
    expect(calls(fetchImpl)).toEqual([`GET /databases/${DS}`, `GET /data_sources/${DS}`, `POST /data_sources/${DS}/query`]);
    expect(result).toMatchObject({ success: true, data_source_id: DS });
  });

  it('accepts undashed ids, tries the data-source endpoint first for data_source_id, and caches the result', async () => {
    const fetchImpl = router({
      [`GET /data_sources/${DS}`]: gymDataSource,
      [`POST /data_sources/${DS}/query`]: { results: [], has_more: false },
    });
    await run({ action: 'query', data_source_id: DS.replace(/-/g, '') }, fetchImpl);
    expect(calls(fetchImpl)).toEqual([`GET /data_sources/${DS}`, `POST /data_sources/${DS}/query`]);

    const second = router({ [`POST /data_sources/${DS}/query`]: { results: [], has_more: false } });
    await run({ action: 'query', database_id: UNDASHED_DB }, second);
    expect(calls(second)).toEqual([`POST /data_sources/${DS}/query`]);
  });

  it('makes search identifier types explicit without returning a giant schema payload', async () => {
    const fetchImpl = router({
      'POST /search': {
        object: 'list',
        results: [{
          object: 'data_source', id: DS,
          title: [{ plain_text: 'Gym Volume Tracker' }],
          parent: { type: 'database_id', database_id: DB },
          properties: { Weight: { type: 'number', number: {} } },
        }],
        has_more: false,
      },
    });
    const output = await run({ action: 'search', query: 'gym' }, fetchImpl);
    expect(output.result).toMatchObject({
      results: [{ title: 'Gym Volume Tracker', database_id: DB, data_source_id: DS }],
    });
    expect(JSON.stringify(output)).not.toContain('properties');
    // ...but the schema seen in the search result is remembered for later writes.
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached.data_sources[0]).toMatchObject({ data_source_id: DS, schema: { Weight: { type: 'number' } } });
  });

  it('returns deterministic latest and maximum evidence for repeated tracker rows', async () => {
    const page = (id: string, name: string, date: string, weight: number) => ({
      id, created_time: `${date}T12:00:00.000Z`, properties: {
        Name: { type: 'title', title: [{ plain_text: name }] },
        Date: { type: 'date', date: { start: date } },
        Weight: { type: 'number', number: weight },
      },
    });
    const fetchImpl = router({
      [`GET /databases/${DB}`]: gymDatabase,
      [`POST /data_sources/${DS}/query`]: {
        object: 'list',
        // Deliberately stale-first: API order must not decide "latest".
        results: [
          page('april', 'Seated Cable Row', '2026-04-21', 40),
          page('june', 'Seated Cable Row', '2026-06-19', 65),
          page('july', 'Seated Cable Row', '2026-07-02', 70),
          page('chest-old', 'Chest Press', '2026-03-05', 40),
          page('chest-new', 'Chest Press', '2026-07-14', 40),
        ],
        has_more: false,
      },
    });
    const output = await run({ action: 'query', database_id: DB }, fetchImpl);
    const result = output.result as Record<string, unknown>;
    const stats = result.stats_by_title as Array<Record<string, unknown>>;
    const row = stats.find(item => item.title === 'Seated Cable Row')!;
    const chest = stats.find(item => item.title === 'Chest Press')!;
    expect(row.latest).toMatchObject({ date: '2026-07-02', properties: { Weight: 70 } });
    expect(row.maxima).toMatchObject({ Weight: { value: 70, date: '2026-07-02' } });
    expect(chest.latest).toMatchObject({ date: '2026-07-14', properties: { Weight: 40 } });
    expect(chest.maxima).toMatchObject({ Weight: { value: 40, date: '2026-07-14' } });
    expect(JSON.stringify(output)).not.toContain('plain_text');
  });

  it('coerces primitive property values using the fetched schema and returns a compact page', async () => {
    const fetchImpl = router({
      [`GET /data_sources/${DS}`]: gymDataSource,
      'POST /pages': createdPage,
    });
    const result = await run({
      action: 'create',
      data_source_id: DS,
      properties: {
        Name: 'Pectoral machine', Sets: 3, Reps: '6', 'weight (kg)': '45', Date: '2026-08-21', Type: 'machine', Notes: '',
      },
    }, fetchImpl);

    expect(calls(fetchImpl)).toEqual([`GET /data_sources/${DS}`, 'POST /pages']);
    expect(body(fetchImpl, 1)).toEqual({
      parent: { type: 'data_source_id', data_source_id: DS },
      properties: {
        Name: { title: [{ text: { content: 'Pectoral machine' } }] },
        Sets: { number: 3 },
        Reps: { number: 6 },
        'Weight (kg)': { number: 45 },
        Date: { date: { start: '2026-08-21' } },
        Type: { select: { name: 'Machine' } },
        Notes: { rich_text: [] },
      },
    });
    expect(result).toEqual({
      success: true,
      action: 'create',
      page_id: 'page-1',
      url: 'https://www.notion.so/page-1',
      title: 'Pectoral machine',
      properties: {
        Name: 'Pectoral machine', Date: '2026-08-21', Type: 'Machine', Sets: 3, Reps: 6,
        'Weight (kg)': 45, 'Duration (min)': null, Notes: '',
      },
      data_source_id: DS,
      database_id: DB,
      database: '🏋️ Gym Volume Tracker',
      renamed_properties: { 'weight (kg)': 'Weight (kg)' },
    });
    expect(Object.keys(result).sort()).toEqual([
      'action', 'data_source_id', 'database', 'database_id', 'page_id', 'properties', 'renamed_properties', 'success', 'title', 'url',
    ]);
    expect(JSON.stringify(result)).not.toContain('plain_text');
    expect(JSON.stringify(result).length).toBeLessThan(600);
  });

  it('creates by database title and reuses the cached schema with a single request', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    const result = await run({
      action: 'create', database: 'gym tracker', properties: { Name: 'Leg Press', Sets: 3, Date: '2026-08-21' },
    }, fetchImpl);
    expect(calls(fetchImpl)).toEqual(['POST /pages']);
    expect(body(fetchImpl, 0)).toMatchObject({ properties: { Sets: { number: 3 }, Date: { date: { start: '2026-08-21' } } } });
    expect(result).toMatchObject({ success: true, page_id: 'page-1', resolved_from: 'gym tracker', data_source_id: DS });
  });

  it('passes already-typed values through unchanged', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    const typed = {
      Name: { title: [{ text: { content: 'Row' } }] },
      Sets: { number: 2 },
      Type: { select: { name: 'Strength' } },
      Date: { date: { start: '2026-08-21' } },
    };
    await run({ action: 'create', database_id: DB, properties: typed }, fetchImpl);
    expect(body(fetchImpl, 0).properties).toEqual(typed);
  });

  it('rejects unknown property names before calling Notion, listing the valid ones', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    await expect(run({
      action: 'create', database_id: DB, properties: { Exercise: 'Row', Sets: 3 },
    }, fetchImpl)).rejects.toThrow(
      /Unknown property "Exercise" in "🏋️ Gym Volume Tracker"\. Valid properties: Name \(title\), Date \(date\), Type \(select: Cardio, Strength, Machine\), Sets \(number\), Reps \(number\), Weight \(kg\) \(number\), Duration \(min\) \(number\), Notes \(rich_text\)/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a title-like id such as "gym_tracker" by search and reports resolved_from', async () => {
    const fetchImpl = router({
      'POST /search': (request) => [200, {
        object: 'list',
        results: request.query === 'gym tracker' ? [gymDataSource] : [],
        has_more: false,
      }],
      'POST /pages': createdPage,
    });
    const result = await run({
      action: 'create', database_id: 'gym_tracker', properties: { Name: 'Leg Press', Sets: 3 },
    }, fetchImpl);
    expect(calls(fetchImpl)).toEqual(['POST /search', 'POST /pages']);
    expect(body(fetchImpl, 0)).toMatchObject({ query: 'gym tracker', filter: { property: 'object', value: 'data_source' } });
    expect(result).toMatchObject({ success: true, page_id: 'page-1', resolved_from: 'gym_tracker', database_id: DB });
  });

  it('recovers from a hallucinated UUID that 404s when a title hint matches a known database', async () => {
    await prime();
    const bad = '1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c';
    const fetchImpl = router({ 'POST /pages': createdPage });
    const result = await run({
      action: 'create', database_id: bad, database: 'Gym Volume Tracker', properties: { Name: 'Leg Press' },
    }, fetchImpl);
    expect(calls(fetchImpl)).toEqual([`GET /databases/${bad}`, `GET /data_sources/${bad}`, 'POST /pages']);
    expect(result).toMatchObject({ success: true, resolved_from: bad, data_source_id: DS });
  });

  it('explains an unresolvable id with the known databases and never blames integration sharing', async () => {
    await prime();
    const fetchImpl = router({});
    const promise = run({ action: 'query', database_id: HALLUCINATED }, fetchImpl);
    await expect(promise).rejects.toThrow(
      `Unknown database id "${HALLUCINATED}". Known databases: 🏋️ Gym Volume Tracker (database_id ${DB}, data_source_id ${DS}). Use action=search to find others.`,
    );
    await expect(promise).rejects.not.toThrow(/shar/i);
  });

  it('reports "none cached yet" when nothing is known and both searches come back empty', async () => {
    const fetchImpl = router({ 'POST /search': { object: 'list', results: [], has_more: false } });
    await expect(run({ action: 'query', database_id: 'workout log' }, fetchImpl)).rejects.toThrow(
      'Unknown database id "workout log". Known databases: none cached yet. Use action=search to find others.',
    );
    expect(calls(fetchImpl)).toEqual(['POST /search', 'POST /search']);
    expect(body(fetchImpl, 0)).toMatchObject({ query: 'workout log' });
    expect(body(fetchImpl, 1)).not.toHaveProperty('query');
  });

  it('refuses ambiguous title matches instead of guessing', async () => {
    const other = { ...gymDataSource, id: '1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c', title: [{ plain_text: 'Gym Plan' }] };
    const fetchImpl = router({ 'POST /search': { object: 'list', results: [gymDataSource, other], has_more: false } });
    await expect(run({ action: 'query', database: 'gym' }, fetchImpl)).rejects.toThrow(/Ambiguous database "gym"/);
  });

  it('passes a real 401/403 through with the Notion message', async () => {
    const fetchImpl = router({
      [`GET /databases/${DB}`]: () => [403, { code: 'restricted_resource', message: 'Share the database with your integration.' }],
    });
    await expect(run({ action: 'query', database_id: DB }, fetchImpl)).rejects.toThrow(
      'Notion HTTP 403 restricted_resource: Share the database with your integration.',
    );
  });

  it('returns a compact schema unless verbose is requested', async () => {
    const fetchImpl = router({ [`GET /databases/${DB}`]: gymDatabase, [`GET /data_sources/${DS}`]: gymDataSource });
    const result = await run({ action: 'schema', database_id: DB }, fetchImpl);
    expect(result).toEqual({
      success: true,
      action: 'schema',
      data_source_id: DS,
      database_id: DB,
      title: '🏋️ Gym Volume Tracker',
      properties: {
        Name: { type: 'title' },
        Date: { type: 'date' },
        Type: { type: 'select', options: ['Cardio', 'Strength', 'Machine'] },
        Sets: { type: 'number' },
        Reps: { type: 'number' },
        'Weight (kg)': { type: 'number' },
        'Duration (min)': { type: 'number' },
        Notes: { type: 'rich_text' },
      },
    });
    const verbose = await run({ action: 'schema', data_source_id: DS, verbose: true }, fetchImpl);
    expect(verbose.result).toMatchObject({ object: 'data_source', id: DS });
  });

  it('lists known databases from the cache without a token or network', async () => {
    const empty = await run({ action: 'known' }, router({}), '');
    expect(empty).toMatchObject({ success: true, action: 'known', databases: [], hint: expect.stringContaining('search') });

    await prime();
    const fetchImpl = router({});
    const result = await run({ action: 'known' }, fetchImpl, '');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.databases).toEqual([expect.objectContaining({
      title: '🏋️ Gym Volume Tracker',
      database_id: DB,
      data_source_id: DS,
      properties: expect.objectContaining({ Type: { type: 'select', options: ['Cardio', 'Strength', 'Machine'] } }),
    })]);
  });

  it('coerces update values by looking up the page parent when no database is given', async () => {
    await prime();
    const fetchImpl = router({
      'GET /pages/page-1': { object: 'page', id: 'page-1', parent: { type: 'data_source_id', data_source_id: DS } },
      'PATCH /pages/page-1': { ...createdPage, properties: { ...createdPage.properties, Sets: { type: 'number', number: 4 } } },
    });
    const result = await run({ action: 'update', page_id: 'page-1', properties: { sets: 4, Type: 'cardio' } }, fetchImpl);
    expect(calls(fetchImpl)).toEqual(['GET /pages/page-1', 'PATCH /pages/page-1']);
    expect(body(fetchImpl, 1)).toEqual({ properties: { Sets: { number: 4 }, Type: { select: { name: 'Cardio' } } } });
    expect(result).toMatchObject({ success: true, action: 'update', page_id: 'page-1', properties: { Sets: 4 } });
  });

  it('refreshes a schema older than 24 hours before coercing', async () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    let clock = start;
    const withClock = (args: NotionArgs, fetchImpl: FetchLike) =>
      executeNotion(args, { token: 'secret', fetchImpl, cachePath, now: () => new Date(clock) });
    await withClock({ action: 'search', query: 'gym' }, router({ 'POST /search': { results: [gymDataSource] } }));
    clock += 25 * 60 * 60 * 1000;
    const fetchImpl = router({ [`GET /data_sources/${DS}`]: gymDataSource, 'POST /pages': createdPage });
    await withClock({ action: 'create', database_id: DB, properties: { Name: 'Row' } }, fetchImpl);
    expect(calls(fetchImpl)).toEqual([`GET /data_sources/${DS}`, 'POST /pages']);
  });

  it('survives a corrupt cache file and rewrites it with owner-only permissions', async () => {
    writeFileSync(cachePath, '{"version":1,"data_sources":[{"bogus":true', { mode: 0o644 });
    const fetchImpl = router({ 'POST /search': { object: 'list', results: [gymDataSource], has_more: false } });
    await expect(run({ action: 'search', query: 'gym' }, fetchImpl)).resolves.toMatchObject({ success: true });
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).data_sources).toHaveLength(1);
  });

  it('requires an actual page ID before reporting create success', async () => {
    const fetchImpl = router({ [`GET /data_sources/${DS}`]: gymDataSource, 'POST /pages': { object: 'page' } });
    await expect(run(
      { action: 'create', data_source_id: DS, properties: { Name: 'Row' } },
      fetchImpl,
    )).rejects.toThrow(/no page ID/i);
  });

  it('turns HTTP error payloads into failed tool executions with a schema hint', async () => {
    const fetchImpl = router({
      [`GET /data_sources/${DS}`]: gymDataSource,
      'POST /pages': () => [400, { code: 'validation_error', message: 'Name is not a property' }],
    });
    await expect(run(
      { action: 'create', data_source_id: DS, properties: { Name: { title: [] } } },
      fetchImpl,
    )).rejects.toThrow(/Notion HTTP 400 validation_error: Name is not a property\. Valid properties: Name \(title\)/);
  });

  it('produces outputs the executor failure heuristics accept, and errors they reject', async () => {
    await prime();
    const created = await run({ action: 'create', database: 'gym', properties: { Name: 'Row' } }, router({ 'POST /pages': createdPage }));
    const schema = await run({ action: 'schema', database_id: DB }, router({ [`GET /data_sources/${DS}`]: gymDataSource }));
    const known = await run({ action: 'known' }, router({}));
    const queried = await run({ action: 'query', database_id: DB }, router({ [`POST /data_sources/${DS}/query`]: { results: [] } }));
    for (const output of [created, schema, known, queried]) {
      expect(output).not.toHaveProperty('error');
      // run.ts wraps the result as {success, output, exitCode}; agent.ts unwraps `output` and re-checks it.
      expect(toolOutputIndicatesFailure(JSON.stringify(output))).toBe(false);
      expect(toolOutputIndicatesFailure(JSON.stringify({ success: true, output, exitCode: 0 }))).toBe(false);
    }
    const failure = JSON.stringify({ success: false, error: 'Unknown database id "x". Known databases: none cached yet.', exitCode: 1 });
    expect(toolOutputIndicatesFailure(failure)).toBe(true);
  });
});
