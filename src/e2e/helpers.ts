/**
 * E2E Test Helpers
 *
 * Reusable infrastructure for end-to-end WebSocket integration tests.
 * Boots a real ApiChannel with real SQLite database, real Agent,
 * real SessionManager — but mock LLM/embedding providers to avoid
 * external API calls.
 */

import * as fs from 'fs';
import pino from 'pino';
import WebSocket from 'ws';
import { ApiChannel } from '../channels/api.js';
import { Agent } from '../agent/agent.js';
import { SessionManager } from '../agent/session.js';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BotConfigManager } from '../channels/bot-config.js';
import { ContextManager } from '../routing/context.js';
import { Router } from '../routing/router.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CostTracker } from '../routing/cost.js';
import { LLMFactExtractor } from '../memory/fact-extractor.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/registry.js';
import { createSkillExecutor, type SkillExecutor } from '../skills/executor.js';
import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from '../providers/types.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';

// ---------------------------------------------------------------------------
// Silent logger for tests
// ---------------------------------------------------------------------------
export const testLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Mock LLM Provider
// ---------------------------------------------------------------------------

export interface MockLLMProviderOptions {
  /** Pre-configured responses to cycle through. Each should end with [DONE]. */
  responses?: string[];
}

/**
 * Create a mock LLM provider that returns canned responses.
 * The provider cycles through the given responses array.
 * Each response is wrapped in a proper CompletionResponse.
 */
export function createMockLLMProvider(
  responses: string[] = ['Hello! I received your message. [DONE]']
): LLMProvider & { callCount: number; lastRequest: CompletionRequest | null } {
  let callIndex = 0;

  const provider: LLMProvider & { callCount: number; lastRequest: CompletionRequest | null } = {
    name: 'mock',
    callCount: 0,
    lastRequest: null,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      provider.callCount++;
      provider.lastRequest = request;

      const responseText = responses[callIndex % responses.length];
      callIndex++;

      return {
        content: [{ type: 'text', text: responseText }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        model: 'mock-model',
      };
    },

    isAvailable(): boolean {
      return true;
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Mock Embedding Provider
// ---------------------------------------------------------------------------

/**
 * Create a mock embedding provider that generates deterministic
 * pseudo-embeddings from content strings. Uses a simple hash-based
 * approach: character codes are used to fill a 384-dim vector,
 * then normalized to a unit vector.
 */
export function createMockEmbeddingProvider(): EmbeddingProvider {
  const DIMENSION = 384;

  function hashEmbed(text: string): number[] {
    const vec = new Array(DIMENSION).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % DIMENSION] += text.charCodeAt(i);
    }
    // Normalize to unit vector
    const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < DIMENSION; i++) {
        vec[i] /= magnitude;
      }
    }
    return vec;
  }

  return {
    name: 'mock-embedder',
    dimension: DIMENSION,

    async embed(text: string): Promise<number[]> {
      return hashEmbed(text);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(hashEmbed);
    },

    isAvailable(): boolean {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// E2E Gateway (wires real components with mock providers)
// ---------------------------------------------------------------------------

export interface E2EGatewayContext {
  /** The API channel (HTTP + WebSocket server) */
  apiChannel: ApiChannel;
  /** The port the server is listening on */
  port: number;
  /** Path to the test SQLite database */
  dbPath: string;
  /** The mock LLM provider for assertions */
  mockProvider: LLMProvider & { callCount: number; lastRequest: CompletionRequest | null };
  /** The real ScallopMemoryStore for direct DB assertions */
  scallopStore: ScallopMemoryStore;
  /** The real SessionManager */
  sessionManager: SessionManager;
  /** The real Agent */
  agent: Agent;
}

export interface CreateE2EGatewayOptions {
  /** Port to listen on (default: random 10000-20000) */
  port?: number;
  /** Path to SQLite database (default: /tmp/e2e-test-<random>.db) */
  dbPath?: string;
  /** Pre-configured LLM responses for the agent's main provider */
  responses?: string[];
  /** Pre-configured LLM responses for the fact extractor provider.
   *  If provided, a LLMFactExtractor is wired into the agent.
   *  Each response should be JSON with a "facts" array. */
  factExtractorResponses?: string[];
}

/**
 * Boot a real API channel with real Agent, SessionManager, ScallopMemoryStore,
 * but mock LLM and embedding providers. This gives us a fully functional
 * E2E environment without external API calls.
 */
export async function createE2EGateway(
  options: CreateE2EGatewayOptions = {}
): Promise<E2EGatewayContext> {
  const port = options.port ?? (10000 + Math.floor(Math.random() * 10000));
  const dbPath = options.dbPath ?? `/tmp/e2e-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

  // 1. Create mock providers
  const mockProvider = createMockLLMProvider(options.responses);
  const mockEmbedder = createMockEmbeddingProvider();

  // 2. Create real ScallopMemoryStore with mock embedder
  const scallopStore = new ScallopMemoryStore({
    dbPath,
    logger: testLogger,
    embedder: mockEmbedder,
  });

  // 3. Create real SessionManager (uses SQLite via ScallopDatabase)
  const sessionManager = new SessionManager(scallopStore.getDatabase());

  // 4. Create ContextManager
  const contextManager = new ContextManager({
    hotWindowSize: 50,
    maxContextTokens: 128000,
    compressionThreshold: 0.7,
    maxToolOutputBytes: 30000,
  });

  // 5. Create Router and register mock provider
  const router = new Router({});
  router.registerProvider(mockProvider);

  // 6. Create CostTracker
  const costTracker = new CostTracker({
    db: scallopStore.getDatabase(),
  });

  // 7. Create BotConfigManager
  const configManager = new BotConfigManager(scallopStore.getDatabase(), testLogger);

  // 8. Optionally create LLMFactExtractor with a separate mock provider
  let factExtractor: LLMFactExtractor | undefined;
  if (options.factExtractorResponses) {
    const factProvider = createMockLLMProvider(options.factExtractorResponses);
    factExtractor = new LLMFactExtractor({
      provider: factProvider,
      scallopStore,
      logger: testLogger,
      embedder: mockEmbedder,
      costTracker,
      deduplicationThreshold: 0.95,
    });
  }

  // 9. Create SkillRegistry (empty workspace, no skills loaded from disk)
  const skillRegistry = createSkillRegistry('/tmp', testLogger);
  await skillRegistry.initialize();

  // 10. Create SkillExecutor
  const skillExecutor = createSkillExecutor(testLogger);

  // 11. Create real Agent
  const agent = new Agent({
    provider: mockProvider,
    sessionManager,
    skillRegistry,
    skillExecutor,
    router,
    costTracker,
    scallopStore,
    factExtractor,
    contextManager,
    configManager,
    workspace: '/tmp',
    logger: testLogger,
    maxIterations: 10,
    enableThinking: false,
  });

  // 12. Create and start ApiChannel
  const apiChannel = new ApiChannel({
    port,
    host: '127.0.0.1',
    agent,
    sessionManager,
    logger: testLogger,
    costTracker,
  });

  await apiChannel.start();

  return {
    apiChannel,
    port,
    dbPath,
    mockProvider,
    scallopStore,
    sessionManager,
    agent,
  };
}

// ---------------------------------------------------------------------------
// WebSocket Client Wrapper
// ---------------------------------------------------------------------------

export interface WsResponse {
  type: string;
  sessionId?: string;
  content?: string;
  error?: string;
  message?: string;
  count?: number;
  action?: string;
  items?: unknown[];
  skill?: string;
  input?: string;
  output?: string;
  path?: string;
  caption?: string;
  [key: string]: unknown;
}

export interface WsClient {
  /** The underlying WebSocket instance */
  ws: WebSocket;
  /** Send a JSON message */
  send(msg: Record<string, unknown>): void;
  /** Wait for a single response matching an optional type filter */
  waitForResponse(type?: string, timeout?: number): Promise<WsResponse>;
  /** Collect all messages until timeout or a 'response' message is received */
  collectUntilResponse(timeout?: number): Promise<WsResponse[]>;
  /** Collect all messages for a duration */
  collectAll(timeout?: number): Promise<WsResponse[]>;
  /** Close the connection */
  close(): Promise<void>;
}

/**
 * Create a promise-based WebSocket client connected to the E2E gateway.
 * Resolves once the connection is open.
 */
export function createWsClient(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const onError = (err: Error) => {
      reject(err);
    };

    ws.on('error', onError);

    ws.on('open', () => {
      ws.removeListener('error', onError);

      const client: WsClient = {
        ws,

        send(msg: Record<string, unknown>): void {
          ws.send(JSON.stringify(msg));
        },

        waitForResponse(type?: string, timeout = 15000): Promise<WsResponse> {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              ws.removeListener('message', onMessage);
              rej(new Error(`Timeout waiting for WS response${type ? ` of type "${type}"` : ''}`));
            }, timeout);

            function onMessage(data: WebSocket.Data) {
              try {
                const msg: WsResponse = JSON.parse(data.toString());
                if (!type || msg.type === type) {
                  clearTimeout(timer);
                  ws.removeListener('message', onMessage);
                  res(msg);
                }
              } catch {
                // Ignore parse errors
              }
            }

            ws.on('message', onMessage);
          });
        },

        collectUntilResponse(timeout = 15000): Promise<WsResponse[]> {
          return new Promise((res, rej) => {
            const messages: WsResponse[] = [];

            const timer = setTimeout(() => {
              ws.removeListener('message', onMessage);
              // Return what we have on timeout
              res(messages);
            }, timeout);

            function onMessage(data: WebSocket.Data) {
              try {
                const msg: WsResponse = JSON.parse(data.toString());
                messages.push(msg);
                // If we got a 'response' type, that's the final answer
                if (msg.type === 'response') {
                  clearTimeout(timer);
                  ws.removeListener('message', onMessage);
                  res(messages);
                }
              } catch {
                // Ignore parse errors
              }
            }

            ws.on('message', onMessage);
          });
        },

        collectAll(timeout = 3000): Promise<WsResponse[]> {
          return new Promise((res) => {
            const messages: WsResponse[] = [];

            const timer = setTimeout(() => {
              ws.removeListener('message', onMessage);
              res(messages);
            }, timeout);

            function onMessage(data: WebSocket.Data) {
              try {
                const msg: WsResponse = JSON.parse(data.toString());
                messages.push(msg);
              } catch {
                // Ignore parse errors
              }
            }

            ws.on('message', onMessage);
          });
        },

        close(): Promise<void> {
          return new Promise((res) => {
            if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
              res();
              return;
            }
            ws.on('close', () => res());
            ws.close();
          });
        },
      };

      resolve(client);
    });
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Stop the E2E gateway and clean up test database files.
 */
export async function cleanupE2E(ctx: E2EGatewayContext): Promise<void> {
  // Stop API channel
  await ctx.apiChannel.stop();

  // Close ScallopMemoryStore (closes SQLite)
  ctx.scallopStore.close();

  // Delete test database files
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(ctx.dbPath + suffix);
    } catch {
      // Ignore if files don't exist
    }
  }
}
