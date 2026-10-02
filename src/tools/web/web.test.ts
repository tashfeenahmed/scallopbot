import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../../skills/types.js';
import { cachedSearch, clearSearchCache, htmlToText, registerWebTools, webFetch } from './index.js';

const publicUrl = async () => ({ safe: true });

function htmlResponse(body: string, status = 200, type = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

describe('webfetch', () => {
  let root: string;
  let saved: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'webfetch-'));
    saved = process.env.SCALLOPBOT_HOME;
    process.env.SCALLOPBOT_HOME = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SCALLOPBOT_HOME;
    else process.env.SCALLOPBOT_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('converts HTML to text', () => {
    expect(htmlToText('<html><script>x()</script><h1>Title</h1><p>a &amp; b</p></html>')).toBe('Title\na & b');
  });

  it('returns small pages whole, with no LLM in the path', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<p>Hello world</p>'));
    const r = await webFetch({ url: 'https://example.com/' }, { sessionId: 's' }, { fetchImpl, checkUrl: publicUrl });
    expect(r.success).toBe(true);
    expect(r.output).toContain('status 200');
    expect(r.output).toContain('Hello world');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps at 15k chars head+tail and saves the full text', async () => {
    const body = `<p>START ${'a'.repeat(20_000)}</p><p>${'m'.repeat(20_000)}</p><p>${'z'.repeat(20_000)} END</p>`;
    const r = await webFetch(
      { url: 'https://example.com/long' }, { sessionId: 's' },
      { fetchImpl: async () => htmlResponse(body), checkUrl: publicUrl },
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('START');
    expect(r.output).toContain('END');
    expect(r.output.length).toBeLessThan(15_800);
    const file = r.output.match(/full text saved to (\S+\.txt)/)![1];
    expect(readFileSync(file, 'utf8')).toContain('m'.repeat(20_000));
  });

  it('reports HTTP errors, blocked URLs and bad schemes', async () => {
    const r404 = await webFetch({ url: 'https://example.com/x' }, { sessionId: 's' }, { fetchImpl: async () => htmlResponse('nope', 404), checkUrl: publicUrl });
    expect(r404.success).toBe(false);
    expect(r404.output).toMatch(/HTTP 404/);
    const blocked = await webFetch({ url: 'http://127.0.0.1/' }, { sessionId: 's' });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toMatch(/private/);
    expect((await webFetch({ url: 'ftp://x/y' }, { sessionId: 's' })).output).toMatch(/http and https/);
  });

  it('rejects soft-404 shells', async () => {
    const r = await webFetch({ url: 'https://example.com/x' }, { sessionId: 's' }, { fetchImpl: async () => htmlResponse('<h1>404 Not Found</h1>'), checkUrl: publicUrl });
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/soft 404/);
  });
});

describe('web_search cache', () => {
  beforeEach(() => clearSearchCache());

  const braveBody = JSON.stringify({ web: { results: [{ title: 'T', url: 'https://t', description: 'd' }] } });

  it('single-flights identical concurrent queries and caches for 20 minutes', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response(braveBody, { status: 200 })) as unknown as typeof fetch;
    const deps = { fetchImpl, apiKey: 'k', now: () => now };
    const args = { query: 'Hello  World', count: 5 };
    const [a, b] = await Promise.all([cachedSearch(args, deps), cachedSearch({ ...args, query: 'hello world' }, deps)]);
    expect(a.output).toContain('1. T');
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 19 * 60 * 1000;
    await cachedSearch(args, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 1000;
    await cachedSearch(args, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await cachedSearch({ ...args, count: 3 }, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const deps = { fetchImpl, apiKey: 'k' };
    expect((await cachedSearch({ query: 'q', count: 5 }, deps)).success).toBe(false);
    await cachedSearch({ query: 'q', count: 5 }, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('registerWebTools keeps tool names and overrides the disk web_search handler', async () => {
    const registered: Skill[] = [];
    const disk = { name: 'web_search', description: 'disk', available: true, frontmatter: { name: 'web_search', description: 'disk' } } as unknown as Skill;
    const fetchImpl = vi.fn(async () => new Response(braveBody, { status: 200 })) as unknown as typeof fetch;
    registerWebTools(
      { registerSkill: (s) => { registered.push(s); }, getSkill: (n) => (n === 'web_search' ? disk : undefined) },
      { search: { fetchImpl, apiKey: 'k' } },
    );
    expect(registered.map(s => s.name)).toEqual(['webfetch', 'web_search']);
    const search = registered[1];
    expect(search.description).toBe('disk');
    expect(search.source).toBe('sdk');
    const r = await search.handler!({ args: { query: 'x' }, workspace: '/', sessionId: 's' });
    expect(r.success).toBe(true);
    const bad = await search.handler!({ args: {}, workspace: '/', sessionId: 's' });
    expect(bad.success).toBe(false);
  });
});
