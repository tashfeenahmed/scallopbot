/**
 * REST/WebSocket API Channel
 *
 * Provides HTTP API and WebSocket endpoints for programmatic access:
 *
 * REST Endpoints:
 * - POST /api/chat - Send a message and get a response
 * - POST /api/chat/stream - Send a message and stream response (SSE)
 * - GET /api/sessions - List sessions
 * - GET /api/sessions/:id - Get session details
 * - DELETE /api/sessions/:id - Delete a session
 * - GET /api/files?path= - Download a workspace file
 * - GET /api/health - Health check
 *
 * WebSocket:
 * - ws://host:port/ws - Real-time bidirectional communication
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { timingSafeEqual } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as path from 'path';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Channel, Attachment } from './types.js';
import type { TriggerSource } from '../triggers/types.js';
import type { CostTracker } from '../routing/cost.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { ScallopDatabase } from '../memory/db.js';
import { AuthService } from './auth.js';
import { nanoid } from 'nanoid';
import type { InterruptQueue } from '../agent/interrupt-queue.js';
import type { BotConfigManager } from './bot-config.js';
import type { ProviderRegistry } from '../providers/registry.js';

/** Maximum request body size (1MB) */
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * API Channel configuration
 */
export interface ApiChannelConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Allowed CORS origins (default: none - same origin only) */
  allowedOrigins?: string[];
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodySize?: number;
  /** Directory to serve static files from (optional) */
  staticDir?: string;
  /** Agent instance */
  agent: Agent;
  /** Session manager */
  sessionManager: SessionManager;
  /** Logger */
  logger: Logger;
  /** Cost tracker for usage/credits API (optional) */
  costTracker?: CostTracker;
  /** Memory store for graph visualization API (optional) */
  memoryStore?: ScallopMemoryStore;
  /** Database for web UI auth (optional — enables password login) */
  db?: ScallopDatabase;
  /** Interrupt queue for mid-loop user message injection */
  interruptQueue?: InterruptQueue;
  /** Callback when a WebSocket user sends a message (for engagement tracking) */
  onUserMessage?: (prefixedUserId: string) => void;
  /** Bot config manager for /settings and /model commands (optional) */
  configManager?: BotConfigManager;
  /** Provider registry for /model command (optional) */
  providerRegistry?: ProviderRegistry;
}

/** Content-Type mapping for static files */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.py': 'text/x-python',
  '.ts': 'text/typescript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

/**
 * Chat request body
 */
interface ChatRequest {
  message: string;
  sessionId?: string;
}

/**
 * Chat response
 */
interface ChatResponse {
  response: string;
  sessionId: string;
}

/**
 * WebSocket attachment format
 */
interface WsAttachment {
  type: 'image' | 'file';
  /** Base64 encoded data */
  data: string;
  /** MIME type (e.g., 'image/jpeg') */
  mimeType: string;
  /** Optional filename */
  filename?: string;
}

/**
 * WebSocket message types
 */
interface WsMessage {
  type: 'chat' | 'ping' | 'stop';
  sessionId?: string;
  message?: string;
  /** Optional image/file attachments */
  attachments?: WsAttachment[];
}

interface WsResponse {
  type: 'response' | 'chunk' | 'error' | 'pong' | 'trigger' | 'file' | 'skill_start' | 'skill_complete' | 'skill_error' | 'thinking' | 'planning' | 'debug' | 'memory' | 'proactive';
  sessionId?: string;
  content?: string;
  error?: string;
  /** For 'file' type: path to the file */
  path?: string;
  /** For 'file' type: optional caption */
  caption?: string;
  /** For skill messages */
  skill?: string;
  input?: string;
  output?: string;
  message?: string;
  /** For memory messages */
  count?: number;
  action?: string;
  items?: { type: string; content: string; subject?: string }[];
  /** For 'proactive' type: gap category */
  category?: string;
  /** For 'proactive' type: urgency level */
  urgency?: string;
  /** For 'proactive' type: originating source */
  source?: string;
}

/**
 * API Channel - implements both Channel and TriggerSource interfaces.
 * TriggerSource allows sending proactive messages to connected WebSocket clients.
 */
export class ApiChannel implements Channel, TriggerSource {
  name = 'api';

  private config: Required<Omit<ApiChannelConfig, 'apiKey' | 'allowedOrigins' | 'staticDir' | 'costTracker' | 'memoryStore' | 'db' | 'interruptQueue' | 'onUserMessage' | 'configManager' | 'providerRegistry'>> & {
    apiKey?: string;
    allowedOrigins: string[];
    staticDir?: string;
    costTracker?: CostTracker;
    memoryStore?: ScallopMemoryStore;
  };
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private logger: Logger;
  private running = false;
  private userSessions: Map<string, string> = new Map();
  /** Track WebSocket clients by userId for trigger support */
  private clientsByUser: Map<string, Set<WebSocket>> = new Map();
  /** Track stop requests by clientId */
  private stopRequests: Set<string> = new Set();
  /** Track clients with in-flight agent calls */
  private activeProcessing: Set<string> = new Set();
  private interruptQueue: InterruptQueue | null = null;
  private authService: AuthService | null = null;
  private onUserMessage?: (prefixedUserId: string) => void;
  private configManager: BotConfigManager | null = null;
  private providerRegistry: ProviderRegistry | null = null;
  private db: ScallopDatabase | null = null;
  /** Per-client verbose mode toggle */
  private verboseClients: Set<string> = new Set();

  constructor(config: ApiChannelConfig) {
    this.config = {
      port: config.port,
      host: config.host || '127.0.0.1',
      apiKey: config.apiKey,
      allowedOrigins: config.allowedOrigins || [],
      maxBodySize: config.maxBodySize || MAX_BODY_SIZE,
      staticDir: config.staticDir,
      costTracker: config.costTracker,
      memoryStore: config.memoryStore,
      agent: config.agent,
      sessionManager: config.sessionManager,
      logger: config.logger,
    };
    this.logger = config.logger.child({ channel: 'api' });
    this.interruptQueue = config.interruptQueue || null;
    this.onUserMessage = config.onUserMessage;
    if (config.db) {
      this.authService = new AuthService(config.db);
    }
    this.configManager = config.configManager || null;
    this.providerRegistry = config.providerRegistry || null;
    this.db = config.db || null;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    // Create HTTP server
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.handleWebSocket(ws, req));

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.logger.info(
          { port: this.config.port, host: this.config.host },
          'API channel started'
        );
        resolve();
      });
      this.server!.on('error', reject);
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Clear client tracking before closing connections
    this.clientsByUser.clear();

    // Close WebSocket connections
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.running = false;
    this.logger.info('API channel stopped');
  }

  /**
   * Check if channel is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get channel status
   */
  getStatus(): { connected: boolean; authenticated: boolean; error?: string; lastActivity?: Date } {
    return {
      connected: this.running,
      authenticated: true,
    };
  }

  /**
   * Get or create session for a user
   */
  async getOrCreateSession(userId: string): Promise<string> {
    // Check cache
    const cached = this.userSessions.get(userId);
    if (cached) {
      // Verify session still exists
      const session = await this.config.sessionManager.getSession(cached);
      if (session) {
        return cached;
      }
    }

    // DB fallback: find existing session after server restart
    const prefixedUserId = `api:${userId}`;
    if (this.db) {
      const existing = this.db.findSessionByUserId(prefixedUserId);
      if (existing) {
        // Re-hydrate into session manager so it picks up messages
        const session = await this.config.sessionManager.getSession(existing.id);
        if (session) {
          this.userSessions.set(userId, existing.id);
          return existing.id;
        }
      }
    }

    // Create new session — prefix userId with channel for trigger routing
    const session = await this.config.sessionManager.createSession({
      userId: prefixedUserId,
      channelId: 'api',
    });

    this.userSessions.set(userId, session.id);
    return session.id;
  }

  /**
   * Handle session reset for a user
   */
  async handleReset(userId: string): Promise<void> {
    const sessionId = this.userSessions.get(userId);
    if (sessionId) {
      await this.config.sessionManager.deleteSession(sessionId);
      this.userSessions.delete(userId);
    }
    this.logger.debug({ userId }, 'Session reset');
  }

  /**
   * Handle HTTP requests
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const urlPath = url.pathname;
    const method = req.method?.toUpperCase();

    // CORS headers - only allow configured origins
    const origin = req.headers.origin;
    if (origin && this.isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // If no origin header or not allowed, don't set CORS headers (browser will block cross-origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    // Handle preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth endpoints — always open (no auth required)
    if (urlPath.startsWith('/api/auth/')) {
      await this.handleAuthRoute(req, res, urlPath, method);
      return;
    }

    // Auth gate
    const authenticated = this.checkAuthentication(req);

    // Serve static files — always serve index.html so the SPA can show login
    if (this.config.staticDir && !urlPath.startsWith('/api/') && urlPath !== '/ws') {
      const served = await this.serveStaticFile(urlPath, res);
      if (served) {
        return;
      }
    }

    // Block unauthenticated API requests
    if (!authenticated) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      // Route requests
      if (urlPath === '/api/costs' && method === 'GET') {
        this.handleCosts(res);
      } else if (urlPath === '/api/health' && method === 'GET') {
        this.sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      } else if (urlPath === '/api/chat' && method === 'POST') {
        await this.handleChat(req, res);
      } else if (urlPath === '/api/chat/stream' && method === 'POST') {
        await this.handleChatStream(req, res);
      } else if (urlPath === '/api/sessions' && method === 'GET') {
        await this.handleListSessions(res);
      } else if (urlPath === '/api/sessions/current' && method === 'GET') {
        this.handleGetCurrentSession(res);
      } else if (urlPath === '/api/messages' && method === 'GET') {
        this.handleGetAllMessages(res, url);
      } else if (urlPath.match(/^\/api\/sessions\/[^/]+\/messages$/) && method === 'GET') {
        const sessionId = urlPath.split('/')[3];
        this.handleGetSessionMessages(res, sessionId, url);
      } else if (urlPath.startsWith('/api/sessions/') && method === 'GET') {
        const sessionId = urlPath.slice('/api/sessions/'.length);
        await this.handleGetSession(res, sessionId);
      } else if (urlPath.startsWith('/api/sessions/') && method === 'DELETE') {
        const sessionId = urlPath.slice('/api/sessions/'.length);
        await this.handleDeleteSession(res, sessionId);
      } else if (urlPath === '/api/files' && method === 'GET') {
        await this.handleFileDownload(res, url);
      } else if (urlPath === '/api/memories/graph' && method === 'GET') {
        this.handleMemoryGraph(res);
      } else {
        this.sendJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message, path: urlPath }, 'Request error');
      this.sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * Check if a request is authenticated.
   * Returns true if:
   * - No auth is configured (no db and no apiKey) — backward compat
   * - authService exists but setup is not complete — allow pre-setup access
   * - Valid session cookie
   * - Valid API key
   */
  private checkAuthentication(req: IncomingMessage): boolean {
    const hasApiKey = !!this.config.apiKey;
    const hasAuth = !!this.authService;

    // No auth configured — allow all (backward compat)
    if (!hasApiKey && !hasAuth) return true;

    // Setup not yet complete — only allow auth endpoints and static files (handled elsewhere)
    // Do NOT allow API access before setup to prevent unauthorized use
    if (hasAuth && !this.authService!.isSetupComplete()) return false;

    // Check session cookie
    if (hasAuth && this.authService!.validateRequest(req)) return true;

    // Check API key
    if (hasApiKey && this.authenticateRequest(req)) return true;

    // Same-origin exemption for specific GET endpoints (file downloads, costs, graph)
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const urlPath = url.pathname;
    const method = req.method?.toUpperCase();
    const sameOriginExempt = (urlPath === '/api/files' || urlPath === '/api/costs' || urlPath === '/api/memories/graph') && method === 'GET';
    if (sameOriginExempt && this.isSameOriginRequest(req)) return true;

    return false;
  }

  /**
   * Route auth API endpoints
   */
  private async handleAuthRoute(req: IncomingMessage, res: ServerResponse, urlPath: string, method: string | undefined): Promise<void> {
    if (!this.authService) {
      this.sendJson(res, 404, { error: 'Auth not configured' });
      return;
    }

    try {
      if (urlPath === '/api/auth/status' && method === 'GET') {
        await this.authService.handleStatusAuthenticated(req, res);
      } else if (urlPath === '/api/auth/setup' && method === 'POST') {
        const body = await this.parseBody<{ email?: string; password?: string }>(req);
        await this.authService.handleSetup(req, res, body);
      } else if (urlPath === '/api/auth/login' && method === 'POST') {
        const body = await this.parseBody<{ email?: string; password?: string }>(req);
        await this.authService.handleLogin(req, res, body);
      } else if (urlPath === '/api/auth/logout' && method === 'POST') {
        await this.authService.handleLogout(req, res);
      } else {
        this.sendJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message, path: urlPath }, 'Auth request error');
      this.sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * Serve a static file from the configured static directory
   * Returns true if file was served, false if not found
   */
  private async serveStaticFile(urlPath: string, res: ServerResponse): Promise<boolean> {
    if (!this.config.staticDir) {
      return false;
    }

    // Determine file path
    let filePath = path.join(this.config.staticDir, urlPath === '/' ? 'index.html' : urlPath);

    // Security: Prevent directory traversal
    const resolvedPath = path.resolve(filePath);
    const resolvedStaticDir = path.resolve(this.config.staticDir);
    if (!resolvedPath.startsWith(resolvedStaticDir)) {
      this.logger.warn({ urlPath, resolvedPath }, 'Directory traversal attempt blocked');
      return false;
    }

    try {
      // Try the exact path first
      let stats = await stat(resolvedPath).catch(() => null);

      // If not found and no extension, try with .html
      if (!stats && !path.extname(urlPath)) {
        const htmlPath = resolvedPath + '.html';
        stats = await stat(htmlPath).catch(() => null);
        if (stats) {
          filePath = htmlPath;
        }
      }

      if (!stats || !stats.isFile()) {
        // SPA fallback: serve index.html for non-file paths
        if (!path.extname(urlPath)) {
          const indexPath = path.join(this.config.staticDir!, 'index.html');
          const indexStats = await stat(indexPath).catch(() => null);
          if (indexStats?.isFile()) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            createReadStream(indexPath).pipe(res);
            return true;
          }
        }
        return false;
      }

      // Determine content type
      const ext = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

      // Serve the file
      res.writeHead(200, { 'Content-Type': contentType });
      createReadStream(filePath).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if origin is allowed for CORS
   */
  private isOriginAllowed(origin: string): boolean {
    // If no origins configured, reject all cross-origin requests
    if (this.config.allowedOrigins.length === 0) {
      return false;
    }
    // Check if origin matches any allowed pattern
    return this.config.allowedOrigins.some((allowed) => {
      if (allowed === '*') {
        // Explicitly allowing all origins (user must opt-in)
        return true;
      }
      // Exact match
      return origin === allowed;
    });
  }

  /**
   * Authenticate request using constant-time comparison
   */
  private authenticateRequest(req: IncomingMessage): boolean {
    const apiKey =
      req.headers['x-api-key'] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!apiKey || !this.config.apiKey) {
      return false;
    }

    // Use constant-time comparison to prevent timing attacks
    try {
      const apiKeyBuffer = Buffer.from(String(apiKey), 'utf-8');
      const expectedBuffer = Buffer.from(this.config.apiKey, 'utf-8');

      // If lengths differ, we still need to compare to prevent timing leaks
      // Create a buffer of the expected length for comparison
      if (apiKeyBuffer.length !== expectedBuffer.length) {
        // Compare against expected to maintain constant time, but always return false
        timingSafeEqual(expectedBuffer, expectedBuffer);
        return false;
      }

      return timingSafeEqual(apiKeyBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Authenticate WebSocket connection using constant-time comparison
   */
  private authenticateWebSocket(apiKey: string | string[] | undefined): boolean {
    if (!apiKey || !this.config.apiKey) {
      return false;
    }

    const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;

    try {
      const apiKeyBuffer = Buffer.from(String(keyToCheck), 'utf-8');
      const expectedBuffer = Buffer.from(this.config.apiKey, 'utf-8');

      if (apiKeyBuffer.length !== expectedBuffer.length) {
        timingSafeEqual(expectedBuffer, expectedBuffer);
        return false;
      }

      return timingSafeEqual(apiKeyBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Handle POST /api/chat
   */
  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody<ChatRequest>(req);

    if (!body.message) {
      this.sendJson(res, 400, { error: 'Message is required' });
      return;
    }

    const sessionId = body.sessionId || `api-${nanoid(8)}`;

    this.logger.debug({ sessionId, messageLength: body.message.length }, 'Chat request');

    try {
      // Auto-create session if it doesn't exist
      const existing = await this.config.sessionManager.getSession(sessionId);
      if (!existing) {
        await this.config.sessionManager.createSession({
          userId: 'default',
          channelId: 'api',
          id: sessionId,
        });
      }

      const result = await this.config.agent.processMessage(sessionId, body.message);

      const chatResponse: ChatResponse = {
        response: result.response,
        sessionId,
      };

      this.sendJson(res, 200, chatResponse);
    } catch (error) {
      const err = error as Error;
      this.logger.error({ sessionId, error: err.message }, 'Chat error');
      this.sendJson(res, 500, { error: 'Failed to process message' });
    }
  }

  /**
   * Handle POST /api/chat/stream (Server-Sent Events)
   */
  private async handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody<ChatRequest>(req);

    if (!body.message) {
      this.sendJson(res, 400, { error: 'Message is required' });
      return;
    }

    const sessionId = body.sessionId || `api-${nanoid(8)}`;

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.logger.debug({ sessionId, messageLength: body.message.length }, 'Stream chat request');

    try {
      // Auto-create session if it doesn't exist
      const existing = await this.config.sessionManager.getSession(sessionId);
      if (!existing) {
        await this.config.sessionManager.createSession({
          userId: 'default',
          channelId: 'api',
          id: sessionId,
        });
      }

      // Note: For now, we send the full response as a single event
      // In the future, this could be modified to stream tokens
      const result = await this.config.agent.processMessage(sessionId, body.message);

      // Send response event
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify({ sessionId, content: result.response })}\n\n`);

      // Send done event
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

      res.end();
    } catch (error) {
      const err = error as Error;
      this.logger.error({ sessionId, error: err.message }, 'Stream chat error');

      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'Failed to process message' })}\n\n`);
      res.end();
    }
  }

  /**
   * Handle GET /api/sessions
   */
  private async handleListSessions(res: ServerResponse): Promise<void> {
    // SessionManager doesn't have a list method, so we return an empty array for now
    // This could be enhanced to scan the sessions directory
    this.sendJson(res, 200, { sessions: [] });
  }

  /**
   * Handle GET /api/sessions/:id
   */
  private async handleGetSession(res: ServerResponse, sessionId: string): Promise<void> {
    const session = await this.config.sessionManager.getSession(sessionId);

    if (!session) {
      this.sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    this.sendJson(res, 200, {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    });
  }

  /**
   * Handle DELETE /api/sessions/:id
   */
  private async handleDeleteSession(res: ServerResponse, sessionId: string): Promise<void> {
    // SessionManager doesn't have a delete method, but we can clear it
    // This could be enhanced to actually delete the session file
    this.sendJson(res, 200, { deleted: true, sessionId });
  }

  /**
   * Handle GET /api/sessions/current — returns the current session for web UI user
   */
  private handleGetCurrentSession(res: ServerResponse): void {
    if (!this.db) {
      this.sendJson(res, 503, { error: 'Database not available' });
      return;
    }
    const session = this.db.findSessionByUserId('api:default');
    if (!session) {
      this.sendJson(res, 404, { error: 'No session found' });
      return;
    }
    this.sendJson(res, 200, { id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt });
  }

  /**
   * Handle GET /api/messages?limit=50&before=123 — unified cross-channel history
   */
  private handleGetAllMessages(res: ServerResponse, url: URL): void {
    if (!this.db) {
      this.sendJson(res, 503, { error: 'Database not available' });
      return;
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam ? parseInt(beforeParam, 10) : undefined;
    const { messages, hasMore } = this.db.getAllMessagesPaginated(limit, before);
    this.sendJson(res, 200, { messages, hasMore });
  }

  /**
   * Handle GET /api/sessions/:id/messages?limit=50&before=123
   */
  private handleGetSessionMessages(res: ServerResponse, sessionId: string, url: URL): void {
    if (!this.db) {
      this.sendJson(res, 503, { error: 'Database not available' });
      return;
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam ? parseInt(beforeParam, 10) : undefined;
    const { messages, hasMore } = this.db.getSessionMessagesPaginated(sessionId, limit, before);
    this.sendJson(res, 200, { messages, hasMore });
  }

  /**
   * Handle GET /api/files?path=<filePath>
   * Serves files from the agent workspace for download.
   */
  private async handleFileDownload(res: ServerResponse, url: URL): Promise<void> {
    const filePath = url.searchParams.get('path');

    if (!filePath) {
      this.sendJson(res, 400, { error: 'Missing required query parameter: path' });
      return;
    }

    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Security: ensure file is within the workspace
    const workspace = process.env.AGENT_WORKSPACE || process.cwd();
    const resolvedWorkspace = path.resolve(workspace);
    if (!absolutePath.startsWith(resolvedWorkspace + path.sep) && absolutePath !== resolvedWorkspace) {
      this.logger.warn({ filePath, absolutePath, workspace: resolvedWorkspace }, 'File download path traversal blocked');
      this.sendJson(res, 403, { error: 'Access denied: file is outside workspace' });
      return;
    }

    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) {
        this.sendJson(res, 400, { error: 'Path is not a file' });
        return;
      }

      // 50MB limit (matches Telegram bot limit)
      if (stats.size > 50 * 1024 * 1024) {
        this.sendJson(res, 413, { error: 'File too large (max 50MB)' });
        return;
      }

      const fileName = path.basename(absolutePath);
      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': stats.size,
      });

      createReadStream(absolutePath).pipe(res);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sendJson(res, 404, { error: 'File not found' });
      } else {
        this.logger.error({ filePath, error: (error as Error).message }, 'File download error');
        this.sendJson(res, 500, { error: 'Failed to serve file' });
      }
    }
  }

  /**
   * Handle GET /api/memories/graph
   */
  private handleMemoryGraph(res: ServerResponse): void {
    if (!this.config.memoryStore) {
      this.sendJson(res, 503, { error: 'Memory store not available' });
      return;
    }
    try {
      const data = this.config.memoryStore.getGraphData('default');
      this.sendJson(res, 200, data);
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Memory graph error');
      this.sendJson(res, 500, { error: 'Failed to get memory graph data' });
    }
  }

  /**
   * Handle GET /api/costs
   */
  private handleCosts(res: ServerResponse): void {
    const tracker = this.config.costTracker;
    if (!tracker) {
      this.sendJson(res, 200, { enabled: false });
      return;
    }

    const budget = tracker.getBudgetStatus();
    const history = tracker.getUsageHistory();

    // Aggregate costs by model
    const modelCosts = new Map<string, number>();
    for (const record of history) {
      modelCosts.set(record.model, (modelCosts.get(record.model) || 0) + record.cost);
    }
    const totalCost = Array.from(modelCosts.values()).reduce((a, b) => a + b, 0);
    const topModels = Array.from(modelCosts.entries())
      .map(([model, cost]) => ({
        model,
        cost,
        percentage: totalCost > 0 ? Math.round((cost / totalCost) * 100) : 0,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5);

    // Aggregate daily history (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dailyMap = new Map<string, { cost: number; requests: number }>();
    for (const record of history) {
      if (record.timestamp < thirtyDaysAgo) continue;
      const dateKey = record.timestamp.toISOString().slice(0, 10);
      const entry = dailyMap.get(dateKey) || { cost: 0, requests: 0 };
      entry.cost += record.cost;
      entry.requests += 1;
      dailyMap.set(dateKey, entry);
    }
    const dailyHistory = Array.from(dailyMap.entries())
      .map(([date, { cost, requests }]) => ({ date, cost: Math.round(cost * 10000) / 10000, requests }))
      .sort((a, b) => a.date.localeCompare(b.date));

    this.sendJson(res, 200, {
      enabled: true,
      daily: {
        spent: budget.dailySpend,
        budget: budget.dailyBudget,
        remaining: budget.dailyRemaining,
        exceeded: budget.isDailyExceeded,
        warning: budget.isDailyWarning,
      },
      monthly: {
        spent: budget.monthlySpend,
        budget: budget.monthlyBudget,
        remaining: budget.monthlyRemaining,
        exceeded: budget.isMonthlyExceeded,
        warning: budget.isMonthlyWarning,
      },
      topModels,
      totalRequests: history.length,
      dailyHistory,
    });
  }

  /**
   * Check if request is from same origin (served by this server)
   */
  private isSameOriginRequest(req: IncomingMessage): boolean {
    const referer = req.headers.referer;
    if (!referer) return false;
    try {
      const refererUrl = new URL(referer);
      const host = req.headers.host || '';
      return refererUrl.host === host;
    } catch {
      return false;
    }
  }

  /**
   * Handle WebSocket connections
   */
  private handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
    const clientId = nanoid(8);
    // All web UI connections share a single stable userId for session continuity
    const userId = 'default';
    this.logger.debug({ clientId, userId }, 'WebSocket client connected');

    // Check authentication: API key, session cookie, or pre-setup bypass
    {
      let wsAuthed = false;

      // API key auth
      if (this.config.apiKey) {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const apiKey = url.searchParams.get('apiKey') || req.headers['x-api-key'];
        if (this.authenticateWebSocket(apiKey)) wsAuthed = true;
      }

      // Session cookie auth (browser sends cookies on same-origin WS upgrade)
      if (!wsAuthed && this.authService && this.authService.validateRequest(req)) {
        wsAuthed = true;
      }

      // Pre-setup: block WS until password is set up (only auth endpoints should work)
      // if (!wsAuthed && this.authService && !this.authService.isSetupComplete()) { wsAuthed = true; }

      // No auth configured at all — allow
      if (!wsAuthed && !this.config.apiKey && !this.authService) {
        wsAuthed = true;
      }

      if (!wsAuthed) {
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    // Track this client by prefixed userId for trigger support
    const prefixedUserId = `api:${userId}`;
    this.addClientToUser(prefixedUserId, ws);

    ws.on('message', async (data) => {
      try {
        const message: WsMessage = JSON.parse(data.toString());
        await this.handleWsMessage(ws, clientId, message);
      } catch (error) {
        const err = error as Error;
        this.logger.error({ clientId, error: err.message }, 'WebSocket message error');
        this.sendWsMessage(ws, { type: 'error', error: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      this.removeClientFromUser(prefixedUserId, ws);
      this.logger.debug({ clientId, userId }, 'WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      this.logger.error({ clientId, error: error.message }, 'WebSocket error');
    });
  }

  /**
   * Add a WebSocket client to the user's client set
   */
  private addClientToUser(userId: string, ws: WebSocket): void {
    let clients = this.clientsByUser.get(userId);
    if (!clients) {
      clients = new Set();
      this.clientsByUser.set(userId, clients);
    }
    clients.add(ws);
    this.logger.debug({ userId, clientCount: clients.size }, 'Client added to user');
  }

  /**
   * Remove a WebSocket client from the user's client set
   */
  private removeClientFromUser(userId: string, ws: WebSocket): void {
    const clients = this.clientsByUser.get(userId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.clientsByUser.delete(userId);
      }
      this.logger.debug({ userId, clientCount: clients.size }, 'Client removed from user');
    }
  }

  /** Provider display names (matches Telegram) */
  private static PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic (Claude)',
    openai: 'OpenAI (GPT)',
    groq: 'Groq',
    moonshot: 'Moonshot (Kimi)',
    xai: 'xAI (Grok)',
    ollama: 'Ollama (local)',
    openrouter: 'OpenRouter',
  };

  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + 'M';
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + 'K';
    return tokens.toString();
  }

  /**
   * Handle built-in slash commands from WebSocket clients.
   * Returns true if the command was handled (caller should not forward to agent).
   */
  private async handleSlashCommand(ws: WebSocket, clientId: string, text: string): Promise<boolean> {
    // Only match exact /command or /command <args> (no space before slash)
    const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (!match) return false;

    const cmd = match[1].toLowerCase();
    const args = match[2]?.trim() || '';

    switch (cmd) {
      case 'new': {
        const userId = 'default';
        const sessionId = this.userSessions.get(userId);
        if (sessionId) {
          await this.config.sessionManager.deleteSession(sessionId);
          this.userSessions.delete(userId);
        }
        // Send empty sessionId to signal client to clear stored session
        this.sendWsMessage(ws, { type: 'response', content: 'Starting a new conversation!', sessionId: '' });
        return true;
      }

      case 'help': {
        const botName = this.configManager
          ? this.configManager.getUserConfig('default').botName
          : 'Scallopbot';
        const content =
          `**${botName} — Help**\n\n` +
          '**Commands:**\n' +
          '/new — Start new conversation history\n' +
          '/help — Show this help\n' +
          '/model — Switch AI model/provider\n' +
          '/usage — View token usage and costs\n' +
          '/settings — View your configuration\n' +
          '/verbose — Toggle debug output\n\n' +
          '**Skills:**\n' +
          '/memory\\_search `<query>` — Search long-term memory\n' +
          '/goals `<action>` — Manage goals, milestones, and tasks\n' +
          '/board `<action>` — View and manage the task board\n\n' +
          'Just send me a message and I\'ll do my best to help!';
        this.sendWsMessage(ws, { type: 'response', content });
        return true;
      }

      case 'stop': {
        this.stopRequests.add(clientId);
        if (this.interruptQueue) {
          const sessionId = this.userSessions.get('default');
          if (sessionId) this.interruptQueue.clear(sessionId);
        }
        const wasActive = this.activeProcessing.has(clientId);
        if (wasActive) {
          this.sendWsMessage(ws, { type: 'response', content: 'Stopping current task...' });
        } else {
          this.sendWsMessage(ws, { type: 'response', content: 'Nothing running right now.' });
        }
        return true;
      }

      case 'verbose': {
        if (this.verboseClients.has(clientId)) {
          this.verboseClients.delete(clientId);
          this.sendWsMessage(ws, { type: 'response', content: 'Verbose mode OFF' });
        } else {
          this.verboseClients.add(clientId);
          this.sendWsMessage(ws, { type: 'response', content: "Verbose mode ON — you'll see memory lookups, tool calls, and thinking." });
        }
        return true;
      }

      case 'usage': {
        if (!this.db) {
          this.sendWsMessage(ws, { type: 'response', content: 'Usage tracking is not available.' });
          return true;
        }
        const allRecords = this.db.getCostUsageSince(0);
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const todayRecords = allRecords.filter(r => r.timestamp >= todayStart.getTime());
        const monthRecords = allRecords.filter(r => r.timestamp >= monthStart.getTime());

        const todayTokens = todayRecords.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
        const todayCost = todayRecords.reduce((s, r) => s + r.cost, 0);
        const monthTokens = monthRecords.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
        const monthCost = monthRecords.reduce((s, r) => s + r.cost, 0);
        const totalTokens = allRecords.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
        const totalCost = allRecords.reduce((s, r) => s + r.cost, 0);

        const modelUsage = new Map<string, { tokens: number; cost: number }>();
        for (const r of monthRecords) {
          const e = modelUsage.get(r.model) || { tokens: 0, cost: 0 };
          e.tokens += r.inputTokens + r.outputTokens;
          e.cost += r.cost;
          modelUsage.set(r.model, e);
        }

        let modelBreakdown = '';
        const sorted = [...modelUsage.entries()].sort((a, b) => b[1].cost - a[1].cost);
        for (const [model, u] of sorted.slice(0, 5)) {
          const short = model.length > 20 ? model.substring(0, 18) + '..' : model;
          modelBreakdown += `  ${short}: ${this.formatTokens(u.tokens)} ($${u.cost.toFixed(4)})\n`;
        }

        const content =
          `**Usage Statistics**\n\n` +
          `**Today:**\n` +
          `  Tokens: ${this.formatTokens(todayTokens)}\n` +
          `  Cost: $${todayCost.toFixed(4)}\n\n` +
          `**This Month:**\n` +
          `  Tokens: ${this.formatTokens(monthTokens)}\n` +
          `  Cost: $${monthCost.toFixed(4)}\n\n` +
          `**All Time:**\n` +
          `  Tokens: ${this.formatTokens(totalTokens)}\n` +
          `  Cost: $${totalCost.toFixed(4)}\n` +
          `  Requests: ${allRecords.length.toLocaleString()}\n\n` +
          (modelBreakdown ? `**This Month by Model:**\n${modelBreakdown}` : '');
        this.sendWsMessage(ws, { type: 'response', content });
        return true;
      }

      case 'model': {
        if (!this.providerRegistry || !this.configManager) {
          this.sendWsMessage(ws, { type: 'response', content: 'Model switching is not available.' });
          return true;
        }
        const config = this.configManager.getUserConfig('default');
        const available = this.providerRegistry.getAvailableProviders().filter(p => p.name !== 'ollama');

        if (available.length === 0) {
          this.sendWsMessage(ws, { type: 'response', content: 'No AI providers are configured.' });
          return true;
        }

        if (!args) {
          const current = config.modelId === 'auto'
            ? 'auto (smart routing)'
            : ApiChannel.PROVIDER_LABELS[config.modelId] || config.modelId;

          let list = '';
          available.forEach((p, i) => {
            const label = ApiChannel.PROVIDER_LABELS[p.name] || p.name;
            const marker = config.modelId === p.name ? ' ✓' : '';
            list += `  **${i + 1}.** \`${p.name}\` — ${label}${marker}\n`;
          });
          const autoMarker = config.modelId === 'auto' ? ' ✓' : '';
          list += `  **${available.length + 1}.** \`auto\` — Smart routing (picks by complexity)${autoMarker}\n`;

          this.sendWsMessage(ws, {
            type: 'response',
            content: `**Current model:** ${current}\n\n**Available:**\n${list}\nReply \`/model <number or name>\` to switch.`,
          });
          return true;
        }

        // Parse selection
        let selectedName: string;
        const num = parseInt(args, 10);
        if (!isNaN(num) && num >= 1 && num <= available.length + 1) {
          selectedName = num === available.length + 1 ? 'auto' : available[num - 1].name;
        } else {
          selectedName = args.toLowerCase();
        }

        if (selectedName !== 'auto' && !available.some(p => p.name === selectedName)) {
          this.sendWsMessage(ws, { type: 'response', content: `Unknown model \`${args}\`. Use /model to see available options.` });
          return true;
        }

        await this.configManager.updateUserConfig('default', { modelId: selectedName });
        const label = selectedName === 'auto'
          ? 'auto (smart routing)'
          : ApiChannel.PROVIDER_LABELS[selectedName] || selectedName;
        this.sendWsMessage(ws, { type: 'response', content: `Switched to **${label}**` });
        this.logger.info({ clientId, model: selectedName }, 'WebSocket user switched model');
        return true;
      }

      case 'settings': {
        if (!this.configManager) {
          this.sendWsMessage(ws, { type: 'response', content: 'Settings are not available.' });
          return true;
        }
        const cfg = this.configManager.getUserConfig('default');
        const personalityPreview = cfg.customPersonality
          ? cfg.customPersonality.substring(0, 100) + (cfg.customPersonality.length > 100 ? '...' : '')
          : 'Default';
        const modelLabel = cfg.modelId === 'auto'
          ? 'auto (smart routing)'
          : ApiChannel.PROVIDER_LABELS[cfg.modelId] || cfg.modelId;

        const content =
          `**Your Settings**\n\n` +
          `**Bot Name:** ${cfg.botName}\n` +
          `**Model:** ${modelLabel}\n` +
          `**Personality:** ${personalityPreview}\n` +
          `**Timezone:** ${cfg.timezone}\n\n` +
          'Use /model to switch AI provider.';
        this.sendWsMessage(ws, { type: 'response', content });
        return true;
      }

      default:
        // Not a built-in command — let the agent handle it
        return false;
    }
  }

  /**
   * Handle WebSocket messages
   */
  private async handleWsMessage(
    ws: WebSocket,
    clientId: string,
    message: WsMessage
  ): Promise<void> {
    switch (message.type) {
      case 'ping':
        this.sendWsMessage(ws, { type: 'pong' });
        break;

      case 'stop': {
        this.stopRequests.add(clientId);
        // Clear any pending interrupts for this client's session
        if (this.interruptQueue) {
          const stopSessionId = this.userSessions.get('default');
          if (stopSessionId) this.interruptQueue.clear(stopSessionId);
        }
        this.logger.debug({ clientId }, 'Stop requested');
        break;
      }

      case 'chat': {
        if (!message.message) {
          this.sendWsMessage(ws, { type: 'error', error: 'Message is required' });
          return;
        }

        // Handle slash commands before they reach the agent
        const slashHandled = await this.handleSlashCommand(ws, clientId, message.message.trim());
        if (slashHandled) return;

        // All web UI connections share one stable session via userId 'default'
        const userId = 'default';
        const sessionId = await this.getOrCreateSession(userId);

        // Notify engagement tracker (trust feedback loop)
        this.onUserMessage?.(`api:${userId}`);

        // If already processing and no attachments, inject via interrupt queue
        const hasAttachments = message.attachments && message.attachments.length > 0;
        if (this.activeProcessing.has(clientId) && this.interruptQueue && !hasAttachments) {
          this.interruptQueue.enqueue({ sessionId, text: message.message, timestamp: Date.now() });
          this.logger.debug({ clientId, sessionId }, 'Message pushed to interrupt queue');
          return;
        }

        this.logger.debug(
          { clientId, sessionId, messageLength: message.message.length },
          'WebSocket chat'
        );

        this.activeProcessing.add(clientId);
        try {
          // Progress callback to send debug updates to WebSocket
          const onProgress = async (update: { type: string; message: string; toolName?: string; iteration?: number; count?: number; action?: string; items?: { type: string; content: string; subject?: string }[] }) => {
            if (update.type === 'tool_start') {
              this.sendWsMessage(ws, {
                type: 'skill_start',
                skill: update.toolName || 'skill',
                input: update.message
              });
            } else if (update.type === 'tool_complete') {
              this.sendWsMessage(ws, {
                type: 'skill_complete',
                skill: update.toolName || 'skill',
                output: update.message
              });
            } else if (update.type === 'tool_error') {
              this.sendWsMessage(ws, {
                type: 'skill_error',
                skill: update.toolName || 'skill',
                error: update.message
              });
            } else if (update.type === 'thinking' || update.type === 'planning') {
              this.sendWsMessage(ws, {
                type: update.type,
                message: update.message
              });
            } else if (update.type === 'memory') {
              this.sendWsMessage(ws, {
                type: 'memory',
                action: update.action || 'search',
                message: update.message,
                count: update.count,
                items: update.items
              });
            } else if (update.type === 'status') {
              this.sendWsMessage(ws, {
                type: 'debug',
                message: update.message
              });
            }
          };

          // Convert WebSocket attachments to agent Attachment format
          let attachments: Attachment[] | undefined;
          if (hasAttachments) {
            attachments = message.attachments!.map((att) => ({
              type: att.type === 'image' ? 'image' as const : 'file' as const,
              data: Buffer.from(att.data, 'base64'),
              mimeType: att.mimeType,
              filename: att.filename,
            }));
            this.logger.debug({ count: attachments.length }, 'Processing WebSocket attachments');
          }

          // Clear any previous stop request for this client
          this.stopRequests.delete(clientId);

          // Should stop callback checks if user requested stop
          const shouldStop = () => this.stopRequests.has(clientId);

          const result = await this.config.agent.processMessage(
            sessionId,
            message.message,
            attachments,
            onProgress,
            shouldStop
          );

          // Clear stop request after completion
          this.stopRequests.delete(clientId);

          this.sendWsMessage(ws, { type: 'response', sessionId, content: result.response });
        } catch (error) {
          const err = error as Error;
          this.logger.error({ clientId, sessionId, error: err.message }, 'WebSocket chat error');
          this.sendWsMessage(ws, { type: 'error', error: 'Failed to process message' });
        } finally {
          this.activeProcessing.delete(clientId);
        }
        break;
      }

      default:
        this.sendWsMessage(ws, { type: 'error', error: `Unknown message type: ${message.type}` });
    }
  }

  /**
   * Send WebSocket message
   */
  private sendWsMessage(ws: WebSocket, message: WsResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Parse request body as JSON with size limit
   */
  private parseBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      const maxSize = this.config.maxBodySize;

      req.on('data', (chunk: Buffer | string) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          reject(new Error(`Request body too large (max ${maxSize} bytes)`));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Get server address
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) {
      return null;
    }
    const addr = this.server.address();
    if (typeof addr === 'string' || !addr) {
      return null;
    }
    return { host: addr.address, port: addr.port };
  }

  // ============================================
  // TriggerSource interface implementation
  // ============================================

  /**
   * Send a message to all connected WebSocket clients for a user.
   * Implements TriggerSource.sendMessage
   *
   * @param userId - The user identifier (e.g., "ws-abc123")
   * @param message - The message content
   * @returns true if at least one message was sent
   */
  async sendMessage(userId: string, message: string): Promise<boolean> {
    const clients = this.clientsByUser.get(userId);

    if (!clients || clients.size === 0) {
      this.logger.debug({ userId }, 'No WebSocket clients for user');
      return false;
    }

    // Check if message is a structured proactive JSON object
    let wsMessage: WsResponse;
    try {
      const parsed = JSON.parse(message) as { type?: string; content?: string; category?: string; urgency?: string; source?: string };
      if (parsed.type === 'proactive') {
        wsMessage = {
          type: 'proactive',
          content: parsed.content,
          category: parsed.category,
          urgency: parsed.urgency,
          source: parsed.source,
        };
      } else {
        wsMessage = { type: 'trigger', content: message };
      }
    } catch {
      // Not JSON — send as plain trigger
      wsMessage = { type: 'trigger', content: message };
    }

    let sentCount = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendWsMessage(ws, wsMessage);
        sentCount++;
      }
    }

    this.logger.debug({ userId, sentCount, clientCount: clients.size }, 'Trigger message sent');
    return sentCount > 0;
  }

  /**
   * Send a file notification to all connected WebSocket clients for a user.
   * Implements TriggerSource.sendFile
   *
   * Note: For WebSocket clients, we send a file notification with path.
   * The client is responsible for downloading the file if needed.
   *
   * @param userId - The user identifier
   * @param filePath - Path to the file
   * @param caption - Optional caption
   * @returns true if at least one notification was sent
   */
  async sendFile(userId: string, filePath: string, caption?: string): Promise<boolean> {
    const clients = this.clientsByUser.get(userId);

    if (!clients || clients.size === 0) {
      this.logger.debug({ userId }, 'No WebSocket clients for user');
      return false;
    }

    let sentCount = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendWsMessage(ws, { type: 'file', path: filePath, caption });
        sentCount++;
      }
    }

    this.logger.debug({ userId, filePath, sentCount, clientCount: clients.size }, 'File notification sent');
    return sentCount > 0;
  }

  /**
   * Get the name of this trigger source.
   * Implements TriggerSource.getName
   */
  getName(): string {
    return 'api';
  }
}
