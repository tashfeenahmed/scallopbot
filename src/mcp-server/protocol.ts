/**
 * Minimal JSON-RPC 2.0 types and newline-delimited stdio framing for the
 * ScallopBot MCP server.
 *
 * Framing matches the bundled MCP *client* (`src/skills/bundled/mcp/run.ts`):
 * one JSON object per line on stdout, one per line on stdin. The two halves are
 * deliberately symmetric so the client can drive this server in tests and so a
 * single protocol version governs both directions.
 */

/** MCP protocol revision. Must match the bundled client. */
export const PROTOCOL_VERSION = '2024-11-05';

export const SERVER_NAME = 'scallopbot';

/** Standard JSON-RPC 2.0 error codes. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * A single stdin line larger than this is protocol abuse rather than a real
 * request; the reader drops the buffer instead of growing without bound.
 */
export const MAX_INBOUND_LINE_BYTES = 4 * 1024 * 1024;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool result payload. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Build a plain-text tool result. */
export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Serialize one outbound message as a single newline-terminated line. */
export function encodeMessage(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental newline-delimited JSON reader.
 *
 * `push()` returns every complete message contained in the chunk. Malformed
 * lines are surfaced as `null` entries so the caller can answer with a parse
 * error rather than silently dropping a client request.
 */
export class LineDecoder {
  private buffer = '';

  push(chunk: string): Array<JsonRpcMessage | null> {
    this.buffer += chunk;
    const messages: Array<JsonRpcMessage | null> = [];

    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        messages.push(null);
      }
    }

    // A partial line that can never be a legal message is discarded rather than
    // retained; otherwise a client that never sends a newline grows the buffer
    // until the process dies.
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_INBOUND_LINE_BYTES) {
      this.buffer = '';
      messages.push(null);
    }

    return messages;
  }
}
