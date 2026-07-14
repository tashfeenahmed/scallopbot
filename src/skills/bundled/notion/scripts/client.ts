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

function textFromNotion(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    if (typeof record.plain_text === 'string') return record.plain_text;
    const text = record.text as Record<string, unknown> | undefined;
    return typeof text?.content === 'string' ? text.content : '';
  }).join('');
}

function flattenProperty(property: unknown): unknown {
  if (!property || typeof property !== 'object') return null;
  const record = property as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'title' || type === 'rich_text') return textFromNotion(record[type]);
  if (type === 'number' || type === 'checkbox' || type === 'url'
    || type === 'email' || type === 'phone_number') return record[type] ?? null;
  if (type === 'date') {
    const date = record.date as Record<string, unknown> | null | undefined;
    if (!date || typeof date.start !== 'string') return null;
    return typeof date.end === 'string' ? { start: date.start, end: date.end } : date.start;
  }
  if (type === 'select' || type === 'status') {
    const selected = record[type] as Record<string, unknown> | null | undefined;
    return typeof selected?.name === 'string' ? selected.name : null;
  }
  if (type === 'multi_select') {
    return Array.isArray(record.multi_select)
      ? record.multi_select.flatMap(item => (
        item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
          ? [String((item as Record<string, unknown>).name)]
          : []
      ))
      : [];
  }
  if (type === 'formula') return flattenProperty(record.formula);
  return null;
}

interface CompactNotionRow {
  id: string;
  created_time: string | null;
  last_edited_time: string | null;
  url: string | null;
  properties: Record<string, unknown>;
  title: string;
  date: string | null;
}

function compactQueryResult(payload: Record<string, unknown>): Record<string, unknown> {
  const rawRows = Array.isArray(payload.results)
    ? payload.results.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
  const rows: CompactNotionRow[] = rawRows.map((row) => {
    const rawProperties = row.properties && typeof row.properties === 'object'
      ? row.properties as Record<string, unknown>
      : {};
    const properties = Object.fromEntries(
      Object.entries(rawProperties).map(([name, value]) => [name, flattenProperty(value)]),
    );
    const titleEntry = Object.entries(rawProperties).find(([, value]) => (
      !!value && typeof value === 'object' && (value as Record<string, unknown>).type === 'title'
    ));
    const dateEntry = Object.entries(rawProperties).find(([name, value]) => (
      name.toLocaleLowerCase('en-US') === 'date'
      || (!!value && typeof value === 'object' && (value as Record<string, unknown>).type === 'date')
    ));
    const flattenedDate = dateEntry ? flattenProperty(dateEntry[1]) : null;
    return {
      id: typeof row.id === 'string' ? row.id : '',
      created_time: typeof row.created_time === 'string' ? row.created_time : null,
      last_edited_time: typeof row.last_edited_time === 'string' ? row.last_edited_time : null,
      url: typeof row.url === 'string' ? row.url : null,
      properties,
      title: titleEntry ? String(properties[titleEntry[0]] ?? '') : '',
      date: typeof flattenedDate === 'string'
        ? flattenedDate
        : (flattenedDate && typeof flattenedDate === 'object'
          ? String((flattenedDate as Record<string, unknown>).start ?? '') || null
          : null),
    };
  }).sort((a, b) => (
    (b.date ?? '').localeCompare(a.date ?? '')
    || (b.created_time ?? '').localeCompare(a.created_time ?? '')
    || a.id.localeCompare(b.id)
  ));

  const grouped = new Map<string, CompactNotionRow[]>();
  for (const row of rows) {
    const key = row.title.trim().toLocaleLowerCase('en-US');
    if (!key) continue;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const statsByTitle = [...grouped.values()].map((group) => {
    const latest = group[0];
    const maxima: Record<string, { value: number; date: string | null; page_id: string }> = {};
    for (const row of group) {
      for (const [name, value] of Object.entries(row.properties)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (!maxima[name] || value > maxima[name].value) {
          maxima[name] = { value, date: row.date, page_id: row.id };
        }
      }
    }
    return {
      title: latest.title,
      latest: {
        page_id: latest.id,
        date: latest.date,
        properties: latest.properties,
      },
      maxima,
      recent: group.slice(0, 3).map(row => ({
        page_id: row.id, date: row.date, properties: row.properties,
      })),
    };
  });

  return {
    object: payload.object ?? 'list',
    rows: rows.map(({ title: _title, date: _date, ...row }) => row),
    stats_by_title: statsByTitle,
    next_cursor: payload.next_cursor ?? null,
    has_more: payload.has_more === true,
  };
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
      const result = await request(`/data_sources/${dataSourceId}/query`, 'POST', body);
      return {
        success: true,
        action: args.action,
        data_source_id: dataSourceId,
        result: compactQueryResult(result),
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
