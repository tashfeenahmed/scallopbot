export type NotionAction = 'search' | 'schema' | 'query' | 'create' | 'update';

export interface NotionArgs {
  action: NotionAction;
  query?: string;
  object_type?: 'page' | 'data_source';
  database_id?: string;
  data_source_id?: string;
  page_id?: string;
  properties?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  page_size?: number;
  start_cursor?: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export interface NotionClientOptions {
  token: string;
  fetchImpl?: FetchLike;
}

function required(value: string | undefined, name: string): string {
  const clean = value?.trim();
  if (!clean) throw new Error(`Missing required parameter: ${name}`);
  return clean;
}

function cleanId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9-]/g, '');
}

export async function executeNotion(
  args: NotionArgs,
  options: NotionClientOptions,
): Promise<Record<string, unknown>> {
  const token = required(options.token, 'NOTION_TOKEN');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) throw new Error('This Node.js runtime does not provide fetch');

  const request = async (
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2025-09-03',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      throw new Error(`Notion HTTP ${response.status}: non-JSON response`);
    }
    if (!response.ok) {
      const code = typeof payload.code === 'string' ? payload.code : 'request_failed';
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown Notion error';
      throw new Error(`Notion HTTP ${response.status} ${code}: ${message}`);
    }
    return payload;
  };

  const resolveDataSourceId = async (): Promise<string> => {
    if (args.data_source_id) return cleanId(args.data_source_id);
    const databaseId = cleanId(required(args.database_id, 'database_id or data_source_id'));
    const database = await request(`/databases/${databaseId}`);
    const sources = Array.isArray(database.data_sources)
      ? database.data_sources as Array<Record<string, unknown>>
      : [];
    const id = typeof sources[0]?.id === 'string' ? sources[0].id : '';
    if (!id) throw new Error('The Notion database has no queryable data source');
    return cleanId(id);
  };

  switch (args.action) {
    case 'search': {
      const body: Record<string, unknown> = { page_size: Math.min(100, Math.max(1, args.page_size ?? 20)) };
      if (args.query?.trim()) body.query = args.query.trim();
      if (args.object_type) body.filter = { property: 'object', value: args.object_type };
      return { success: true, action: args.action, result: await request('/search', 'POST', body) };
    }
    case 'schema': {
      const dataSourceId = await resolveDataSourceId();
      return {
        success: true,
        action: args.action,
        data_source_id: dataSourceId,
        result: await request(`/data_sources/${dataSourceId}`),
      };
    }
    case 'query': {
      const dataSourceId = await resolveDataSourceId();
      const body: Record<string, unknown> = {
        page_size: Math.min(100, Math.max(1, args.page_size ?? 100)),
      };
      if (args.filter) body.filter = args.filter;
      if (args.sorts) body.sorts = args.sorts;
      if (args.start_cursor) body.start_cursor = args.start_cursor;
      return {
        success: true,
        action: args.action,
        data_source_id: dataSourceId,
        result: await request(`/data_sources/${dataSourceId}/query`, 'POST', body),
      };
    }
    case 'create': {
      if (!args.properties || Object.keys(args.properties).length === 0) {
        throw new Error('Missing required parameter: properties');
      }
      const parent = args.data_source_id
        ? { type: 'data_source_id', data_source_id: cleanId(args.data_source_id) }
        : { type: 'database_id', database_id: cleanId(required(args.database_id, 'database_id or data_source_id')) };
      const page = await request('/pages', 'POST', { parent, properties: args.properties });
      if (typeof page.id !== 'string' || !page.id) throw new Error('Notion create returned no page ID');
      return { success: true, action: args.action, page_id: page.id, result: page };
    }
    case 'update': {
      const pageId = cleanId(required(args.page_id, 'page_id'));
      if (!args.properties || Object.keys(args.properties).length === 0) {
        throw new Error('Missing required parameter: properties');
      }
      const page = await request(`/pages/${pageId}`, 'PATCH', { properties: args.properties });
      if (typeof page.id !== 'string' || !page.id) throw new Error('Notion update returned no page ID');
      return { success: true, action: args.action, page_id: page.id, result: page };
    }
    default:
      throw new Error(`Unsupported Notion action: ${String(args.action)}`);
  }
}
