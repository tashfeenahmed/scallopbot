import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from 'pino';
import { ApiChannel } from './api.js';
import { GoalModeController, GOAL_CONTINUATION_MESSAGE } from '../goals/goal-mode.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;

function setup() {
  let goalMode!: GoalModeController;
  const processMessage = vi.fn(async (_sid: string, message: string) => {
    if (message === GOAL_CONTINUATION_MESSAGE) goalMode.complete('web-session', 'Shipped', ['build green']);
    return { response: message.startsWith('[goal: start]') ? 'Turn one.' : 'Turn two.', completionReason: 'natural_end' };
  });
  goalMode = new GoalModeController({
    runTurn: (sid, msg, shouldStop) => processMessage(sid, msg, undefined, undefined, shouldStop) as never,
    probe: { snapshot: () => 0, measure: () => ({ successfulToolCalls: 1 }) },
    sleep: async () => {},
  });
  const sessionManager = {
    createSession: vi.fn().mockResolvedValue({ id: 'web-session', messages: [], createdAt: new Date(), updatedAt: new Date() }),
    getSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionManager;
  const channel = new ApiChannel({
    port: 0,
    agent: { processMessage } as unknown as Agent,
    sessionManager,
    logger,
    goalMode,
  });
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket;
  return { channel: channel as any, ws, sent, processMessage, goalMode };
}

describe('web /goal', () => {
  it('streams every turn, then the final report', async () => {
    const { channel, ws, sent, goalMode } = setup();
    expect(await channel.handleSlashCommand(ws, 'c1', '/goal ship the release')).toBe(true);
    await vi.waitFor(() => expect(goalMode.status('web-session')?.status).toBe('completed'));
    await vi.waitFor(() => expect(sent.at(-1)?.content).toMatch(/Goal complete after 2 turns/));
    expect(sent.map(m => m.content)).toEqual([
      'Goal started: ship the release',
      'Turn one.',
      expect.stringContaining('Evidence:\n- build green'),
    ]);
    expect(channel.activeProcessing.has('c1')).toBe(false);
  });

  it('/goal status and /goal stop', async () => {
    const { channel, ws, sent } = setup();
    await channel.handleSlashCommand(ws, 'c1', '/goal status');
    await channel.handleSlashCommand(ws, 'c1', '/goal stop');
    expect(sent.map(m => m.content)).toEqual([
      'No goal in this conversation. Start one with /goal <objective>.',
      'No goal is running.',
    ]);
  });
});
