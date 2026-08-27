/**
 * End-to-end tests for the ScallopBot MCP server.
 *
 * The server is spawned as a real subprocess and driven over stdio with
 * newline-delimited JSON-RPC, exactly as an MCP client would. Each test run
 * gets its own temp database, so the repo's own memories.db is never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ENTRY = path.join(HERE, 'index.ts');

interface RpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: any;
  error?: { code: number; message: string };
}

/** A live MCP server subprocess plus the request plumbing to talk to it. */
class ServerHarness {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (response: RpcResponse) => void>();
  private stderr = '';

  constructor(dbPath: string) {
    this.child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, SCALLOPBOT_DB: dbPath, LOG_LEVEL: 'silent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(String(chunk)));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr += String(chunk);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcResponse;
      const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (resolve) {
        this.pending.delete(message.id as number);
        resolve(message);
      }
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${method}" timed out. stderr:\n${this.stderr}`));
      }, 10000);
      this.pending.set(id, response => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Call a tool and return its text content, asserting it did not error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.request('tools/call', { name, arguments: args });
    expect(response.error, `${name} returned a protocol error`).toBeUndefined();
    expect(response.result.isError, `${name} reported: ${response.result.content?.[0]?.text}`)
      .toBeFalsy();
    return response.result.content.map((part: { text: string }) => part.text).join('\n');
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => resolve(), 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}

describe('ScallopBot MCP server (stdio)', () => {
  let tempDir: string;
  let harness: ServerHarness;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scallopbot-mcp-'));
    harness = new ServerHarness(path.join(tempDir, 'memories.db'));

    const init = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result.protocolVersion).toBe('2024-11-05');
    expect(init.result.serverInfo.name).toBe('scallopbot');
    expect(init.result.capabilities.tools).toBeDefined();
    harness.notify('notifications/initialized');
  }, 30000);

  afterAll(async () => {
    await harness?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists all three memory tools with input schemas', async () => {
    const response = await harness.request('tools/list');
    expect(response.error).toBeUndefined();

    const names = response.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.sort()).toEqual(['memory_recall', 'memory_store', 'memory_temporal']);

    for (const tool of response.result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }

    const store = response.result.tools.find((t: { name: string }) => t.name === 'memory_store');
    expect(store.inputSchema.required).toEqual(['text']);
  });

  it('stores two memories and recalls one by query', async () => {
    const first = await harness.callTool('memory_store', {
      text: 'Tashfeen deployed ScallopBot to the Raspberry Pi in the study.',
      tags: ['deployment', 'hardware'],
      importance: 8,
      timestamp: '2026-03-04T10:00:00Z',
    });
    expect(first).toContain('Stored memory');
    expect(first).toContain('2026-03-04');
    expect(first).toContain('deployment');

    const second = await harness.callTool('memory_store', {
      text: 'The espresso machine in the kitchen needs descaling every two months.',
      importance: 3,
    });
    expect(second).toContain('Stored memory');

    const recalled = await harness.callTool('memory_recall', {
      query: 'espresso machine descaling',
      limit: 5,
    });
    expect(recalled).toContain('espresso machine');
    // No embedding provider is configured in the standalone server, so recall
    // must fall back to BM25 and say so rather than silently degrading.
    expect(recalled).toContain('BM25 keyword-only');
    expect(recalled).not.toContain('Raspberry Pi');
  }, 30000);

  it('answers a temporal query over an explicit window', async () => {
    const inWindow = await harness.callTool('memory_temporal', {
      start: '2026-03-01T00:00:00Z',
      end: '2026-03-31T23:59:59Z',
    });
    expect(inWindow).toContain('Raspberry Pi');
    expect(inWindow).toContain('2026-03-04');

    const outsideWindow = await harness.callTool('memory_temporal', {
      start: '2020-01-01T00:00:00Z',
      end: '2020-12-31T23:59:59Z',
    });
    expect(outsideWindow).toContain('No dated memories');
  }, 30000);

  it('rejects bad tool arguments with an invalid-params error', async () => {
    const missingText = await harness.request('tools/call', {
      name: 'memory_store',
      arguments: {},
    });
    expect(missingText.error?.code).toBe(-32602);

    const badWindow = await harness.request('tools/call', {
      name: 'memory_temporal',
      arguments: { start: '2026-03-01T00:00:00Z' },
    });
    expect(badWindow.error?.code).toBe(-32602);
    expect(badWindow.error?.message).toContain('together');

    const unknownTool = await harness.request('tools/call', {
      name: 'memory_nope',
      arguments: {},
    });
    expect(unknownTool.error?.code).toBe(-32601);
  });

  it('answers ping and rejects unknown methods', async () => {
    const ping = await harness.request('ping');
    expect(ping.error).toBeUndefined();

    const unknown = await harness.request('totally/unknown');
    expect(unknown.error?.code).toBe(-32601);
  });
});
