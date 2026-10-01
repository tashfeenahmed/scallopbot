/**
 * Bounded remote MCP clients for the executable `mcp` skill.
 *
 * - `McpStreamableHttpClient`: MCP Streamable HTTP (spec 2025-03-26+). Every
 *   JSON-RPC message is POSTed to one endpoint; the reply is either a JSON body
 *   or an SSE stream carrying the response. `Mcp-Session-Id` is captured from
 *   the initialize response, echoed on later requests, and released with a
 *   DELETE on close.
 * - `McpLegacySseClient`: the deprecated HTTP+SSE transport (2024-11-05). A GET
 *   stream announces a POST endpoint (`event: endpoint`), and responses arrive
 *   as `message` events on that stream.
 *
 * Remote servers are untrusted: every response is size-capped, every request
 * has a deadline, redirects are refused (so auth headers cannot be forwarded
 * elsewhere), the legacy POST endpoint must stay on the configured origin, and
 * header values never appear in errors (the caller redacts them as well).
 */

import { resolveMcpHeaders, type MCPServerConfig } from '../../../config/mcp-config.js';

export interface RpcResult {
  value: unknown;
  wireBytes: number;
}

export interface McpClient {
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<RpcResult>;
  close(): Promise<void>;
}

export interface McpHttpLimits {
  maxOutboundRequestBytes: number;
  /** Max bytes of one JSON-RPC message (JSON body or one SSE event). */
  maxInboundLineBytes: number;
  /** Max bytes received from the server over the client's lifetime. */
  maxInboundStdoutBytes: number;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const CLIENT_INFO = { name: 'scallopbot', version: '0.1.0' };
const STREAMABLE_PROTOCOL_VERSION = '2025-03-26';
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
const MAX_ERROR_BODY_BYTES = 2_048;
const MAX_SESSION_ID_CHARS = 256;
const CLOSE_TIMEOUT_MS = 2_000;

function rpcError(message: JsonRpcMessage): Error {
  let data = '';
  try {
    data = message.error?.data === undefined ? '' : ` (${JSON.stringify(message.error.data)})`;
  } catch {
    data = ' (unserializable error data)';
  }
  return new Error(`${message.error?.message ?? 'MCP JSON-RPC error'}${data}`);
}

function isResponseFor(message: unknown, id: number): message is JsonRpcMessage {
  return Boolean(message) && typeof message === 'object' && !Array.isArray(message) &&
    (message as JsonRpcMessage).id === id &&
    ((message as JsonRpcMessage).result !== undefined || (message as JsonRpcMessage).error !== undefined);
}

function settle(message: JsonRpcMessage, wireBytes: number): RpcResult {
  if (message.error) throw rpcError(message);
  return { value: message.result, wireBytes };
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental text/event-stream parser with a per-event size cap. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private dataBytes = 0;
  private event = '';

  constructor(private readonly maxEventBytes: number) {}

  feed(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    while (true) {
      const index = this.buffer.search(/\r\n|\r|\n/);
      if (index < 0) break;
      // A trailing CR may be the first half of CRLF split across chunks.
      if (this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const separator = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + separator);
      if (line === '') {
        if (this.data.length > 0) events.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.data = [];
        this.dataBytes = 0;
        this.event = '';
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        this.dataBytes += Buffer.byteLength(value, 'utf8') + 1;
        if (this.dataBytes > this.maxEventBytes) {
          throw new Error(`MCP SSE event exceeds ${this.maxEventBytes} bytes`);
        }
        this.data.push(value);
      } else if (field === 'event') {
        this.event = value.slice(0, 64);
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxEventBytes) {
      throw new Error(`MCP SSE line exceeds ${this.maxEventBytes} bytes`);
    }
    return events;
  }
}

/** Shared lifetime byte budget and decoding for one client. */
class InboundBudget {
  private received = 0;
  constructor(private readonly limit: number) {}

  add(bytes: number): void {
    this.received += bytes;
    if (this.received > this.limit) throw new Error(`MCP server response exceeds ${this.limit} bytes`);
  }
}

async function* readText(
  body: ReadableStream<Uint8Array>,
  budget: InboundBudget,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.add(value.byteLength);
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readBoundedBody(
  response: Response,
  budget: InboundBudget,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return '';
  let text = '';
  for await (const chunk of readText(response.body, budget)) {
    text += chunk;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`MCP response body exceeds ${maxBytes} bytes`);
    }
  }
  return text;
}

async function httpFailure(response: Response, budget: InboundBudget, context: string): Promise<Error> {
  let detail = '';
  try {
    detail = (await readBoundedBody(response, budget, MAX_ERROR_BODY_BYTES)).trim();
  } catch {
    detail = '';
  }
  const suffix = detail ? `: ${detail.slice(0, 500)}` : '';
  return new Error(`${context} failed with HTTP ${response.status}${suffix}`);
}

function serialize(message: Record<string, unknown>, limit: number): string {
  const payload = JSON.stringify(message);
  if (Buffer.byteLength(payload, 'utf8') > limit) {
    throw new Error(`MCP outbound request exceeds ${limit} bytes`);
  }
  return payload;
}

function timeoutController(ms: number, label: string): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`MCP request "${label}" timed out after ${ms}ms`)),
    ms,
  );
  return { controller, clear: () => clearTimeout(timer) };
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.aborted && signal.reason instanceof Error) return signal.reason;
  return fallback instanceof Error ? fallback : new Error(String(fallback));
}

function contentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

function negotiatedVersion(value: unknown, fallback: string): string {
  const version = (value as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  return typeof version === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(version) ? version : fallback;
}

/** MCP Streamable HTTP transport. */
export class McpStreamableHttpClient implements McpClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly budget: InboundBudget;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<AbortController>();
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion?: string;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(server: MCPServerConfig, private readonly limits: McpHttpLimits) {
    if (!server.url) throw new Error('MCP HTTP client requires a url');
    this.endpoint = server.url;
    this.headers = resolveMcpHeaders(server);
    this.budget = new InboundBudget(limits.maxInboundStdoutBytes);
    this.timeoutMs = server.timeoutMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: STREAMABLE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.protocolVersion = negotiatedVersion(result.value, STREAMABLE_PROTOCOL_VERSION);
    await this.notify('notifications/initialized', {});
  }

  async request(method: string, params: Record<string, unknown>): Promise<RpcResult> {
    const id = this.nextId++;
    const payload = serialize({ jsonrpc: '2.0', id, method, params }, this.limits.maxOutboundRequestBytes);
    return this.withDeadline(method, async signal => {
      const response = await this.post(payload, signal);
      if (method === 'initialize') this.captureSession(response);
      if (!response.ok) {
        if (response.status === 404 && this.sessionId) {
          throw new Error('MCP session expired or unknown to the server (HTTP 404)');
        }
        throw await httpFailure(response, this.budget, `MCP "${method}"`);
      }
      const type = contentType(response);
      if (type === 'text/event-stream') return this.readSseResponse(response, id);
      if (type === 'application/json') {
        const body = await readBoundedBody(response, this.budget, this.limits.maxInboundLineBytes);
        const wireBytes = Buffer.byteLength(body, 'utf8');
        const parsed: unknown = JSON.parse(body);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const match = messages.find(message => isResponseFor(message, id));
        if (!match) throw new Error(`MCP "${method}" response did not contain a reply for request ${id}`);
        return settle(match, wireBytes);
      }
      throw new Error(`MCP "${method}" returned unsupported content type "${type.slice(0, 64)}"`);
    });
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = serialize({ jsonrpc: '2.0', method, params }, this.limits.maxOutboundRequestBytes);
    await this.withDeadline(method, async signal => {
      const response = await this.post(payload, signal);
      if (!response.ok) throw await httpFailure(response, this.budget, `MCP "${method}"`);
      await response.body?.cancel().catch(() => undefined);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      for (const controller of this.inFlight) controller.abort(new Error('MCP client closed'));
      this.inFlight.clear();
      if (!this.sessionId) return;
      // Best-effort explicit session release; servers may answer 405.
      const { controller, clear } = timeoutController(Math.min(this.timeoutMs, CLOSE_TIMEOUT_MS), 'session close');
      try {
        const response = await fetch(this.endpoint, {
          method: 'DELETE',
          headers: this.requestHeaders(false),
          redirect: 'error',
          signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // The server may already have expired the session.
      } finally {
        clear();
      }
    })();
    return this.closePromise;
  }

  private async withDeadline<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('MCP client closed');
    const { controller, clear } = timeoutController(this.timeoutMs, label);
    this.inFlight.add(controller);
    try {
      return await operation(controller.signal);
    } catch (error) {
      throw abortReason(controller.signal, error);
    } finally {
      clear();
      this.inFlight.delete(controller);
    }
  }

  private requestHeaders(withBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers };
    if (withBody) {
      headers['Content-Type'] = 'application/json';
      headers.Accept = 'application/json, text/event-stream';
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  private post(payload: string, signal: AbortSignal): Promise<Response> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: this.requestHeaders(true),
      body: payload,
      redirect: 'error',
      signal,
    });
  }

  private captureSession(response: Response): void {
    const session = response.headers.get('mcp-session-id');
    if (session === null) return;
    if (!/^[\x21-\x7E]+$/.test(session) || session.length > MAX_SESSION_ID_CHARS) {
      throw new Error('MCP server returned an invalid Mcp-Session-Id');
    }
    this.sessionId = session;
  }

  private async readSseResponse(response: Response, id: number): Promise<RpcResult> {
    if (!response.body) throw new Error('MCP SSE response has no body');
    const parser = new SseParser(this.limits.maxInboundLineBytes);
    for await (const chunk of readText(response.body, this.budget)) {
      for (const event of parser.feed(chunk)) {
        if (event.event !== 'message') continue;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          continue; // bounded noise
        }
        // Server-initiated requests/notifications (ping, progress) are ignored:
        // this client advertises no capabilities.
        if (isResponseFor(message, id)) return settle(message, Buffer.byteLength(event.data, 'utf8'));
      }
    }
    throw new Error(`MCP SSE stream ended before the reply to request ${id}`);
  }
}

interface PendingRequest {
  resolve: (value: RpcResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Deprecated MCP HTTP+SSE transport (2024-11-05). */
export class McpLegacySseClient implements McpClient {
  private readonly streamUrl: string;
  private readonly headers: Record<string, string>;
  private readonly budget: InboundBudget;
  private readonly timeoutMs: number;
  private readonly streamAbort = new AbortController();
  private readonly pending = new Map<number, PendingRequest>();
  private postEndpoint?: string;
  private nextId = 1;
  private closed = false;
  private failure?: Error;

  constructor(server: MCPServerConfig, private readonly limits: McpHttpLimits) {
    if (!server.url) throw new Error('MCP SSE client requires a url');
    this.streamUrl = server.url;
    this.headers = resolveMcpHeaders(server);
    this.budget = new InboundBudget(limits.maxInboundStdoutBytes);
    this.timeoutMs = server.timeoutMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    await this.openStream();
    await this.request('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.post(serialize(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      this.limits.maxOutboundRequestBytes,
    ), 'notifications/initialized');
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('MCP client closed'));
    const id = this.nextId++;
    let payload: string;
    try {
      payload = serialize({ jsonrpc: '2.0', id, method, params }, this.limits.maxOutboundRequestBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.post(payload, method).catch(error => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error as Error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.streamAbort.abort(new Error('MCP client closed'));
    this.rejectAll(new Error('MCP client closed'));
  }

  private openStream(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`MCP SSE endpoint announcement timed out after ${this.timeoutMs}ms`);
        reject(error);
        this.fail(error);
      }, this.timeoutMs);
      let announced = false;
      const run = async () => {
        const response = await fetch(this.streamUrl, {
          method: 'GET',
          headers: { ...this.headers, Accept: 'text/event-stream' },
          redirect: 'error',
          signal: this.streamAbort.signal,
        });
        if (!response.ok) throw await httpFailure(response, this.budget, 'MCP SSE stream');
        if (contentType(response) !== 'text/event-stream' || !response.body) {
          throw new Error('MCP SSE stream did not return text/event-stream');
        }
        const parser = new SseParser(this.limits.maxInboundLineBytes);
        for await (const chunk of readText(response.body, this.budget)) {
          for (const event of parser.feed(chunk)) {
            if (event.event === 'endpoint' && !announced) {
              this.postEndpoint = this.resolveEndpoint(event.data);
              announced = true;
              clearTimeout(timer);
              resolve();
            } else if (event.event === 'message') {
              this.dispatch(event.data);
            }
          }
        }
        throw new Error('MCP SSE stream closed by server');
      };
      run().catch(error => {
        clearTimeout(timer);
        const failure = abortReason(this.streamAbort.signal, error);
        if (!announced) reject(failure);
        this.fail(failure);
      });
    });
  }

  private resolveEndpoint(data: string): string {
    let endpoint: URL;
    try {
      endpoint = new URL(data.trim(), this.streamUrl);
    } catch {
      throw new Error('MCP SSE server announced an invalid endpoint');
    }
    // Credentials are only ever sent to the configured origin.
    if (endpoint.origin !== new URL(this.streamUrl).origin) {
      throw new Error('MCP SSE server announced a cross-origin endpoint');
    }
    return endpoint.toString();
  }

  private dispatch(data: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending || !isResponseFor(message, message.id)) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(settle(message, Buffer.byteLength(data, 'utf8')));
    } catch (error) {
      pending.reject(error as Error);
    }
  }

  private async post(payload: string, label: string): Promise<void> {
    if (!this.postEndpoint) throw new Error('MCP SSE endpoint not announced');
    const { controller, clear } = timeoutController(this.timeoutMs, label);
    const onClose = () => controller.abort(new Error('MCP client closed'));
    this.streamAbort.signal.addEventListener('abort', onClose, { once: true });
    try {
      const response = await fetch(this.postEndpoint, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw await httpFailure(response, this.budget, `MCP "${label}"`);
      await readBoundedBody(response, this.budget, MAX_ERROR_BODY_BYTES).catch(() => '');
    } catch (error) {
      throw abortReason(controller.signal, error);
    } finally {
      clear();
      this.streamAbort.signal.removeEventListener('abort', onClose);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure ??= error;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
