import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  isAllowedMcpUrl,
  loadMCPConfig,
  resolveMcpHeaders,
  saveMCPConfig,
  type MCPServerConfig,
} from '../../../config/mcp-config.js';
import { handler } from './run.js';
import { SseParser } from './http-client.js';

const TEST_DIR = path.join(os.tmpdir(), `smartbot-mcp-http-test-${process.pid}-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'mcp.json');
const TOKEN = 'tok-9f8e7d6c5b4a';

type Mode = 'json' | 'sse' | 'hang' | 'secret-error';

interface ServerLog {
  methods: string[];
  authHeaders: (string | undefined)[];
  sessionHeaders: (string | undefined)[];
  protocolHeaders: (string | undefined)[];
  deletes: (string | undefined)[];
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo arguments',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  { name: 'hidden', description: 'Must be filtered', inputSchema: { type: 'object', properties: {} } },
];

function reply(msg: { id: number; method: string; params?: { arguments?: unknown } }, mode: Mode): unknown {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } };
  }
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  if (msg.method === 'tools/call') {
    if (mode === 'secret-error') {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -1, message: `upstream rejected ${TOKEN}` } };
    }
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ echoed: msg.params?.arguments }) }] } };
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

/** Tiny in-process MCP server speaking Streamable HTTP at /mcp and legacy SSE at /sse. */
function startServer(mode: Mode): Promise<{ server: http.Server; base: string; log: ServerLog }> {
  const log: ServerLog = { methods: [], authHeaders: [], sessionHeaders: [], protocolHeaders: [], deletes: [] };
  const sseStreams = new Map<string, http.ServerResponse>();
  let sessionCounter = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (url.pathname === '/mcp') {
      if (req.method === 'DELETE') {
        log.deletes.push(req.headers['mcp-session-id'] as string | undefined);
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const msg = JSON.parse(await readBody(req));
      log.methods.push(msg.method);
      log.authHeaders.push(req.headers.authorization);
      log.sessionHeaders.push(req.headers['mcp-session-id'] as string | undefined);
      log.protocolHeaders.push(req.headers['mcp-protocol-version'] as string | undefined);
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'session-abc') {
        res.writeHead(400).end('missing session');
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (mode === 'hang' && msg.method === 'tools/list') return; // never answer
      const headers: Record<string, string> = {};
      if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'session-abc';
      const body = reply(msg, mode);
      if (mode === 'sse') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
        // A server notification and a CRLF-delimited event precede the reply.
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
        res.write(`: keepalive\r\n`);
        res.end(`data: ${JSON.stringify(body)}\r\n\r\n`);
      } else {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
      return;
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = `s${++sessionCounter}`;
      sseStreams.set(id, res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      req.on('close', () => sseStreams.delete(id));
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const stream = sseStreams.get(url.searchParams.get('sessionId') ?? '');
      const msg = JSON.parse(await readBody(req));
      log.methods.push(msg.method);
      log.authHeaders.push(req.headers.authorization);
      if (!stream) {
        res.writeHead(404).end('unknown session');
        return;
      }
      res.writeHead(202).end('Accepted');
      if (msg.id !== undefined && !(mode === 'hang' && msg.method === 'tools/list')) {
        stream.write(`event: message\ndata: ${JSON.stringify(reply(msg, mode))}\n\n`);
      }
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, log });
    });
  });
}

let running: http.Server | undefined;
const savedEnv = process.env.MCP_TEST_TOKEN;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.MCP_TEST_TOKEN = TOKEN;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.MCP_TEST_TOKEN;
  else process.env.MCP_TEST_TOKEN = savedEnv;
  if (running) {
    running.closeAllConnections();
    await new Promise(resolve => running!.close(resolve));
    running = undefined;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function configure(mode: Mode, overrides: Partial<MCPServerConfig> = {}): Promise<ServerLog> {
  const { server, base, log } = await startServer(mode);
  running = server;
  const transport = overrides.transport ?? 'http';
  saveMCPConfig([{
    name: 'remote',
    url: `${base}${transport === 'sse' ? '/sse' : '/mcp'}`,
    transport,
    bearerToken: '${MCP_TEST_TOKEN}',
    headers: { 'X-Client': 'scallopbot-test' },
    timeoutMs: 1_000,
    allowedTools: ['echo'],
    ...overrides,
  }], TEST_CONFIG_PATH);
  return log;
}

const context = (args: Record<string, unknown>) => ({ args, workspace: TEST_DIR, sessionId: 's1' });
const opts = { configPath: TEST_CONFIG_PATH };

describe('remote MCP configuration', () => {
  it('accepts url servers and rejects mixed, insecure, or reserved-header configs', () => {
    const valid = { name: 'r', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': '${MCP_KEY}' } };
    saveMCPConfig([valid], TEST_CONFIG_PATH);
    expect(loadMCPConfig(TEST_CONFIG_PATH)).toEqual([valid]);

    const invalid: unknown[] = [
      { name: 'r', url: 'https://a.example/mcp', command: 'node' },
      { name: 'r' },
      { name: 'r', url: 'http://mcp.example.com/mcp' },
      { name: 'r', url: 'https://user:pw@mcp.example.com/mcp' },
      { name: 'r', url: 'ftp://localhost/mcp' },
      { name: 'r', url: 'https://a.example/mcp', transport: 'websocket' },
      { name: 'r', url: 'https://a.example/mcp', headers: { 'Mcp-Session-Id': 'x' } },
      { name: 'r', url: 'https://a.example/mcp', headers: { 'X-Bad': 'a\r\nb' } },
      { name: 'r', url: 'https://a.example/mcp', bearerToken: 't', headers: { Authorization: 'x' } },
      { name: 'r', url: 'https://a.example/mcp', env: { A: 'b' } },
      { name: 'r', command: 'node', headers: { 'X-A': 'b' } },
    ];
    for (const server of invalid) {
      expect(() => saveMCPConfig([server as MCPServerConfig], TEST_CONFIG_PATH)).toThrow();
    }
  });

  it('allows plain http only for loopback and private-network hosts', () => {
    expect(isAllowedMcpUrl('http://127.0.0.1:8080/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://localhost/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://192.168.1.20/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://pi.local/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://8.8.8.8/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://8.8.8.8/mcp')).toBe(true);
  });

  it('resolves ${VAR} header references and fails closed without leaking values', () => {
    const server: MCPServerConfig = { name: 'r', url: 'https://a.example', bearerToken: '${MCP_TEST_TOKEN}', headers: { 'X-K': 'pre-${MCP_TEST_TOKEN}' } };
    expect(resolveMcpHeaders(server)).toEqual({ 'X-K': `pre-${TOKEN}`, Authorization: `Bearer ${TOKEN}` });
    expect(() => resolveMcpHeaders({ ...server, bearerToken: '${MCP_UNSET_VAR_XYZ}' }))
      .toThrow(/MCP_UNSET_VAR_XYZ/);
  });
});

describe.each(['json', 'sse'] as const)('Streamable HTTP MCP (%s responses)', mode => {
  it('initializes a session, lists authorized tools, and calls a tool with auth headers', async () => {
    const log = await configure(mode);
    const tools = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(tools.success).toBe(true);
    expect(tools.output).toContain('echo');
    expect(tools.output).not.toContain('hidden');

    const call = await handler(context({ action: 'call', server: 'remote', tool: 'echo', args: { value: 'hi' } }), opts);
    expect(call.success).toBe(true);
    expect(call.output).toContain('untrusted_mcp_result');
    expect(call.output).toContain('echoed');
    expect(call.output).toContain('hi');

    expect(log.methods).toEqual([
      'initialize', 'notifications/initialized', 'tools/list',
      'initialize', 'notifications/initialized', 'tools/list', 'tools/call',
    ]);
    expect(log.authHeaders.every(header => header === `Bearer ${TOKEN}`)).toBe(true);
    // Session id is echoed after initialize, negotiated version is sent, and the session is released.
    expect(log.sessionHeaders[0]).toBeUndefined();
    expect(log.sessionHeaders.slice(1, 3)).toEqual(['session-abc', 'session-abc']);
    expect(log.protocolHeaders[0]).toBeUndefined();
    expect(log.protocolHeaders[2]).toBe('2025-03-26');
    expect(log.deletes).toEqual(['session-abc', 'session-abc']);
  });
});

describe('remote MCP failure handling', () => {
  it('rejects calls with invalid args before sending tools/call', async () => {
    const log = await configure('json');
    const result = await handler(context({ action: 'call', server: 'remote', tool: 'echo', args: { value: 1 } }), opts);
    expect(result.success).toBe(false);
    expect(log.methods).not.toContain('tools/call');
  });

  it('times out a hanging server', async () => {
    await configure('hang');
    const started = Date.now();
    const result = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('redacts resolved bearer tokens from server errors', async () => {
    await configure('secret-error');
    const result = await handler(context({ action: 'call', server: 'remote', tool: 'echo', args: { value: 'x' } }), opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain('upstream rejected');
    expect(result.error).not.toContain(TOKEN);
  });

  it('fails closed when the auth env var is unset and reports only its name', async () => {
    await configure('json');
    delete process.env.MCP_TEST_TOKEN;
    const result = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP_TEST_TOKEN');
  });

  it('surfaces HTTP auth failures', async () => {
    await configure('json', { bearerToken: 'wrong-token-value' });
    const result = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 401');
    expect(result.error).not.toContain('wrong-token-value');
  });
});

describe('legacy SSE MCP transport', () => {
  it('discovers the POST endpoint, lists tools, and calls a tool', async () => {
    const log = await configure('json', { transport: 'sse' });
    const tools = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(tools.success).toBe(true);
    expect(tools.output).toContain('echo');
    const call = await handler(context({ action: 'call', server: 'remote', tool: 'echo', args: { value: 'legacy' } }), opts);
    expect(call.success).toBe(true);
    expect(call.output).toContain('legacy');
    expect(log.methods).toContain('tools/call');
    expect(log.authHeaders.every(header => header === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('times out when replies never arrive on the stream', async () => {
    await configure('hang', { transport: 'sse' });
    const result = await handler(context({ action: 'tools', server: 'remote' }), opts);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe('SseParser', () => {
  it('handles CRLF split across chunks, comments, multi-line data, and size caps', () => {
    const parser = new SseParser(64);
    expect(parser.feed('event: message\r')).toEqual([]);
    expect(parser.feed('\ndata: a\r\n: comment\r\ndata: b\r\n\r')).toEqual([]);
    expect(parser.feed('\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
    expect(() => new SseParser(8).feed(`data: ${'x'.repeat(20)}\n`)).toThrow(/exceeds/);
  });
});
