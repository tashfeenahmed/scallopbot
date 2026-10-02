/**
 * Recall reranking: on by default (+6% on LoCoMo) but time-limited, so a slow
 * reranker falls back to the fused ranking instead of stalling the reply.
 * rerank:false (fact extraction, dedupe) makes zero LLM calls and stays fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import { TFIDFEmbedder } from './embeddings.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';

const logger = pino({ level: 'silent' });

function countingProvider(): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    name: `counting-${Math.random()}`,
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"scores":[{"index":0,"score":0.9}]}' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'mock',
    } satisfies CompletionResponse),
  };
}

describe('foreground recall makes no LLM calls', () => {
  let dir: string;
  let provider: ReturnType<typeof countingProvider>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scallop-fg-'));
    provider = countingProvider();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(extra: Partial<ConstructorParameters<typeof ScallopMemoryStore>[0]> = {}) {
    return new ScallopMemoryStore({
      dbPath: path.join(dir, 'm.db'),
      logger,
      embedder: new TFIDFEmbedder(),
      rerankProvider: provider,
      relationsProvider: undefined,
      ...extra,
    });
  }

  async function seed(store: ScallopMemoryStore, count: number) {
    const vocab = [
      'sushi', 'hiking', 'typescript', 'guitar', 'dublin', 'marathon', 'coffee', 'chess', 'violin', 'garden',
      'python', 'kayak', 'sourdough', 'tennis', 'museum', 'lisbon', 'bicycle', 'novel', 'podcast', 'yoga',
      'pottery', 'climbing', 'ramen', 'jazz', 'camera', 'football', 'tokyo', 'painting', 'kubernetes', 'rust',
      'piano', 'surfing', 'berlin', 'cinema', 'skiing', 'poetry', 'baking', 'golf', 'opera', 'sailing',
    ];
    let seedState = 7;
    const next = () => (seedState = (seedState * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < count; i++) {
      const words = new Set<string>();
      while (words.size < 4) words.add(vocab[next() % vocab.length]);
      const [a, b, c, d] = [...words];
      await store.add({
        userId: 'u1',
        content: i < vocab.length
          ? `User enjoys ${vocab[i]}`
          : `Plan ${i}: ${a} then ${b}, maybe ${c} or ${d}`,
        category: 'fact',
        detectRelations: false,
        // Distinct 128-dim vectors so ingestion dedup keeps every row.
        embedding: Array.from({ length: 128 }, (_, j) => Math.sin((i + 1) * 12.9898 + j * 78.233) * 43758.5453 % 1),
      });
    }
  }

  const queryVector = Array.from({ length: 128 }, (_, i) => Math.sin(i + 1));

  it('search() reranks by default with one LLM call', async () => {
    const store = makeStore();
    try {
      await seed(store, 20);
      const results = await store.search('who likes sushi', { userId: 'u1', queryEmbedding: queryVector });
      expect(results.length).toBeGreaterThan(0);
      expect(provider.complete).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it('rerank:false opts a call out; foregroundRerank:false turns the default off', async () => {
    const store = makeStore();
    try {
      await seed(store, 10);
      await store.search('sushi', { userId: 'u1', rerank: false, queryEmbedding: queryVector });
      expect(provider.complete).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
    const off = makeStore({ dbPath: path.join(dir, 'off.db'), foregroundRerank: false });
    try {
      await seed(off, 10);
      await off.search('sushi', { userId: 'u1', queryEmbedding: queryVector });
      expect(provider.complete).not.toHaveBeenCalled();
    } finally {
      off.close();
    }
  });

  it('a slow reranker falls back to the fused ranking within the time limit', async () => {
    const slow = { ...provider, complete: vi.fn(() => new Promise<never>(() => {})) };
    const store = makeStore({ rerankProvider: slow as never, rerankTimeoutMs: 100 });
    try {
      await seed(store, 10);
      const started = performance.now();
      const results = await store.search('who likes sushi', { userId: 'u1', queryEmbedding: queryVector });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.content).toContain('sushi');
    } finally {
      store.close();
    }
  });

  it('MEMORY_FOREGROUND_RERANK (foregroundRerank) restores the old behaviour; rerank:false still wins', async () => {
    const store = makeStore({ foregroundRerank: true });
    try {
      await seed(store, 10);
      await store.search('sushi', { userId: 'u1', rerank: false, queryEmbedding: queryVector });
      expect(provider.complete).not.toHaveBeenCalled();
      await store.search('sushi', { userId: 'u1', queryEmbedding: queryVector });
      expect(provider.complete).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it('micro-benchmark: 500 memories, 20 searches with rerank:false, zero LLM calls, well under 300ms median', async () => {
    const store = makeStore();
    try {
      await seed(store, 500);
      const stored = store.getCount();
      expect(stored).toBe(500);
      const queries = ['sushi friend', 'dublin marathon', 'guitar', 'coffee chess', 'typescript hiking'];
      const timings: number[] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        const hits = await store.search(queries[i % queries.length], { userId: 'u1', minProminence: 0.1, limit: 10, queryEmbedding: queryVector, rerank: false });
        expect(hits.length).toBeGreaterThan(0);
        timings.push(performance.now() - started);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)];
      // Visible in verbose test output; the hard bound is generous for CI hosts.
      console.info(`[bench] foreground search median ${median.toFixed(1)}ms, p95 ${timings[18].toFixed(1)}ms over ${stored} memories`);
      expect(provider.complete).not.toHaveBeenCalled();
      expect(median).toBeLessThan(300);
    } finally {
      store.close();
    }
  });
});
