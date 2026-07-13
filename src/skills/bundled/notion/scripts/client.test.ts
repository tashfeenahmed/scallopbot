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
