import { describe, it, expect, vi } from 'vitest';
import { GoalModeController, GOAL_CONTINUATION_MESSAGE } from '../goals/goal-mode.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function makeChannel(processMessage: ReturnType<typeof vi.fn>, progress: number[] = [1, 1, 1, 1]) {
  const { TelegramChannel } = await import('./telegram.js');
  let turn = 0;
  const goalMode = new GoalModeController({
    runTurn: vi.fn(),
    probe: { snapshot: () => turn, measure: () => ({ successfulToolCalls: progress[turn++] ?? 0 }) },
    sleep: async () => {},
  });
  const channel = Object.create(TelegramChannel.prototype) as any;
  channel.bot = { token: 'test-token', botInfo: { id: 99 } };
  channel.agent = { processMessage };
  channel.goalMode = goalMode;
  channel.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  channel.userSessions = new Map([['42', 'tg-session']]);
  channel.getOrCreateSession = vi.fn().mockResolvedValue('tg-session');
  channel.startTypingIndicator = vi.fn().mockReturnValue(setInterval(() => {}, 60_000));
  channel.buildOnProgress = vi.fn().mockReturnValue(async () => {});
  channel.stopRequests = new Set();
  channel.getProviderForUser = vi.fn().mockReturnValue(undefined);
  channel.sendPendingVoiceAttachments = vi.fn().mockResolvedValue(undefined);
  channel.activeProcessing = new Set();
  channel.userQueues = new Map();
  return { channel, goalMode };
}

const ctx = () => ({ from: { id: 42 }, reply: vi.fn().mockResolvedValue(undefined) }) as any;
const replies = (c: any): string[] => c.reply.mock.calls.map((call: unknown[]) => call[0] as string);

describe('Telegram /goal', () => {
  it('runs the goal on the user session, shows the plan, then the final report', async () => {
    let goal: GoalModeController;
    const processMessage = vi.fn(async (_sid: string, message: string) => {
      if (message === GOAL_CONTINUATION_MESSAGE) goal.complete('tg-session', 'Fixed the bug', ['npm test passes']);
      return { response: message.startsWith('[goal: start]') ? 'Plan: reproduce, fix, test.' : 'Done.', completionReason: 'natural_end', tokenUsage: { inputTokens: 1, outputTokens: 1 }, iterationsUsed: 1 };
    });
    const { channel, goalMode } = await makeChannel(processMessage);
    goal = goalMode;
    const c = ctx();
    await channel.handleGoalCommand(c, '42', 'fix the login bug');

    expect(processMessage.mock.calls[0][0]).toBe('tg-session');
    expect(processMessage.mock.calls[0][1]).toBe('[goal: start] fix the login bug');
    expect(processMessage.mock.calls[1][1]).toBe(GOAL_CONTINUATION_MESSAGE);
    const sent = replies(c);
    expect(sent[0]).toMatch(/^Goal started: fix the login bug/);
    expect(sent[1]).toBe('Plan: reproduce, fix, test.');
    expect(sent.at(-1)).toContain('Goal complete after 2 turns');
    expect(sent.at(-1)).toContain('npm test passes');
    expect(channel.activeProcessing.has('42')).toBe(false);
  });

  it('/stop during a run stops it honestly', async () => {
    let channelRef: any;
    const processMessage = vi.fn(async () => {
      channelRef.stopRequests.add('42');
      return { response: 'Working…', completionReason: 'stopped', tokenUsage: { inputTokens: 1, outputTokens: 1 }, iterationsUsed: 1 };
    });
    const { channel } = await makeChannel(processMessage);
    channelRef = channel;
    const c = ctx();
    await channel.handleGoalCommand(c, '42', 'long task');
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(replies(c).at(-1)).toMatch(/Goal stopped .*It is not marked complete/s);
  });

  it('status / stop / help without a run', async () => {
    const { channel } = await makeChannel(vi.fn());
    const c = ctx();
    await channel.handleGoalCommand(c, '42', 'status');
    await channel.handleGoalCommand(c, '42', 'stop');
    await channel.handleGoalCommand(c, '42', '');
    expect(replies(c)).toEqual([
      'No goal in this conversation. Start one with /goal <objective>.',
      'No goal is running.',
      expect.stringContaining('/goal <objective>'),
    ]);
  });

  it('refuses to start while another message is being processed', async () => {
    const processMessage = vi.fn();
    const { channel } = await makeChannel(processMessage);
    channel.activeProcessing.add('42');
    const c = ctx();
    await channel.handleGoalCommand(c, '42', 'x');
    expect(processMessage).not.toHaveBeenCalled();
    expect(replies(c)[0]).toMatch(/still working/i);
  });
});
