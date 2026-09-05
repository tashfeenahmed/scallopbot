import {
  NotionCache, bestTitleMatch, resolveCachePath, titleTokens,
  type CachedSchema, type KnownDataSource,
} from './cache.js';
import { NotionInputError, coerceProperties, describeSchema, schemaFromProperties } from './coerce.js';
import { normalizeNotionId } from './ids.js';

export type NotionAction = 'search' | 'schema' | 'query' | 'create' | 'update' | 'known';

export interface NotionArgs {
  action: NotionAction;
  query?: string;
  object_type?: 'page' | 'data_source';
  database_id?: string;
  data_source_id?: string;
  /** Database title (or any fragment of it); resolved via the cache or search. */
  database?: string;
  page_id?: string;
  properties?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  page_size?: number;
  start_cursor?: string;
  verbose?: boolean;
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
  /** Override the persistent cache location (tests). */
  cachePath?: string;
  now?: () => Date;
}

export class NotionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
type Request = (path: string, method?: 'GET' | 'POST' | 'PATCH', body?: Json) => Promise<Json>;

interface Context {
  request: Request;
  cache: NotionCache;
}

function required(value: string | undefined, name: string): string {
  const clean = value?.trim();
  if (!clean) throw new Error(`Missing required parameter: ${name}`);
  return clean;
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof NotionRequestError && error.status === 404;
}

function textFromNotion(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!isObject(part)) return '';
    if (typeof part.plain_text === 'string') return part.plain_text;
    const text = part.text as Json | undefined;
    return typeof text?.content === 'string' ? text.content : '';
  }).join('');
}

function flattenProperty(property: unknown): unknown {
  if (!isObject(property)) return null;
  const type = typeof property.type === 'string' ? property.type : '';
  if (type === 'title' || type === 'rich_text') return textFromNotion(property[type]);
  if (type === 'number' || type === 'checkbox' || type === 'url'
    || type === 'email' || type === 'phone_number') return property[type] ?? null;
  if (type === 'date') {
    const date = property.date as Json | null | undefined;
    if (!date || typeof date.start !== 'string') return null;
    return typeof date.end === 'string' ? { start: date.start, end: date.end } : date.start;
  }
  if (type === 'select' || type === 'status') {
    const selected = property[type] as Json | null | undefined;
    return typeof selected?.name === 'string' ? selected.name : null;
  }
  if (type === 'multi_select') {
    return Array.isArray(property.multi_select)
      ? property.multi_select.flatMap(item => (
        isObject(item) && typeof item.name === 'string' ? [String(item.name)] : []
      ))
      : [];
  }
  if (type === 'formula') return flattenProperty(property.formula);
  return null;
}

function flattenProperties(raw: unknown): { properties: Json; title: string; date: string | null } {
  const rawProperties = isObject(raw) ? raw : {};
  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([name, value]) => [name, flattenProperty(value)]),
  );
  const titleEntry = Object.entries(rawProperties).find(([, value]) => isObject(value) && value.type === 'title');
  const dateEntry = Object.entries(rawProperties).find(([name, value]) => (
    name.toLocaleLowerCase('en-US') === 'date' || (isObject(value) && value.type === 'date')
  ));
  const flattenedDate = dateEntry ? flattenProperty(dateEntry[1]) : null;
  return {
    properties,
    title: titleEntry ? String(properties[titleEntry[0]] ?? '') : '',
    date: typeof flattenedDate === 'string'
      ? flattenedDate
      : (isObject(flattenedDate) ? String(flattenedDate.start ?? '') || null : null),
  };
}

interface CompactNotionRow {
  id: string;
  created_time: string | null;
  last_edited_time: string | null;
  url: string | null;
  properties: Json;
  title: string;
  date: string | null;
}

function compactQueryResult(payload: Json): Json {
  const rawRows = Array.isArray(payload.results) ? payload.results.filter(isObject) : [];
  const rows: CompactNotionRow[] = rawRows.map((row) => {
    const flat = flattenProperties(row.properties);
    return {
      id: typeof row.id === 'string' ? row.id : '',
      created_time: typeof row.created_time === 'string' ? row.created_time : null,
      last_edited_time: typeof row.last_edited_time === 'string' ? row.last_edited_time : null,
      url: typeof row.url === 'string' ? row.url : null,
      properties: flat.properties,
      title: flat.title,
      date: flat.date,
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
      latest: { page_id: latest.id, date: latest.date, properties: latest.properties },
      maxima,
      recent: group.slice(0, 3).map(row => ({ page_id: row.id, date: row.date, properties: row.properties })),
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

function compactPage(page: Json): { page_id: string; url: string | null; title: string; properties: Json } {
  const flat = flattenProperties(page.properties);
  return {
    page_id: typeof page.id === 'string' ? page.id : '',
    url: typeof page.url === 'string' ? page.url : null,
    title: flat.title,
    properties: flat.properties,
  };
}

/** Record a `data_source` object (search hit or GET /data_sources/{id}) in the cache. */
function rememberDataSource(cache: NotionCache, row: Json): KnownDataSource | undefined {
  if (typeof row.id !== 'string') return undefined;
  const parent = isObject(row.parent) ? row.parent : {};
  const title = textFromNotion(row.title) || flattenProperties(row.properties).title;
  return cache.remember({
    title,
    database_id: typeof parent.database_id === 'string' ? parent.database_id : null,
    data_source_id: row.id,
    schema: isObject(row.properties) ? schemaFromProperties(row.properties) : undefined,
  });
}

/** Record a `database` object (GET /databases/{id} or search hit) in the cache. */
function rememberDatabase(cache: NotionCache, row: Json): KnownDataSource | undefined {
  if (typeof row.id !== 'string') return undefined;
  const sources = Array.isArray(row.data_sources) ? row.data_sources.filter(isObject) : [];
  const dataSourceId = typeof sources[0]?.id === 'string' ? sources[0].id : '';
  if (!dataSourceId) return undefined;
  return cache.remember({ title: textFromNotion(row.title), database_id: row.id, data_source_id: dataSourceId });
}

function compactSearchResult(cache: NotionCache, payload: Json): Json {
  const results = Array.isArray(payload.results)
    ? payload.results.flatMap((entry) => {
      if (!isObject(entry)) return [];
      const parent = isObject(entry.parent) ? entry.parent : {};
      const object = typeof entry.object === 'string' ? entry.object : 'unknown';
      const id = typeof entry.id === 'string' ? entry.id : '';
      const title = textFromNotion(entry.title) || flattenProperties(entry.properties).title;
      if (object === 'data_source') rememberDataSource(cache, entry);
      if (object === 'database') rememberDatabase(cache, entry);
      return [{
        object,
        id,
        title,
        url: typeof entry.url === 'string' ? entry.url : null,
        database_id: object === 'database'
          ? id
          : (typeof parent.database_id === 'string' ? parent.database_id : null),
        data_source_id: object === 'data_source'
          ? id
          : (typeof parent.data_source_id === 'string' ? parent.data_source_id : null),
      }];
    })
    : [];
  return {
    object: payload.object ?? 'list',
    results,
    next_cursor: payload.next_cursor ?? null,
    has_more: payload.has_more === true,
  };
}

function describeKnown(entries: KnownDataSource[]): string {
  if (entries.length === 0) return 'none cached yet';
  return entries
    .map(entry => `${entry.title || '(untitled)'} (database_id ${entry.database_id ?? 'unknown'}, data_source_id ${entry.data_source_id})`)
    .join('; ');
}

function unknownDatabaseError(original: string, cache: NotionCache): Error {
  return new Error(
    `Unknown database id "${original}". Known databases: ${describeKnown(cache.list())}. `
    + 'Use action=search to find others.',
  );
}

function ambiguousDatabaseError(hint: string, candidates: KnownDataSource[]): Error {
  return new Error(
    `Ambiguous database "${hint}": matches ${describeKnown(candidates)}. Pass data_source_id explicitly.`,
  );
}

function compactKnown(entry: KnownDataSource): Json {
  return {
    title: entry.title,
    database_id: entry.database_id,
    data_source_id: entry.data_source_id,
    last_used: entry.last_used,
    ...(entry.schema ? { properties: entry.schema } : {}),
  };
}

interface ResolvedTarget {
  data_source_id: string;
  database_id: string | null;
  title: string;
  schema?: CachedSchema;
  resolved_from?: string;
}

/** Fetch a data source from Notion and cache it (with schema). */
async function fetchDataSource(ctx: Context, dataSourceId: string): Promise<KnownDataSource> {
  const raw = await ctx.request(`/data_sources/${dataSourceId}`);
  const entry = rememberDataSource(ctx.cache, raw);
  if (!entry) throw new Error('Notion returned a data source without an ID');
  return entry;
}

/** Try a UUID at both typed endpoints. Null means Notion returned 404 for both. */
async function lookupById(ctx: Context, id: string, preferDataSource: boolean): Promise<KnownDataSource | null> {
  const asDatabase = async (): Promise<KnownDataSource | null> => {
    try {
      const database = await ctx.request(`/databases/${id}`);
      const entry = rememberDatabase(ctx.cache, database);
      if (entry) return entry;
      throw new Error('The Notion database has no queryable data source');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const asDataSource = async (): Promise<KnownDataSource | null> => {
    try {
      return await fetchDataSource(ctx, id);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  // Search results expose data-source IDs and callers naturally paste one into
  // database_id (and vice versa); trying the other typed endpoint is safe and
  // avoids a fake permission wall.
  const order = preferDataSource ? [asDataSource, asDatabase] : [asDatabase, asDataSource];
  for (const attempt of order) {
    const entry = await attempt();
    if (entry) return entry;
  }
  return null;
}

async function searchDataSources(ctx: Context, query?: string): Promise<KnownDataSource[]> {
  const body: Json = { page_size: 50, filter: { property: 'object', value: 'data_source' } };
  if (query) body.query = query;
  const payload = await ctx.request('/search', 'POST', body);
  const results = Array.isArray(payload.results) ? payload.results.filter(isObject) : [];
  return results.flatMap((row) => {
    const entry = row.object === 'database' ? rememberDatabase(ctx.cache, row) : rememberDataSource(ctx.cache, row);
    return entry ? [entry] : [];
  });
}

/** Resolve a title-like hint through the cache, then a targeted search, then a full listing. */
async function resolveByTitle(ctx: Context, hint: string): Promise<KnownDataSource | null> {
  const attempt = (candidates: KnownDataSource[]): KnownDataSource | null => {
    const { match, ambiguous } = bestTitleMatch(hint, candidates);
    if (ambiguous) throw ambiguousDatabaseError(hint, ambiguous);
    return match ?? null;
  };
  const cached = attempt(ctx.cache.list());
  if (cached) return cached;
  const query = titleTokens(hint).join(' ');
  if (query) {
    const targeted = attempt(await searchDataSources(ctx, query));
    if (targeted) return targeted;
  }
  return attempt(await searchDataSources(ctx));
}

async function withSchema(ctx: Context, entry: KnownDataSource, needSchema: boolean): Promise<ResolvedTarget> {
  const cachedSchema = ctx.cache.freshSchema(entry.data_source_id);
  let resolved = entry;
  let schema = cachedSchema;
  if (needSchema && !schema) {
    resolved = await fetchDataSource(ctx, entry.data_source_id);
    schema = resolved.schema;
  } else {
    ctx.cache.touch(entry.data_source_id);
  }
  return {
    data_source_id: resolved.data_source_id,
    database_id: resolved.database_id,
    title: resolved.title,
    schema,
  };
}

/**
 * Turn whatever the caller supplied (database_id, data_source_id, database
 * title, dashed/undashed/URL, hallucinated id) into a real data source.
 */
async function resolveTarget(ctx: Context, args: NotionArgs, needSchema: boolean): Promise<ResolvedTarget> {
  const supplied = [
    { value: args.data_source_id, preferDataSource: true },
    { value: args.database_id, preferDataSource: false },
    { value: args.database, preferDataSource: false },
  ].flatMap(item => (
    typeof item.value === 'string' && item.value.trim()
      ? [{ value: item.value.trim(), preferDataSource: item.preferDataSource }]
      : []
  ));
  if (supplied.length === 0) {
    throw new Error('Missing required parameter: database_id, data_source_id, or database (title)');
  }

  const titleHints: string[] = [];
  const notFound: string[] = [];
  for (const { value, preferDataSource } of supplied) {
    const id = normalizeNotionId(value);
    if (!id) {
      titleHints.push(value);
      continue;
    }
    const cached = ctx.cache.findById(id);
    if (cached) {
      try {
        return await withSchema(ctx, cached, needSchema);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        ctx.cache.forget(id); // stale cache entry: the database no longer exists
      }
    }
    const live = await lookupById(ctx, id, preferDataSource);
    if (live) return withSchema(ctx, live, needSchema);
    notFound.push(value);
  }

  for (const hint of titleHints) {
    const entry = await resolveByTitle(ctx, hint);
    if (entry) {
      return { ...(await withSchema(ctx, entry, needSchema)), resolved_from: notFound[0] ?? hint };
    }
  }
  throw unknownDatabaseError(supplied[0].value, ctx.cache);
}

/**
 * Identifier fields for a result. `titleKey` is `title` for database-level
 * actions and `database` for page-level ones (where `title` is the page's).
 */
function targetFields(target: ResolvedTarget, titleKey: 'title' | 'database'): Json {
  return {
    data_source_id: target.data_source_id,
    database_id: target.database_id,
    [titleKey]: target.title,
    ...(target.resolved_from ? { resolved_from: target.resolved_from } : {}),
  };
}

function parseProperties(value: unknown): Json {
  let properties = value;
  if (typeof properties === 'string') {
    try { properties = JSON.parse(properties); } catch { /* fall through to the error below */ }
  }
  if (!isObject(properties) || Object.keys(properties).length === 0) {
    throw new Error('Missing required parameter: properties (an object of property values)');
  }
  return properties;
}

function withSchemaHint(error: unknown, schema: CachedSchema | undefined): never {
  if (error instanceof NotionRequestError && error.status === 400 && schema) {
    throw new NotionRequestError(
      `${error.message}. Valid properties: ${describeSchema(schema)}.`,
      error.status,
      error.code,
    );
  }
  throw error;
}

export async function executeNotion(
  args: NotionArgs,
  options: NotionClientOptions,
): Promise<Json> {
  const now = options.now ?? (() => new Date());
  const cache = new NotionCache(options.cachePath ?? resolveCachePath(), now);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const request: Request = async (path, method = 'GET', body) => {
    const token = required(options.token, 'NOTION_TOKEN');
    if (!fetchImpl) throw new Error('This Node.js runtime does not provide fetch');
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
    let payload: Json = {};
    try {
      payload = text ? JSON.parse(text) as Json : {};
    } catch {
      throw new Error(`Notion HTTP ${response.status}: non-JSON response`);
    }
    if (!response.ok) {
      const code = typeof payload.code === 'string' ? payload.code : 'request_failed';
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown Notion error';
      throw new NotionRequestError(`Notion HTTP ${response.status} ${code}: ${message}`, response.status, code);
    }
    return payload;
  };

  const ctx: Context = { request, cache };
  try {
    return await run(ctx, args);
  } finally {
    cache.save();
  }
}

async function run(ctx: Context, args: NotionArgs): Promise<Json> {
  switch (args.action) {
    case 'known': {
      const databases = ctx.cache.list().map(compactKnown);
      return {
        success: true,
        action: args.action,
        databases,
        ...(databases.length === 0 ? { hint: 'No databases cached yet. Use action=search.' } : {}),
      };
    }
    case 'search': {
      const body: Json = { page_size: Math.min(100, Math.max(1, args.page_size ?? 20)) };
      if (args.query?.trim()) body.query = args.query.trim();
      if (args.object_type) body.filter = { property: 'object', value: args.object_type };
      const result = await ctx.request('/search', 'POST', body);
      return { success: true, action: args.action, result: compactSearchResult(ctx.cache, result) };
    }
    case 'schema': {
      const target = await resolveTarget(ctx, args, false);
      // An explicit schema request always refreshes from Notion.
      const raw = await ctx.request(`/data_sources/${target.data_source_id}`);
      const entry = rememberDataSource(ctx.cache, raw);
      return {
        success: true,
        action: args.action,
        ...targetFields({ ...target, title: entry?.title || target.title }, 'title'),
        properties: entry?.schema ?? schemaFromProperties(raw.properties),
        ...(args.verbose ? { result: raw } : {}),
      };
    }
    case 'query': {
      const target = await resolveTarget(ctx, args, false);
      const body: Json = { page_size: Math.min(100, Math.max(1, args.page_size ?? 100)) };
      if (args.filter) body.filter = args.filter;
      if (args.sorts) body.sorts = args.sorts;
      if (args.start_cursor) body.start_cursor = args.start_cursor;
      const result = await ctx.request(`/data_sources/${target.data_source_id}/query`, 'POST', body);
      return { success: true, action: args.action, ...targetFields(target, 'title'), result: compactQueryResult(result) };
    }
    case 'create': {
      const input = parseProperties(args.properties);
      const target = await resolveTarget(ctx, args, true);
      const coerced = target.schema
        ? coerceProperties(input, target.schema, { title: target.title })
        : { properties: input, renamed: {} };
      let page: Json;
      try {
        page = await ctx.request('/pages', 'POST', {
          parent: { type: 'data_source_id', data_source_id: target.data_source_id },
          properties: coerced.properties,
        });
      } catch (error) {
        withSchemaHint(error, target.schema);
      }
      if (typeof page.id !== 'string' || !page.id) throw new Error('Notion create returned no page ID');
      return {
        success: true,
        action: args.action,
        ...compactPage(page),
        ...targetFields(target, 'database'),
        ...(Object.keys(coerced.renamed).length > 0 ? { renamed_properties: coerced.renamed } : {}),
      };
    }
    case 'update': {
      const pageId = normalizeNotionId(args.page_id) ?? required(args.page_id, 'page_id');
      const input = parseProperties(args.properties);
      let target: ResolvedTarget | undefined;
      if (args.data_source_id || args.database_id || args.database) {
        target = await resolveTarget(ctx, args, true);
      } else {
        // Find the page's data source so primitives can still be typed.
        try {
          const existing = await ctx.request(`/pages/${pageId}`);
          const parent = isObject(existing.parent) ? existing.parent : {};
          const parentId = typeof parent.data_source_id === 'string'
            ? parent.data_source_id
            : (typeof parent.database_id === 'string' ? parent.database_id : undefined);
          if (parentId) target = await resolveTarget(ctx, { action: 'update', data_source_id: parentId }, true);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      const coerced = target?.schema
        ? coerceProperties(input, target.schema, { title: target.title })
        : { properties: input, renamed: {} };
      let page: Json;
      try {
        page = await ctx.request(`/pages/${pageId}`, 'PATCH', { properties: coerced.properties });
      } catch (error) {
        withSchemaHint(error, target?.schema);
      }
      if (typeof page.id !== 'string' || !page.id) throw new Error('Notion update returned no page ID');
      return {
        success: true,
        action: args.action,
        ...compactPage(page),
        ...(target ? targetFields(target, 'database') : {}),
        ...(Object.keys(coerced.renamed).length > 0 ? { renamed_properties: coerced.renamed } : {}),
      };
    }
    default:
      throw new Error(`Unsupported Notion action: ${String(args.action)}. Use search, known, schema, query, create, or update.`);
  }
}

export { NotionInputError };
