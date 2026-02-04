/**
 * Tests for REST/WebSocket API Channel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiChannel, type ApiChannelConfig } from './api.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager, Session } from '../agent/session.js';
import type { Logger } from 'pino';
import http from 'http';
import WebSocket from 'ws';

// Create mock logger
const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

// Create mock agent
const createMockAgent = (): Agent =>
  ({
    processMessage: vi.fn().mockResolvedValue({
      response: 'Hello from the bot!',
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      iterationsUsed: 1,
    }),
  }) as unknown as Agent;

// Create mock session manager
const createMockSessionManager = (): SessionManager =>
  ({
    createSession: vi.fn().mockResolvedValue({
      id: 'new-session-123',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getSession: vi.fn().mockResolvedValue(null),
    deleteSession: vi.fn().mockResolvedValue(true),
    addMessage: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
  }) as unknown as SessionManager;

describe('ApiChannel', () => {
  let channel: ApiChannel;
  let mockAgent: Agent;
  let mockSessionManager: SessionManager & {
    createSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
  let mockLogger: Logger;
  let port: number;

  beforeEach(() => {
    mockAgent = createMockAgent();
    mockSessionManager = createMockSessionManager() as SessionManager & {
      createSession: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
      deleteSession: ReturnType<typeof vi.fn>;
    };
    mockLogger = createMockLogger();
    // Use a random port to avoid conflicts
    port = 3000 + Math.floor(Math.random() * 1000);

    channel = new ApiChannel({
      port,
      host: '127.0.0.1',
      agent: mockAgent,
      sessionManager: mockSessionManager,
      logger: mockLogger,
    });
  });

  afterEach(async () => {
    if (channel.isRunning()) {
      await channel.stop();
    }
  });

  describe('constructor', () => {
    it('should create channel with correct name', () => {
      expect(channel.name).toBe('api');
    });

    it('should use default host if not provided', () => {
      const channelWithDefaults = new ApiChannel({
        port: 3001,
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
      expect(channelWithDefaults.name).toBe('api');
    });
  });

  describe('start and stop', () => {
    it('should start and become running', async () => {
      expect(channel.isRunning()).toBe(false);

      await channel.start();

      expect(channel.isRunning()).toBe(true);
      expect(channel.getAddress()).toEqual({ host: '127.0.0.1', port });
    });

    it('should stop and no longer be running', async () => {
      await channel.start();
      expect(channel.isRunning()).toBe(true);

      await channel.stop();

      expect(channel.isRunning()).toBe(false);
      expect(channel.getAddress()).toBe(null);
    });

    it('should be idempotent on multiple starts', async () => {
      await channel.start();
      await channel.start();

      expect(channel.isRunning()).toBe(true);
    });

    it('should be idempotent on multiple stops', async () => {
      await channel.start();
      await channel.stop();
      await channel.stop();

      expect(channel.isRunning()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return connected status when running', async () => {
      await channel.start();

      const status = channel.getStatus();

      expect(status.connected).toBe(true);
      expect(status.authenticated).toBe(true);
    });

    it('should return not connected when not running', () => {
      const status = channel.getStatus();

      expect(status.connected).toBe(false);
    });
  });

  describe('getOrCreateSession', () => {
    it('should create new session for new user', async () => {
      const sessionId = await channel.getOrCreateSession('user123');

      expect(sessionId).toBe('new-session-123');
      expect(mockSessionManager.createSession).toHaveBeenCalledWith({
        userId: 'api:user123',
        channelId: 'api',
      });
    });

    it('should return cached session for existing user', async () => {
      // First call creates session
      await channel.getOrCreateSession('user123');

      // Mock getSession to return existing session
      mockSessionManager.getSession.mockResolvedValue({
        id: 'new-session-123',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Session);

      // Second call should use cache
      const sessionId = await channel.getOrCreateSession('user123');

      expect(sessionId).toBe('new-session-123');
      expect(mockSessionManager.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleReset', () => {
    it('should delete session and clear cache', async () => {
      await channel.getOrCreateSession('user123');

      await channel.handleReset('user123');

      expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('new-session-123');
    });

    it('should do nothing if user has no session', async () => {
      await channel.handleReset('unknown-user');

      expect(mockSessionManager.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe('REST API', () => {
    beforeEach(async () => {
      await channel.start();
    });

    const makeRequest = (
      path: string,
      method: string = 'GET',
      body?: unknown,
      headers?: Record<string, string>
    ): Promise<{ status: number; body: unknown }> => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode || 0,
                body: data ? JSON.parse(data) : {},
              });
            } catch {
              resolve({ status: res.statusCode || 0, body: data });
            }
          });
        });

        req.on('error', reject);

        if (body) {
          req.write(JSON.stringify(body));
        }

        req.end();
      });
    };

    describe('GET /api/health', () => {
      it('should return health status', async () => {
        const res = await makeRequest('/api/health');

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).status).toBe('ok');
        expect((res.body as Record<string, unknown>).timestamp).toBeDefined();
      });
    });

    describe('POST /api/chat', () => {
      it('should process chat message', async () => {
        const res = await makeRequest('/api/chat', 'POST', {
          message: 'Hello!',
        });

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).response).toBe('Hello from the bot!');
        expect((res.body as Record<string, unknown>).sessionId).toBeDefined();
      });

      it('should use provided sessionId', async () => {
        const res = await makeRequest('/api/chat', 'POST', {
          message: 'Hello!',
          sessionId: 'custom-session',
        });

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).sessionId).toBe('custom-session');
      });

      it('should return 400 for missing message', async () => {
        const res = await makeRequest('/api/chat', 'POST', {});

        expect(res.status).toBe(400);
        expect((res.body as Record<string, unknown>).error).toBe('Message is required');
      });
    });

    describe('POST /api/chat/stream', () => {
      it('should stream response as SSE', async () => {
        const events: string[] = [];

        await new Promise<void>((resolve, reject) => {
          const options = {
            hostname: '127.0.0.1',
            port,
            path: '/api/chat/stream',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          };

          const req = http.request(options, (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('text/event-stream');

            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk.toString();
              // Parse SSE events
              const lines = buffer.split('\n');
              for (const line of lines) {
                if (line.startsWith('event:') || line.startsWith('data:')) {
                  events.push(line);
                }
              }
            });
            res.on('end', () => resolve());
          });

          req.on('error', reject);
          req.write(JSON.stringify({ message: 'Hello!' }));
          req.end();
        });

        expect(events.some((e) => e.includes('event: message'))).toBe(true);
        expect(events.some((e) => e.includes('event: done'))).toBe(true);
      });
    });

    describe('GET /api/sessions', () => {
      it('should list sessions', async () => {
        const res = await makeRequest('/api/sessions');

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).sessions).toEqual([]);
      });
    });

    describe('404 handling', () => {
      it('should return 404 for unknown paths', async () => {
        const res = await makeRequest('/api/unknown');

        expect(res.status).toBe(404);
        expect((res.body as Record<string, unknown>).error).toBe('Not found');
      });
    });
  });

  describe('API Key Authentication', () => {
    let authenticatedChannel: ApiChannel;
    let authPort: number;

    beforeEach(async () => {
      authPort = 4000 + Math.floor(Math.random() * 1000);
      authenticatedChannel = new ApiChannel({
        port: authPort,
        host: '127.0.0.1',
        apiKey: 'secret-key-123',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
      await authenticatedChannel.start();
    });

    afterEach(async () => {
      await authenticatedChannel.stop();
    });

    const makeAuthRequest = (
      path: string,
      method: string = 'GET',
      body?: unknown,
      headers?: Record<string, string>
    ): Promise<{ status: number; body: unknown }> => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port: authPort,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode || 0,
                body: data ? JSON.parse(data) : {},
              });
            } catch {
              resolve({ status: res.statusCode || 0, body: data });
            }
          });
        });

        req.on('error', reject);

        if (body) {
          req.write(JSON.stringify(body));
        }

        req.end();
      });
    };

    it('should reject requests without API key', async () => {
      const res = await makeAuthRequest('/api/health');

      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe('Unauthorized');
    });

    it('should accept requests with valid X-API-Key header', async () => {
      const res = await makeAuthRequest('/api/health', 'GET', undefined, {
        'X-API-Key': 'secret-key-123',
      });

      expect(res.status).toBe(200);
    });

    it('should accept requests with Bearer token', async () => {
      const res = await makeAuthRequest('/api/health', 'GET', undefined, {
        'Authorization': 'Bearer secret-key-123',
      });

      expect(res.status).toBe(200);
    });

    it('should reject requests with invalid API key', async () => {
      const res = await makeAuthRequest('/api/health', 'GET', undefined, {
        'X-API-Key': 'wrong-key',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('WebSocket', () => {
    beforeEach(async () => {
      await channel.start();
    });

    it('should accept WebSocket connections', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
    });

    it('should respond to ping with pong', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise<unknown>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'ping' }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });

      expect((response as Record<string, unknown>).type).toBe('pong');
    });

    it('should process chat messages', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise<unknown>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'chat', message: 'Hello!' }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });

      expect((response as Record<string, unknown>).type).toBe('response');
      expect((response as Record<string, unknown>).content).toBe('Hello from the bot!');
      expect((response as Record<string, unknown>).sessionId).toBeDefined();
    });

    it('should return error for missing message in chat', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise<unknown>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'chat' }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });

      expect((response as Record<string, unknown>).type).toBe('error');
      expect((response as Record<string, unknown>).error).toBe('Message is required');
    });

    it('should return error for unknown message type', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise<unknown>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'unknown' }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });

      expect((response as Record<string, unknown>).type).toBe('error');
      expect((response as Record<string, unknown>).error).toContain('Unknown message type');
    });
  });

  describe('WebSocket with Authentication', () => {
    let authChannel: ApiChannel;
    let authPort: number;

    beforeEach(async () => {
      authPort = 5000 + Math.floor(Math.random() * 1000);
      authChannel = new ApiChannel({
        port: authPort,
        host: '127.0.0.1',
        apiKey: 'ws-secret-key',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
      await authChannel.start();
    });

    afterEach(async () => {
      await authChannel.stop();
    });

    it('should reject WebSocket connections without API key', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${authPort}/ws`);

      await new Promise<void>((resolve) => {
        ws.on('close', (code) => {
          expect(code).toBe(4001);
          resolve();
        });
        ws.on('error', () => {
          // Connection refused is expected
          resolve();
        });
      });
    });

    it('should accept WebSocket connections with API key in query', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${authPort}/ws?apiKey=ws-secret-key`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('close', (code) => {
          if (code === 4001) {
            reject(new Error('Unauthorized'));
          }
        });
        ws.on('error', reject);
      });
    });
  });
});
