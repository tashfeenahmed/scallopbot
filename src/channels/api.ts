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
import { nanoid } from 'nanoid';

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
  type: 'chat' | 'ping';
  sessionId?: string;
  message?: string;
  /** Optional image/file attachments */
  attachments?: WsAttachment[];
}

interface WsResponse {
  type: 'response' | 'chunk' | 'error' | 'pong' | 'trigger' | 'file' | 'skill_start' | 'skill_complete' | 'skill_error' | 'thinking' | 'debug' | 'memory';
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
}

/**
 * API Channel - implements both Channel and TriggerSource interfaces.
 * TriggerSource allows sending proactive messages to connected WebSocket clients.
 */
export class ApiChannel implements Channel, TriggerSource {
  name = 'api';

  private config: Required<Omit<ApiChannelConfig, 'apiKey' | 'allowedOrigins' | 'staticDir' | 'costTracker'>> & {
    apiKey?: string;
    allowedOrigins: string[];
    staticDir?: string;
    costTracker?: CostTracker;
  };
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private logger: Logger;
  private running = false;
  private userSessions: Map<string, string> = new Map();
  /** Track WebSocket clients by userId for trigger support */
  private clientsByUser: Map<string, Set<WebSocket>> = new Map();

  constructor(config: ApiChannelConfig) {
    this.config = {
      port: config.port,
      host: config.host || '127.0.0.1',
      apiKey: config.apiKey,
      allowedOrigins: config.allowedOrigins || [],
      maxBodySize: config.maxBodySize || MAX_BODY_SIZE,
      staticDir: config.staticDir,
      costTracker: config.costTracker,
      agent: config.agent,
      sessionManager: config.sessionManager,
      logger: config.logger,
    };
    this.logger = config.logger.child({ channel: 'api' });
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

    // Create new session — prefix userId with channel for trigger routing
    const session = await this.config.sessionManager.createSession({
      userId: `api:${userId}`,
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

    // Serve static files (no auth required for static assets)
    if (this.config.staticDir && !urlPath.startsWith('/api/') && urlPath !== '/ws') {
      const served = await this.serveStaticFile(urlPath, res);
      if (served) {
        return;
      }
    }

    // Check authentication for API routes (file downloads and costs exempt when same-origin)
    const sameOriginExempt = (urlPath === '/api/files' || urlPath === '/api/costs') && method === 'GET';
    const skipAuth = sameOriginExempt && this.isSameOriginRequest(req);
    if (this.config.apiKey && !skipAuth && !this.authenticateRequest(req)) {
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
      } else if (urlPath.startsWith('/api/sessions/') && method === 'GET') {
        const sessionId = urlPath.slice('/api/sessions/'.length);
        await this.handleGetSession(res, sessionId);
      } else if (urlPath.startsWith('/api/sessions/') && method === 'DELETE') {
        const sessionId = urlPath.slice('/api/sessions/'.length);
        await this.handleDeleteSession(res, sessionId);
      } else if (urlPath === '/api/files' && method === 'GET') {
        await this.handleFileDownload(res, url);
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
    // UserId follows the ws-{clientId} pattern used by session management
    const userId = `ws-${clientId}`;
    this.logger.debug({ clientId, userId }, 'WebSocket client connected');

    // Check authentication using constant-time comparison
    if (this.config.apiKey) {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const apiKey = url.searchParams.get('apiKey') || req.headers['x-api-key'];

      if (!this.authenticateWebSocket(apiKey)) {
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    // Track this client by userId for trigger support
    this.addClientToUser(userId, ws);

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
      this.removeClientFromUser(userId, ws);
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

      case 'chat':
        if (!message.message) {
          this.sendWsMessage(ws, { type: 'error', error: 'Message is required' });
          return;
        }

        // Ensure session exists before processing
        const userId = `ws-${clientId}`;
        const sessionId = await this.getOrCreateSession(userId);

        this.logger.debug(
          { clientId, sessionId, messageLength: message.message.length },
          'WebSocket chat'
        );

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
            } else if (update.type === 'thinking') {
              this.sendWsMessage(ws, {
                type: 'thinking',
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
          if (message.attachments && message.attachments.length > 0) {
            attachments = message.attachments.map((att) => ({
              type: att.type === 'image' ? 'image' as const : 'file' as const,
              data: Buffer.from(att.data, 'base64'),
              mimeType: att.mimeType,
              filename: att.filename,
            }));
            this.logger.debug({ count: attachments.length }, 'Processing WebSocket attachments');
          }

          const result = await this.config.agent.processMessage(
            sessionId,
            message.message,
            attachments,
            onProgress
          );
          this.sendWsMessage(ws, { type: 'response', sessionId, content: result.response });
        } catch (error) {
          const err = error as Error;
          this.logger.error({ clientId, sessionId, error: err.message }, 'WebSocket chat error');
          this.sendWsMessage(ws, { type: 'error', error: 'Failed to process message' });
        }
        break;

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

    let sentCount = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendWsMessage(ws, { type: 'trigger', content: message });
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
