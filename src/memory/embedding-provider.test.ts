import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import pino from 'pino';
import {
  createConfiguredEmbedder,
  embeddingModelKey,
  LEGACY_EMBEDDING_KEY,
  resolveEmbeddingSettings,
  TFIDF_EMBEDDING_KEY,
} from './embedding-config.js';
import { OllamaEmbedder, type EmbeddingProvider } from './embeddings.js';
import { ScallopDatabase } from './db.js';
import { ScallopMemoryStore } from './scallop-store.js';
import { reembedStale } from './reembed.js';

const logger = pino({ level: 'silent' });
const TEST_DIR = path.join(os.tmpdir(), `smartbot-embed-provider-${process.pid}-${Date.now()}`);

/** Deterministic toy vector: one-hot-ish by text hash, so equal texts match. */
function vectorFor(text: string, dimension: number): number[] {
  const v = new Array(dimension).fill(0.01);
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  v[h % dimension] = 1;
  return v;
}

interface MockOllama {
  url: string;
  requests: Array<{ path: string; body: { model: string; input?: string[]; prompt?: string } }>;
  failing: boolean;
  close(): Promise<void>;
}

async function startMockOllama(options: {
  dimension?: number;
  models?: string[];
  legacyOnly?: boolean;
} = {}): Promise<MockOllama> {
  const dimension = options.dimension ?? 8;
  const models = options.models ?? ['nomic-embed-text'];
  const state = { failing: false };
  const requests: MockOllama['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? '', body });
      if (state.failing) {
        res.writeHead(500).end('boom');
        return;
      }
      if (req.url === '/api/embed' && !options.legacyOnly) {
        if (!models.includes(body.model)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: `model "${body.model}" not found, try pulling it first` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          model: body.model,
          embeddings: (body.input as string[]).map(text => vectorFor(text, dimension)),
        }));
        return;
      }
      if (req.url === '/api/embeddings') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ embedding: vectorFor(body.prompt, dimension) }));
        return;
      }
      res.writeHead(404).end('404 page not found');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const mock: MockOllama = {
    url: `http://127.0.0.1:${port}`,
    requests,
    get failing() { return state.failing; },
    set failing(value: boolean) { state.failing = value; },
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  return mock;
}

let mock: MockOllama | undefined;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const dbPath = (name: string) => path.join(TEST_DIR, `${name}.db`);

describe('embedding settings', () => {
  it('parses EMBEDDING_PROVIDER / EMBEDDING_MODEL', () => {
    expect(resolveEmbeddingSettings({})).toEqual({ provider: 'auto', model: undefined });
    expect(resolveEmbeddingSettings({ EMBEDDING_PROVIDER: 'Ollama', EMBEDDING_MODEL: 'mxbai-embed-large' }))
      .toEqual({ provider: 'ollama', model: 'mxbai-embed-large' });
    expect(resolveEmbeddingSettings({ EMBEDDING_PROVIDER: 'bogus' }))
      .toMatchObject({ provider: 'auto', invalidValue: 'bogus' });
    expect(embeddingModelKey('ollama')).toBe('ollama:nomic-embed-text');
    expect(embeddingModelKey('openai')).toBe('openai:text-embedding-3-small');
    expect(embeddingModelKey('tfidf', 'ignored')).toBe(TFIDF_EMBEDDING_KEY);
  });
});

describe('createConfiguredEmbedder', () => {
  it('uses Ollama /api/embed with batched input and learns the dimension', async () => {
    mock = await startMockOllama({ dimension: 12, models: ['mxbai-embed-large'] });
    const setup = await createConfiguredEmbedder({
      env: { EMBEDDING_PROVIDER: 'ollama', EMBEDDING_MODEL: 'mxbai-embed-large' },
      ollamaBaseUrl: mock.url,
    });
    expect(setup).toMatchObject({ provider: 'ollama', key: 'ollama:mxbai-embed-large', fellBack: false });
    expect(setup.embedder.dimension).toBe(12);

    const vectors = await setup.embedder.embedBatch(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    const batchCall = mock.requests.at(-1)!;
    expect(batchCall.path).toBe('/api/embed');
    expect(batchCall.body).toEqual({ model: 'mxbai-embed-large', input: ['a', 'b', 'c'] });
  });

  it('falls back to TF-IDF with a warning when an explicit Ollama is unreachable', async () => {
    mock = await startMockOllama();
    const deadUrl = mock.url;
    await mock.close();
    mock = undefined;
    const warn = vi.fn();
    const info = vi.fn();
    const setup = await createConfiguredEmbedder({
      env: { EMBEDDING_PROVIDER: 'ollama' },
      ollamaBaseUrl: deadUrl,
      logger: { warn, info },
    });
    expect(setup).toMatchObject({ provider: 'tfidf', key: TFIDF_EMBEDDING_KEY, fellBack: true });
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/falling back to TF-IDF/));

    const auto = await createConfiguredEmbedder({ env: {}, ollamaBaseUrl: deadUrl, logger: { warn: vi.fn(), info } });
    expect(auto.provider).toBe('tfidf');
    expect(info).toHaveBeenCalled();
  });

  it('falls back when the model is not pulled and explains how to fix it', async () => {
    mock = await startMockOllama({ models: [] });
    const warn = vi.fn();
    const setup = await createConfiguredEmbedder({
      env: { EMBEDDING_PROVIDER: 'ollama' },
      ollamaBaseUrl: mock.url,
      logger: { warn, info: vi.fn() },
    });
    expect(setup.fellBack).toBe(true);
    expect(setup.reason).toContain('ollama pull nomic-embed-text');
  });

  it('uses the legacy /api/embeddings endpoint on old Ollama servers', async () => {
    mock = await startMockOllama({ legacyOnly: true, dimension: 6 });
    const embedder = new OllamaEmbedder({ baseUrl: mock.url, model: 'nomic-embed-text' });
    const vectors = await embedder.embedBatch(['x', 'y']);
    expect(vectors.map(v => v.length)).toEqual([6, 6]);
    expect(mock.requests.map(r => r.path)).toEqual(['/api/embed', '/api/embeddings', '/api/embeddings']);
  });

  it('openai without a key degrades to TF-IDF; tfidf needs no network', async () => {
    const warn = vi.fn();
    const openai = await createConfiguredEmbedder({ env: { EMBEDDING_PROVIDER: 'openai' }, logger: { warn, info: vi.fn() } });
    expect(openai).toMatchObject({ provider: 'tfidf', fellBack: true });
    expect(warn).toHaveBeenCalled();
    const withKey = await createConfiguredEmbedder({ env: { EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' } });
    expect(withKey.key).toBe('openai:text-embedding-3-small');
    const tfidf = await createConfiguredEmbedder({ env: { EMBEDDING_PROVIDER: 'tfidf' } });
    expect(tfidf).toMatchObject({ provider: 'tfidf', fellBack: false });
  });
});

/** Fixed-dimension fake provider for store/DB tests. */
function fakeEmbedder(dimension: number, name = 'fake'): EmbeddingProvider & { calls: number } {
  const embedder = {
    name,
    dimension,
    calls: 0,
    isAvailable: () => true,
    embed: async (text: string) => {
      embedder.calls++;
      return vectorFor(text, dimension);
    },
    embedBatch: async (texts: string[]) => {
      embedder.calls++;
      return texts.map(text => vectorFor(text, dimension));
    },
  };
  return embedder;
}

describe('embedding space isolation', () => {
  it('never compares vectors from a different provider or dimension', async () => {
    const file = dbPath('mismatch');
    const tfidfStore = new ScallopMemoryStore({
      dbPath: file, logger, embedder: fakeEmbedder(5, 'tfidf-like'), embeddingModel: 'tfidf:v1',
    });
    await tfidfStore.add({ userId: 'u', content: 'I love hiking in the alps', detectRelations: false });
    expect(tfidfStore.getDatabase().getAllMemories()[0].embedding).toHaveLength(5);
    tfidfStore.close();

    // Same DB, new provider with a different dimension.
    const ollama = fakeEmbedder(8, 'ollama-like');
    const ollamaStore = new ScallopMemoryStore({
      dbPath: file, logger, embedder: ollama, embeddingModel: 'ollama:nomic-embed-text',
    });
    const db = ollamaStore.getDatabase();
    const [old] = db.getAllMemories();
    expect(old.embedding).toBeNull();
    expect(db.getEmbeddingsByIds([old.id]).size).toBe(0);
    const results = await ollamaStore.search('hiking alps', { userId: 'u' });
    // Still found lexically; semantic score comes from no foreign vector.
    expect(results[0]?.memory.content).toContain('hiking');
    expect(db.countStaleEmbeddings('ollama:nomic-embed-text').memories).toBe(1);
    ollamaStore.close();

    // Unscoped access (tools/tests) still sees the raw vector.
    const raw = new ScallopDatabase(file);
    expect(raw.getAllMemories()[0].embedding).toHaveLength(5);
    raw.close();
  });

  it('hides same-dimension vectors from another model', async () => {
    const file = dbPath('same-dim');
    const a = new ScallopMemoryStore({ dbPath: file, logger, embedder: fakeEmbedder(8), embeddingModel: 'ollama:model-a' });
    await a.add({ userId: 'u', content: 'coffee every morning', detectRelations: false });
    a.close();
    const db = new ScallopDatabase(file);
    db.setEmbeddingModel('ollama:model-b');
    expect(db.getAllMemories()[0].embedding).toBeNull();
    db.setEmbeddingModel('ollama:model-a');
    expect(db.getAllMemories()[0].embedding).toHaveLength(8);
    db.close();
  });

  it('migration tags legacy 768-dim vectors as nomic-embed-text and leaves others stale', () => {
    const file = dbPath('legacy');
    const db = new ScallopDatabase(file);
    const base = {
      userId: 'u', category: 'fact' as const, memoryType: 'regular' as const, importance: 5,
      confidence: 0.8, isLatest: true, source: 'user' as const, documentDate: Date.now(),
      eventDate: null, prominence: 1, lastAccessed: null, accessCount: 0, sourceChunk: null,
      metadata: null, learnedFrom: 'conversation', timesConfirmed: 1, contradictionIds: null,
    };
    const legacy = db.addMemory({ ...base, content: 'legacy nomic', embedding: new Array(768).fill(0.1) });
    const odd = db.addMemory({ ...base, content: 'legacy other', embedding: [0.1, 0.2, 0.3] });
    db.close();

    // Simulate a pre-migration database.
    const sqlite = new Database(file);
    sqlite.exec('DROP INDEX IF EXISTS idx_memories_embedding_model');
    sqlite.exec('ALTER TABLE memories DROP COLUMN embedding_model');
    sqlite.exec('ALTER TABLE session_summaries DROP COLUMN embedding_model');
    sqlite.close();

    const migrated = new ScallopDatabase(file);
    migrated.setEmbeddingModel(LEGACY_EMBEDDING_KEY);
    expect(migrated.getMemory(legacy.id)?.embedding).toHaveLength(768);
    expect(migrated.getMemory(odd.id)?.embedding).toBeNull();
    expect(migrated.countStaleEmbeddings(LEGACY_EMBEDDING_KEY).memories).toBe(1);
    migrated.close();
  });
});

describe('reembedStale', () => {
  async function seed(file: string, count: number): Promise<void> {
    // Orthogonal one-hot vectors so ingestion dedup never merges seeds.
    let next = 0;
    const orthogonal: EmbeddingProvider = {
      name: 'seed', dimension: 64, isAvailable: () => true,
      embed: async () => { const v = new Array(64).fill(0); v[next++ % 64] = 1; return v; },
      embedBatch: async texts => Promise.all(texts.map(() => orthogonal.embed(''))),
    };
    const store = new ScallopMemoryStore({ dbPath: file, logger, embedder: orthogonal, embeddingModel: 'tfidf:v1' });
    for (let i = 0; i < count; i++) {
      await store.add({ userId: 'u', content: `distinct memory number ${i} about topic${i}`, detectRelations: false });
    }
    store.close();
  }

  it('re-embeds in batches with progress, and resumes after a limit', async () => {
    const file = dbPath('reembed');
    await seed(file, 7);
    mock = await startMockOllama({ dimension: 8 });
    const embedder = new OllamaEmbedder({ baseUrl: mock.url, model: 'nomic-embed-text' });
    const key = 'ollama:nomic-embed-text';
    const db = new ScallopDatabase(file);
    db.setEmbeddingModel(key);
    expect(db.countStaleEmbeddings(key).memories).toBe(7);

    const progress: number[] = [];
    const first = await reembedStale(db, embedder, key, {
      batchSize: 2, limit: 4, onProgress: p => progress.push(p.embedded),
    });
    expect(first).toMatchObject({ memories: { embedded: 4, failed: 0 }, incomplete: true });
    expect(progress).toEqual([2, 4]);
    expect(mock.requests.filter(r => r.path === '/api/embed').map(r => r.body.input?.length)).toEqual([2, 2]);
    expect(db.countStaleEmbeddings(key).memories).toBe(3);

    const second = await reembedStale(db, embedder, key, { batchSize: 2 });
    expect(second).toMatchObject({ memories: { embedded: 3, failed: 0 }, incomplete: false });
    expect(db.countStaleEmbeddings(key).memories).toBe(0);
    expect(db.getAllMemories().filter(m => m.source === 'user').every(m => m.embedding?.length === 8)).toBe(true);

    // Semantic candidates now come from the new space.
    const target = db.getAllMemories().find(m => m.content.includes('number 3'))!;
    const ids = db.getSemanticCandidateIds(vectorFor(target.content, 8), { userId: 'u', maxCandidates: 10 });
    expect(ids).toContain(target.id);
    db.close();
  });

  it('stops when the provider keeps failing and leaves rows stale for the next run', async () => {
    const file = dbPath('failing');
    await seed(file, 6);
    mock = await startMockOllama({ dimension: 8 });
    mock.failing = true;
    const key = 'ollama:nomic-embed-text';
    const db = new ScallopDatabase(file);
    db.setEmbeddingModel(key);
    const result = await reembedStale(db, new OllamaEmbedder({ baseUrl: mock.url, model: 'nomic-embed-text' }), key, {
      batchSize: 1, maxConsecutiveFailedBatches: 2,
    });
    expect(result.incomplete).toBe(true);
    expect(result.error).toMatch(/re-run to resume/);
    expect(result.memories.failed).toBe(2);
    expect(db.countStaleEmbeddings(key).memories).toBe(6);
    db.close();
  });

  it('--all style: markAllEmbeddingsStale makes current vectors re-embeddable', async () => {
    const file = dbPath('force');
    await seed(file, 2);
    const db = new ScallopDatabase(file);
    expect(db.countStaleEmbeddings('tfidf:v1').memories).toBe(0);
    db.markAllEmbeddingsStale();
    expect(db.countStaleEmbeddings('tfidf:v1').memories).toBe(2);
    const result = await reembedStale(db, fakeEmbedder(64), 'tfidf:v1');
    expect(result.memories.embedded).toBe(2);
    db.close();
  });

  it('store backfill re-embeds stale vectors on startup', async () => {
    const file = dbPath('backfill');
    await seed(file, 3);
    const embedder = fakeEmbedder(8);
    const store = new ScallopMemoryStore({ dbPath: file, logger, embedder, embeddingModel: 'ollama:nomic-embed-text' });
    expect(await store.backfillEmbeddings({ includeStale: false })).toBe(0);
    expect(await store.backfillEmbeddings({ batchSize: 2 })).toBe(3);
    expect(store.getDatabase().getAllMemories().filter(m => m.source === 'user').every(m => m.embedding?.length === 8)).toBe(true);
    store.close();
  });
});
