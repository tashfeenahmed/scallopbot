/**
 * MCP server dispatch: turns JSON-RPC messages into memory operations.
 *
 * The dispatcher is transport-agnostic and pure with respect to I/O, so tests
 * can drive it directly as well as over a real stdio pipe.
 */

import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import {
  PROTOCOL_VERSION,
  RPC_ERRORS,
  SERVER_NAME,
  rpcError,
  rpcResult,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol.js';
import { TOOL_DEFINITIONS, ToolInputError, createToolHandlers, type ToolHandler } from './tools.js';

export interface McpServerOptions {
  store: ScallopMemoryStore;
  /** Memory owner. Matches the bot's own default user. */
  userId?: string;
  /** Set when an embedding provider is configured; surfaced in recall output. */
  hasEmbedder?: boolean;
  version?: string;
}

export class McpServer {
  private readonly handlers: Record<string, ToolHandler>;
  private readonly version: string;

  constructor(options: McpServerOptions) {
    this.version = options.version ?? '0.1.0';
    this.handlers = createToolHandlers({
      store: options.store,
      userId: options.userId ?? 'default',
      hasEmbedder: options.hasEmbedder ?? false,
    });
  }

  /**
   * Handle one inbound message.
   *
   * Returns the response to write back, or `null` for notifications (which must
   * never be answered) and for responses the client sends us.
   */
  async handle(message: JsonRpcMessage | null): Promise<JsonRpcResponse | null> {
    if (message === null) {
      return rpcError(null, RPC_ERRORS.parseError, 'Parse error: malformed JSON line');
    }

    const { method } = message;
    // A message without a method is a response to something we sent. We never
    // send requests, so there is nothing to correlate and nothing to answer.
    if (typeof method !== 'string') return null;

    // `notifications/initialized` and friends carry no id and are acknowledged
    // by silence.
    if (message.id === undefined || message.id === null) return null;

    const id: string | number = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: this.version },
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOL_DEFINITIONS });

      case 'tools/call':
        return this.callTool(id, params);

      default:
        return rpcError(id, RPC_ERRORS.methodNotFound, `Unknown method: ${method}`);
    }
  }

  private async callTool(
    id: string | number,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const name = params.name;
    if (typeof name !== 'string') {
      return rpcError(id, RPC_ERRORS.invalidParams, 'tools/call requires a "name" string');
    }

    const handler = this.handlers[name];
    if (!handler) {
      return rpcError(id, RPC_ERRORS.methodNotFound, `Unknown tool: ${name}`);
    }

    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return rpcError(id, RPC_ERRORS.invalidParams, '"arguments" must be an object');
    }

    try {
      return rpcResult(id, await handler(args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ToolInputError) {
        return rpcError(id, RPC_ERRORS.invalidParams, message);
      }
      // Execution failures are reported as a tool result with isError, not as a
      // protocol error: the model should see them and can retry or adapt.
      return rpcResult(id, {
        content: [{ type: 'text', text: `${name} failed: ${message}` }],
        isError: true,
      });
    }
  }
}
