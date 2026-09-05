/**
 * Persistent per-instance cache of known Notion data sources.
 *
 * Stored at `${SCALLOPBOT_HOME|SCALLOPBOT_DATA_DIR|~/.scallopbot}/notion-cache.json`
 * (mode 0600, written atomically). It remembers every database the
 * integration has seen so later turns can write without a search + schema
 * round trip, and so an unknown ID can produce a useful "known databases" hint.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeNotionId } from './ids.js';

export interface CachedProperty {
  type: string;
  options?: string[];
}

export type CachedSchema = Record<string, CachedProperty>;

export interface KnownDataSource {
  title: string;
  database_id: string | null;
  data_source_id: string;
  last_used: string;
  schema?: CachedSchema;
  schema_fetched_at?: string;
}

interface CacheFile {
  version: 1;
  data_sources: KnownDataSource[];
}

export const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.SCALLOPBOT_HOME?.trim()
    || env.SCALLOPBOT_DATA_DIR?.trim()
    || join(homedir(), '.scallopbot');
  return join(home, 'notion-cache.json');
}

function isKnownDataSource(value: unknown): value is KnownDataSource {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.data_source_id === 'string'
    && !!normalizeNotionId(record.data_source_id)
    && typeof record.title === 'string';
}

export class NotionCache {
  private entries: KnownDataSource[] = [];
  private dirty = false;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.load();
  }

  private load(): void {
    try {
      // Tighten a pre-existing file that was created with looser permissions.
      if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    } catch { /* missing file, or a filesystem without POSIX modes */ }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CacheFile>;
      this.entries = Array.isArray(parsed?.data_sources)
        ? parsed.data_sources.filter(isKnownDataSource).map(entry => ({
          ...entry,
          data_source_id: normalizeNotionId(entry.data_source_id)!,
          database_id: normalizeNotionId(entry.database_id),
        }))
        : [];
    } catch {
      // Missing or corrupt cache: start empty and overwrite on the next save.
      this.entries = [];
    }
  }

  /** Known data sources, most recently used first. */
  list(): KnownDataSource[] {
    return [...this.entries].sort((a, b) => b.last_used.localeCompare(a.last_used));
  }

  findById(id: unknown): KnownDataSource | undefined {
    const wanted = normalizeNotionId(id);
    if (!wanted) return undefined;
    return this.entries.find(entry => (
      entry.data_source_id === wanted || (entry.database_id !== null && entry.database_id === wanted)
    ));
  }

  /** Cached schema for a data source when fetched less than SCHEMA_TTL_MS ago. */
  freshSchema(dataSourceId: unknown): CachedSchema | undefined {
    const entry = this.findById(dataSourceId);
    if (!entry?.schema || !entry.schema_fetched_at) return undefined;
    const age = this.now().getTime() - Date.parse(entry.schema_fetched_at);
    return Number.isFinite(age) && age >= 0 && age < SCHEMA_TTL_MS ? entry.schema : undefined;
  }

  remember(input: {
    title?: string;
    database_id?: string | null;
    data_source_id: string;
    schema?: CachedSchema;
  }): KnownDataSource | undefined {
    const dataSourceId = normalizeNotionId(input.data_source_id);
    if (!dataSourceId) return undefined;
    const databaseId = normalizeNotionId(input.database_id);
    const stamp = this.now().toISOString();
    let entry = this.entries.find(item => item.data_source_id === dataSourceId);
    if (!entry) {
      entry = { title: '', database_id: null, data_source_id: dataSourceId, last_used: stamp };
      this.entries.push(entry);
    }
    if (input.title?.trim()) entry.title = input.title.trim();
    if (databaseId) entry.database_id = databaseId;
    if (input.schema) {
      entry.schema = input.schema;
      entry.schema_fetched_at = stamp;
    }
    entry.last_used = stamp;
    this.dirty = true;
    return entry;
  }

  touch(dataSourceId: unknown): void {
    const entry = this.findById(dataSourceId);
    if (!entry) return;
    entry.last_used = this.now().toISOString();
    this.dirty = true;
  }

  forget(id: unknown): void {
    const entry = this.findById(id);
    if (!entry) return;
    this.entries = this.entries.filter(item => item !== entry);
    this.dirty = true;
  }

  /** Write the cache atomically (temp file + rename) with owner-only permissions. */
  save(): void {
    if (!this.dirty) return;
    const file: CacheFile = { version: 1, data_sources: this.entries };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* best effort on exotic filesystems */ }
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Fuzzy title matching ("gym_tracker" -> "🏋️ Gym Volume Tracker")
// ---------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set(['notion', 'the', 'my', 'a', 'database', 'db', 'data', 'source', 'table']);

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleTokens(value: string): string[] {
  return normalizeTitle(value).split(' ').filter(token => token && !TITLE_STOPWORDS.has(token));
}

/** 0 = no match, 1 = identical. */
export function scoreTitleMatch(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qTokens = titleTokens(query);
  const tTokens = titleTokens(title);
  if (qTokens.length === 0 || tTokens.length === 0) return 0;
  const qJoined = qTokens.join(' ');
  const tJoined = tTokens.join(' ');
  if (qJoined === tJoined) return 0.95;
  if (tJoined.includes(qJoined) || qJoined.includes(tJoined)) return 0.9;
  const titleSet = new Set(tTokens);
  const overlap = qTokens.filter(token => titleSet.has(token)).length;
  if (overlap === qTokens.length) return 0.85;
  const ratio = overlap / qTokens.length;
  return ratio >= 0.5 ? ratio * 0.8 : 0;
}

export function bestTitleMatch<T extends { title: string }>(
  query: string,
  candidates: T[],
): { match?: T; ambiguous?: T[] } {
  const scored = candidates
    .map(candidate => ({ candidate, score: scoreTitleMatch(query, candidate.title) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return {};
  const ties = scored.filter(item => item.score === scored[0].score);
  if (ties.length === 1) return { match: ties[0].candidate };
  return { ambiguous: ties.map(item => item.candidate) };
}
