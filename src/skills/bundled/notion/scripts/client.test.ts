import { describe, expect, it, vi } from 'vitest';
import { executeNotion, type FetchLike } from './client.js';

function response(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('typed Notion client', () => {
  it('resolves a database to its current data source before querying', async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(response(200, { data_sources: [{ id: 'source-1' }] }))
      .mockResolvedValueOnce(response(200, { results: [{ id: 'page-1' }] }));

    const result = await executeNotion(
      { action: 'query', database_id: 'database-1', page_size: 5 },
      { token: 'secret', fetchImpl },
    );

    expect(fetchImpl.mock.calls[0][0].endsWith('/databases/database-1')).toBe(true);
    expect(fetchImpl.mock.calls[1][0].endsWith('/data_sources/source-1/query')).toBe(true);
    expect(result).toMatchObject({ success: true, data_source_id: 'source-1' });
  });

  it('self-corrects when a search data-source ID is supplied as database_id', async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(response(404, {
        code: 'object_not_found', message: 'Could not find database',
      }))
      .mockResolvedValueOnce(response(200, { results: [], has_more: false }));

    const result = await executeNotion(
      { action: 'query', database_id: 'source-1' },
      { token: 'secret', fetchImpl },
    );

    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/databases\/source-1$/);
    expect(fetchImpl.mock.calls[1][0]).toMatch(/\/data_sources\/source-1\/query$/);
    expect(result).toMatchObject({ success: true, data_source_id: 'source-1' });
  });

  it('makes search identifier types explicit without returning a giant schema payload', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(200, {
      object: 'list',
      results: [{
        object: 'data_source', id: 'source-1',
        title: [{ plain_text: 'Gym Volume Tracker' }],
        parent: { type: 'database_id', database_id: 'database-1' },
        properties: { Weight: { type: 'number', number: {} } },
      }],
      has_more: false,
    }));

    const output = await executeNotion(
      { action: 'search', query: 'gym' },
      { token: 'secret', fetchImpl },
    );

    expect(output.result).toMatchObject({
      results: [{
        title: 'Gym Volume Tracker', database_id: 'database-1', data_source_id: 'source-1',
      }],
    });
    expect(JSON.stringify(output)).not.toContain('properties');
  });

  it('returns deterministic latest and maximum evidence for repeated tracker rows', async () => {
    const page = (id: string, name: string, date: string, weight: number) => ({
      id, created_time: `${date}T12:00:00.000Z`, properties: {
        Name: { type: 'title', title: [{ plain_text: name }] },
        Date: { type: 'date', date: { start: date } },
        Weight: { type: 'number', number: weight },
      },
    });
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(response(200, { data_sources: [{ id: 'source-1' }] }))
      .mockResolvedValueOnce(response(200, {
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
      }));

    const output = await executeNotion(
      { action: 'query', database_id: 'database-1' },
      { token: 'secret', fetchImpl },
    );
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

  it('requires an actual page ID before reporting create success', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(200, { object: 'page' }));
    await expect(executeNotion(
      { action: 'create', database_id: 'db', properties: { Name: { title: [] } } },
      { token: 'secret', fetchImpl },
    )).rejects.toThrow(/no page ID/i);
  });

  it('turns HTTP error payloads into failed tool executions', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(400, {
      code: 'validation_error', message: 'Name is not a property',
    }));
    await expect(executeNotion(
      { action: 'create', database_id: 'db', properties: { Name: { title: [] } } },
      { token: 'secret', fetchImpl },
    )).rejects.toThrow('Notion HTTP 400 validation_error');
  });
});
