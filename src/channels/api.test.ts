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
import { ScallopDatabase } from '../memory/db.js';
import { SubAgentRegistry } from '../subagent/registry.js';

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
    startNewSession: vi.fn().mockResolvedValue({
      id: 'fresh-session-456',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
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
    startNewSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
  let mockLogger: Logger;
  let port: number;

  beforeEach(() => {
    mockAgent = createMockAgent();
    mockSessionManager = createMockSessionManager() as SessionManager & {
      createSession: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
      startNewSession: ReturnType<typeof vi.fn>;
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
    it('should archive the prior session and immediately create a fresh one', async () => {
      await channel.getOrCreateSession('user123');

      await channel.handleReset('user123');

      expect(mockSessionManager.startNewSession).toHaveBeenCalledWith({
        userId: 'api:user123',
        channelId: 'api',
      }, 'new-session-123');
      mockSessionManager.getSession.mockResolvedValue({
        id: 'fresh-session-456',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Session);
      expect(await channel.getOrCreateSession('user123')).toBe('fresh-session-456');
      expect(mockSessionManager.deleteSession).not.toHaveBeenCalled();
    });

    it('should still force-create a fresh session after a restart with no cache', async () => {
      await channel.handleReset('unknown-user');

      expect(mockSessionManager.startNewSession).toHaveBeenCalledWith({
        userId: 'api:unknown-user',
        channelId: 'api',
      }, undefined);
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

    it('exposes the durable delegated-task rail without private protocol messages', async () => {
      await channel.stop();
      const db = new ScallopDatabase(':memory:');
      db.createAuthUser('task-test@example.com', 'not-used-in-api-key-test');
      const registry = new SubAgentRegistry({ logger: mockLogger, persistence: db });
      const run = registry.createRun('parent', {
        task: 'Review the deployment safely',
        label: 'review',
        taskName: 'Deployment review',
        role: 'orchestrator',
      }, 'child');
      registry.updateStatus(run.id, 'running');
      channel = new ApiChannel({
        port,
        host: '127.0.0.1',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
        db,
        apiKey: 'task-test-key',
        subAgentRegistry: registry,
      });
      await channel.start();
      const response = await makeRequest('/api/subagents', 'GET', undefined, { 'X-API-Key': 'task-test-key' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        tasks: [expect.objectContaining({
          id: run.id,
          taskName: 'Deployment review',
          status: 'running',
          role: 'orchestrator',
        })],
      });
      await channel.stop();
      db.close();
    });

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

      it('strips inline reasoning from the final REST response', async () => {
        vi.mocked(mockAgent.processMessage).mockResolvedValueOnce({
          response: '<think>REST_FINAL_THOUGHT_SECRET</think>Safe REST answer.',
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          iterationsUsed: 1,
          completionReason: 'natural_end',
        });

        const res = await makeRequest('/api/chat', 'POST', { message: 'Hello!' });

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).response).toBe('Safe REST answer.');
        expect(JSON.stringify(res.body)).not.toContain('REST_FINAL_THOUGHT_SECRET');
        expect(JSON.stringify(res.body)).not.toContain('<think>');
      });

      it('should use provided sessionId', async () => {
        const res = await makeRequest('/api/chat', 'POST', {
          message: 'Hello!',
          sessionId: 'custom-session',
        });

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).sessionId).toBe('custom-session');
      });

      it('should rotate a stale archived sessionId instead of colliding with its tombstone', async () => {
        const db = new ScallopDatabase(':memory:');
        db.createSession('archived-session', { userId: 'default', channelId: 'api' });
        db.addSessionMessage('archived-session', 'user', 'Preserved old history');
        db.archiveSession('archived-session', 'new_conversation', 'user_command');
        (channel as unknown as { db: ScallopDatabase | null }).db = db;

        try {
          const res = await makeRequest('/api/chat', 'POST', {
            message: 'This belongs in a fresh conversation',
            sessionId: 'archived-session',
          });

          const returnedSessionId = (res.body as Record<string, unknown>).sessionId;
          expect(res.status).toBe(200);
          expect(returnedSessionId).not.toBe('archived-session');
          expect(mockSessionManager.createSession).toHaveBeenCalledWith({
            userId: 'default',
            channelId: 'api',
            id: returnedSessionId,
          });
          expect(db.getSessionMessages('archived-session').map(message => message.content)).toEqual([
            'Preserved old history',
          ]);
        } finally {
          (channel as unknown as { db: ScallopDatabase | null }).db = null;
          db.close();
        }
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

      it('strips inline reasoning from the final SSE response', async () => {
        vi.mocked(mockAgent.processMessage).mockResolvedValueOnce({
          response: '<think>SSE_FINAL_THOUGHT_SECRET</think>Safe SSE answer.',
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          iterationsUsed: 1,
          completionReason: 'natural_end',
        });

        const payload = await new Promise<string>((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/chat/stream',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk.toString(); });
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.write(JSON.stringify({ message: 'Hello!' }));
          req.end();
        });

        expect(payload).toContain('Safe SSE answer.');
        expect(payload).not.toContain('SSE_FINAL_THOUGHT_SECRET');
        expect(payload).not.toContain('<think>');
      });
    });

    describe('GET /api/sessions', () => {
      it('should list sessions', async () => {
        const res = await makeRequest('/api/sessions');

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).sessions).toEqual([]);
      });
    });

    describe('DELETE /api/sessions/:id', () => {
      it('should reject deletion without exact explicit confirmation', async () => {
        const res = await makeRequest('/api/sessions/session-to-forget', 'DELETE');

        expect(res.status).toBe(409);
        expect(mockSessionManager.deleteSession).not.toHaveBeenCalled();
      });

      it('should forget only the exactly confirmed session', async () => {
        const res = await makeRequest(
          '/api/sessions/session-to-forget?confirm=session-to-forget',
          'DELETE',
        );

        expect(res.status).toBe(200);
        expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('session-to-forget', {
          confirmed: true,
          reason: 'api_explicit_forget',
          actor: 'api_user',
        });
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

    it('strips inline reasoning from the final WebSocket response', async () => {
      vi.mocked(mockAgent.processMessage).mockResolvedValueOnce({
        response: '<think>WS_FINAL_THOUGHT_SECRET</think>Safe WebSocket answer.',
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        iterationsUsed: 1,
        completionReason: 'natural_end',
      });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', message: 'Hello!' })));
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        ws.on('error', reject);
      });

      expect(response).toMatchObject({ type: 'response', content: 'Safe WebSocket answer.' });
      expect(JSON.stringify(response)).not.toContain('WS_FINAL_THOUGHT_SECRET');
      expect(JSON.stringify(response)).not.toContain('<think>');
    });

    it('does not send internal progress unless the client explicitly enables verbose mode', async () => {
      vi.mocked(mockAgent.processMessage).mockImplementation(async (
        _sessionId,
        _message,
        _attachments,
        onProgress,
      ) => {
        await onProgress?.({
          type: 'thinking',
          message: 'CHAIN_OF_THOUGHT_SECRET: I should inspect the private state.',
          iteration: 1,
        });
        await onProgress?.({
          type: 'planning',
          message: 'INTERNAL_PLAN_SECRET: call three tools before replying.',
          iteration: 1,
        });
        return {
          response: 'Safe final answer.',
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          iterationsUsed: 1,
          completionReason: 'natural_end',
        };
      });

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const received: Record<string, unknown>[] = [];
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket response')), 5_000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', message: 'Hello!' })));
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(parsed);
          if (parsed.type === 'response') {
            clearTimeout(timeout);
            ws.close();
            resolve(received);
          }
        });
        ws.on('error', reject);
      });

      expect(messages).toEqual([
        expect.objectContaining({ type: 'response', content: 'Safe final answer.' }),
      ]);
      expect(JSON.stringify(messages)).not.toContain('CHAIN_OF_THOUGHT_SECRET');
      expect(JSON.stringify(messages)).not.toContain('INTERNAL_PLAN_SECRET');
    });

    it('sends redacted lifecycle summaries, never raw reasoning, to verbose clients', async () => {
      vi.mocked(mockAgent.processMessage).mockImplementation(async (
        _sessionId,
        _message,
        _attachments,
        onProgress,
      ) => {
        await onProgress?.({
          type: 'thinking',
          message: 'CHAIN_OF_THOUGHT_SECRET: I should inspect the private state.',
          iteration: 1,
        });
        await onProgress?.({
          type: 'planning',
          message: 'INTERNAL_PLAN_SECRET: call three tools before replying.',
          iteration: 1,
        });
        await onProgress?.({
          type: 'tool_start',
          message: 'Using credential sk-abcdefghijklmnop to call the service',
          toolName: 'example_tool',
          iteration: 1,
        });
        return {
          response: 'Safe final answer.',
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          iterationsUsed: 1,
          completionReason: 'natural_end',
        };
      });

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const received: Record<string, unknown>[] = [];
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for verbose WebSocket response')), 5_000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', message: '/verbose' })));
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(parsed);
          if (parsed.type === 'response' && String(parsed.content).startsWith('Verbose mode ON')) {
            ws.send(JSON.stringify({ type: 'chat', message: 'Hello!' }));
          } else if (parsed.type === 'response' && parsed.content === 'Safe final answer.') {
            clearTimeout(timeout);
            ws.close();
            resolve(received);
          }
        });
        ws.on('error', reject);
      });

      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'thinking', message: 'Reasoning in progress…' }),
        expect.objectContaining({ type: 'planning', message: 'Planning next steps…' }),
        expect.objectContaining({
          type: 'skill_start',
          skill: 'example_tool',
          input: 'Using credential [REDACTED] to call the service',
        }),
        expect.objectContaining({ type: 'response', content: 'Safe final answer.' }),
      ]));
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain('CHAIN_OF_THOUGHT_SECRET');
      expect(serialized).not.toContain('INTERNAL_PLAN_SECRET');
      expect(serialized).not.toContain('sk-abcdefghijklmnop');
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

  describe('history presentation safety', () => {
    it('removes stored reasoning and tool protocol blocks from default API history', async () => {
      const db = new ScallopDatabase(':memory:');
      db.createAuthUser('test@example.com', 'unused-test-hash');
      db.createSession('history-session', { userId: 'api:default', channelId: 'api' });
      db.addSessionMessage('history-session', 'user', 'Real historical question');
      db.addSessionMessage('history-session', 'user', JSON.stringify([
        {
          type: 'tool_result',
          tool_use_id: 'literal-user-json',
          content: 'USER_LITERAL_TOOL_RESULT_JSON',
        },
      ]), 'human_user');
      db.addSessionMessage(
        'history-session',
        'user',
        'PERSISTED_KIND_INTERNAL_PLAIN_TEXT',
        'system_internal',
      );
      db.addSessionMessage(
        'history-session',
        'assistant',
        'PERSISTED_KIND_PROTOCOL_PLAIN_TEXT',
        'assistant_protocol',
      );
      db.addSessionMessage('history-session', 'assistant', JSON.stringify([
        { type: 'thinking', thinking: 'HISTORICAL_THOUGHT_SECRET' },
        { type: 'text', text: 'INTERNAL_PLAN_TEXT: I should call the tool now.' },
        { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'PRIVATE_TOOL_INPUT' } },
      ]));
      db.createSession('worker-session', {
        userId: 'api:default', channelId: 'api', isSubAgent: true,
      });
      db.addSessionMessage('worker-session', 'assistant', 'PRIVATE_WORKER_FINAL');
      db.addSessionMessage('history-session', 'user', JSON.stringify([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'PRIVATE_TOOL_OUTPUT' },
      ]));
      for (let index = 0; index < 120; index++) {
        db.addSessionMessage('history-session', 'user', JSON.stringify([
          { type: 'tool_result', tool_use_id: `bulk-${index}`, content: `BULK_PRIVATE_${index}` },
        ]));
      }
      db.addSessionMessage('history-session', 'assistant', JSON.stringify([
        { type: 'thinking', thinking: 'SECOND_HISTORICAL_THOUGHT_SECRET' },
        { type: 'text', text: '<think>INLINE_THOUGHT_SECRET</think>Safe historical answer.' },
      ]));

      port = 6_000 + Math.floor(Math.random() * 1_000);
      channel = new ApiChannel({
        port,
        host: '127.0.0.1',
        apiKey: 'history-test-key',
        db,
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });

      try {
        await channel.start();
        const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/messages?limit=50',
            method: 'GET',
            headers: { 'X-API-Key': 'history-test-key' },
          }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(data) as Record<string, unknown>,
            }));
          });
          req.on('error', reject);
          req.end();
        });

        expect(response.status).toBe(200);
        const serialized = JSON.stringify(response.body);
        expect(serialized).toContain('Safe historical answer.');
        expect(serialized).toContain('USER_LITERAL_TOOL_RESULT_JSON');
        expect(serialized).not.toContain('HISTORICAL_THOUGHT_SECRET');
        expect(serialized).not.toContain('SECOND_HISTORICAL_THOUGHT_SECRET');
        expect(serialized).not.toContain('INLINE_THOUGHT_SECRET');
        expect(serialized).not.toContain('INTERNAL_PLAN_TEXT');
        expect(serialized).not.toContain('PRIVATE_TOOL_INPUT');
        expect(serialized).not.toContain('PRIVATE_TOOL_OUTPUT');
        expect(serialized).not.toContain('PRIVATE_WORKER_FINAL');
        expect(serialized).not.toContain('PERSISTED_KIND_INTERNAL_PLAIN_TEXT');
        expect(serialized).not.toContain('PERSISTED_KIND_PROTOCOL_PLAIN_TEXT');
        const messages = response.body.messages as Array<{ role: string; content: string }>;
        expect(messages).toHaveLength(3);
        expect(messages.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
      } finally {
        await channel.stop();
        db.close();
      }
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
