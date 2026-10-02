import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { CompletionResponse, LLMProvider, StreamHandlers } from '../providers/types.js';
import { ScallopDatabase } from '../memory/db.js';
import type { ProgressUpdate } from './agent.js';

/** A provider that streams each scripted response's text in small pieces. */
function streamingProvider(responses: CompletionResponse[]): LLMProvider & { completeStream: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    name: 'mock-stream',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => responses[index++]),
    completeStream: vi.fn().mockImplementation(async (_request, handlers: StreamHandlers) => {
      const response = responses[index++];
      for (const block of response.content) {
        if (block.type === 'text') {
          for (let i = 0; i < block.text.length; i += 4) handlers.onTextDelta?.(block.text.slice(i, i + 4));
        } else if (block.type === 'tool_use') {
          handlers.onToolUseStart?.(block.name);
        }
      }
      return response;
    }),
  };
}

describe('Agent reply streaming', () => {
  let testDir: string;
  let db: ScallopDatabase;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-agent-stream-'));
    db = new ScallopDatabase(path.join(testDir, 'test.db'));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function makeAgent(provider: LLMProvider, streaming?: boolean) {
    const { Agent } = await import('./agent.js');
    const { SessionManager } = await import('./session.js');
    const sessionManager = new SessionManager(db);
    const agent = new Agent({
      provider,
      sessionManager,
      workspace: testDir,
      logger: pino({ level: 'silent' }),
      maxIterations: 5,
      ...(streaming !== undefined && { streaming }),
    });
    const session = await sessionManager.createSession();
    return { agent, sessionId: session.id };
  }

  it('streams planning text, resets it at the tool call, then streams the final reply', async () => {
    const provider = streamingProvider([
      {
        content: [
          { type: 'text', text: 'Let me look that up.' },
          { type: 'tool_use', id: 'tu_1', name: 'nonexistent_tool', input: {} },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'm',
      },
      {
        content: [{ type: 'text', text: '<think>private</think>Here is the answer. [DONE]' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 20, outputTokens: 8 },
        model: 'm',
      },
    ]);
    const { agent, sessionId } = await makeAgent(provider);
    const updates: ProgressUpdate[] = [];

    const result = await agent.processMessage(sessionId, 'What is it?', undefined, async (u) => { updates.push(u); });

    expect(result.response).toBe('Here is the answer.');
    expect(provider.completeStream).toHaveBeenCalledTimes(2);
    expect(provider.complete).not.toHaveBeenCalled();

    const stream = updates.filter((u) => u.type === 'text_delta' || u.type === 'text_reset');
    const firstReset = stream.findIndex((u) => u.type === 'text_reset');
    expect(stream.slice(0, firstReset).map((u) => u.message).join('')).toBe('Let me look that up.');
    expect(stream.slice(0, firstReset).every((u) => u.iteration === 1)).toBe(true);
    const after = stream.slice(firstReset + 1);
    expect(after.every((u) => u.type === 'text_delta')).toBe(true);
    expect(after.map((u) => u.message).join('')).toBe('Here is the answer.');
    expect(after.every((u) => u.iteration === 2)).toBe(true);
    // The reset reaches the channel before any tool progress.
    const toolStart = updates.findIndex((u) => u.type === 'tool_start' || u.type === 'tool_error');
    if (toolStart !== -1) expect(updates.indexOf(stream[firstReset])).toBeLessThan(toolStart);
  });

  it('uses complete() and emits no deltas when there is no progress callback', async () => {
    const provider = streamingProvider([{
      content: [{ type: 'text', text: 'Plain.' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    }]);
    const { agent, sessionId } = await makeAgent(provider);
    const result = await agent.processMessage(sessionId, 'hi');
    expect(result.response).toBe('Plain.');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.completeStream).not.toHaveBeenCalled();
  });

  it('respects streaming: false', async () => {
    const provider = streamingProvider([{
      content: [{ type: 'text', text: 'Plain.' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    }]);
    const { agent, sessionId } = await makeAgent(provider, false);
    const updates: ProgressUpdate[] = [];
    await agent.processMessage(sessionId, 'hi', undefined, async (u) => { updates.push(u); });
    expect(provider.completeStream).not.toHaveBeenCalled();
    expect(updates.some((u) => u.type === 'text_delta')).toBe(false);
  });

  it('resets the draft when a streamed call fails and is retried', async () => {
    let attempt = 0;
    const provider: LLMProvider = {
      name: 'flaky',
      isAvailable: () => true,
      complete: vi.fn(),
      completeStream: vi.fn().mockImplementation(async (_req, handlers: StreamHandlers) => {
        attempt++;
        if (attempt === 1) {
          handlers.onTextDelta?.('Partial');
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }
        handlers.onTextDelta?.('Done right.');
        return { content: [{ type: 'text', text: 'Done right.' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
      }),
    };
    const { agent, sessionId } = await makeAgent(provider);
    (agent as unknown as { getRetryDelay: () => number }).getRetryDelay = () => 1;
    const updates: ProgressUpdate[] = [];
    const result = await agent.processMessage(sessionId, 'go', undefined, async (u) => { updates.push(u); });
    expect(result.response).toBe('Done right.');
    expect(updates.filter((u) => u.type === 'text_delta' || u.type === 'text_reset').map((u) => `${u.type}:${u.message}`))
      .toEqual(['text_delta:Partial', 'text_reset:', 'text_delta:Done right.']);
  });
});
