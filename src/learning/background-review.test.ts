import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider, Message } from '../providers/types.js';
import { defineSkill } from '../skills/sdk.js';
import {
  BACKGROUND_REVIEW_PROMPT,
  BackgroundReviewer,
  appendReviewInstruction,
  createReviewReadFileTool,
  detectUserCorrection,
  reviewToolsFromRegistry,
  type ReviewTool,
} from './background-review.js';

function response(content: ContentBlock[]): CompletionResponse {
  return {
    content,
    stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'mock',
  };
}

function scriptedProvider(steps: ContentBlock[][]): LLMProvider & { complete: ReturnType<typeof vi.fn>; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    isAvailable: () => true,
    requests,
    complete: vi.fn(async (request: CompletionRequest) => {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return response(step);
    }),
  };
}

function memoryTool(calls: Array<Record<string, unknown>>): ReviewTool {
  return {
    definition: { name: 'memory', description: 'core memory', input_schema: { type: 'object', properties: {} } },
    execute: async input => {
      calls.push(input);
      return { success: true, output: 'Added.' };
    },
  };
}

const replayMessages: Message[] = [
  { role: 'user', content: 'deploy the site' },
  { role: 'assistant', content: 'Deployed.' },
];

describe('detectUserCorrection', () => {
  it.each([
    ['No, I meant the staging site', true],
    ["that's wrong, it's port 8080", true],
    ["Don't use npm, use pnpm", true],
    ['I told you to use metric', true],
    ['not what I asked for', true],
    ['you forgot the attachment', true],
    ['Wrong. Use the other account', true],
    ['please stop adding emojis', true],
    ['thanks, that worked', false],
    ['no worries', false],
    ['what is wrong with my code?', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(detectUserCorrection(text)).toBe(expected);
  });
});

describe('BackgroundReviewer triggers', () => {
  it('fires every 10 turns, every 10 tool calls, after compaction and on corrections', () => {
    const reviewer = new BackgroundReviewer({
      getProvider: () => undefined, getReplay: () => null, getTools: () => [], schedule: () => undefined,
    });
    const base = { sessionId: 's', userId: 'u' };
    expect(reviewer.reasonsFor({ ...base, turnCount: 9, toolCallCount: 3 })).toEqual([]);
    expect(reviewer.reasonsFor({ ...base, turnCount: 10, toolCallCount: 3 })).toEqual(['turns']);
    expect(reviewer.reasonsFor({ ...base, turnCount: 2, toolCallCount: 10 })).toEqual(['tool_calls']);
    expect(reviewer.reasonsFor({ ...base, turnCount: 2, toolCallCount: 1, compacted: true })).toEqual(['compaction']);
    expect(reviewer.reasonsFor({ ...base, turnCount: 2, toolCallCount: 1, userCorrection: 'no, I meant Friday' })).toEqual(['user_correction']);
    expect(reviewer.reasonsFor({ ...base, turnCount: 2, toolCallCount: 1, userCorrection: 'great thanks' })).toEqual([]);

    // Counters advance from the last scheduled review.
    expect(reviewer.maybeScheduleReview({ ...base, turnCount: 10, toolCallCount: 4 }).scheduled).toBe(true);
    expect(reviewer.reasonsFor({ ...base, turnCount: 19, toolCallCount: 13 })).toEqual([]);
    expect(reviewer.reasonsFor({ ...base, turnCount: 20, toolCallCount: 14 })).toEqual(['turns', 'tool_calls']);
  });

  it('never blocks: schedules on a later tick and returns immediately', async () => {
    const provider = scriptedProvider([[{ type: 'text', text: 'Nothing to save.' }]]);
    const reviewer = new BackgroundReviewer({
      getProvider: () => provider,
      getReplay: () => ({ system: 'SYS', messages: replayMessages }),
      getTools: () => [memoryTool([])],
    });
    const result = reviewer.maybeScheduleReview({ sessionId: 's', userId: 'u', turnCount: 10, toolCallCount: 0 });
    expect(result).toEqual({ scheduled: true, reasons: ['turns'] });
    expect(provider.complete).not.toHaveBeenCalled();
    await reviewer.idle();
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('is single-flight per session and coalesces triggers into one follow-up run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: LLMProvider = {
      name: 'slow',
      isAvailable: () => true,
      complete: vi.fn(async () => {
        await gate;
        return response([{ type: 'text', text: 'done' }]);
      }),
    };
    const summaries: string[][] = [];
    const reviewer = new BackgroundReviewer({
      getProvider: () => provider,
      getReplay: () => ({ system: 'SYS', messages: replayMessages }),
      getTools: () => [memoryTool([])],
      onComplete: summary => summaries.push(summary.reasons),
    });
    reviewer.maybeScheduleReview({ sessionId: 's', userId: 'u', turnCount: 10, toolCallCount: 0 });
    await new Promise(resolve => setImmediate(resolve));
    expect(reviewer.isRunning('s')).toBe(true);
    reviewer.maybeScheduleReview({ sessionId: 's', userId: 'u', turnCount: 11, toolCallCount: 0, compacted: true });
    reviewer.maybeScheduleReview({ sessionId: 's', userId: 'u', turnCount: 12, toolCallCount: 0, userCorrection: true });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    release();
    await reviewer.idle();
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(summaries).toEqual([['turns'], ['compaction', 'user_correction']]);
  });
});

describe('BackgroundReviewer loop', () => {
  it('replays the session with the same system prompt, runs only review tools, and stops on text', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_use', id: 't1', name: 'memory', input: { action: 'add', block: 'user', content: 'Deploys via CI' } },
       { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'rm -rf /' } }],
      [{ type: 'text', text: 'Added 1 core memory entry.' }],
    ]);
    const reviewer = new BackgroundReviewer({
      getProvider: () => provider,
      getReplay: () => ({ system: { stable: 'STABLE', dynamic: 'DYN' }, messages: replayMessages }),
      getTools: () => [memoryTool(calls)],
    });
    const summary = await reviewer.runReview('s', 'u', ['user_correction']);
    expect(summary.iterations).toBe(2);
    expect(summary.finalText).toBe('Added 1 core memory entry.');
    expect(summary.toolCalls).toEqual([{ name: 'memory', success: true }, { name: 'bash', success: false }]);
    expect(calls).toHaveLength(1);

    const first = provider.requests[0];
    expect(first.system).toEqual({ stable: 'STABLE', dynamic: 'DYN' });
    expect(first.messages.slice(0, 2)).toEqual(replayMessages);
    expect(String(first.messages[2].content)).toContain('Be ACTIVE');
    expect(String(first.messages[2].content)).toContain('user_correction');
    expect(first.tools?.map(tool => tool.name)).toEqual(['memory']);
    const toolResults = provider.requests[1].messages[4].content as ContentBlock[];
    expect(toolResults[1]).toMatchObject({ type: 'tool_result', tool_use_id: 't2', is_error: true });
  });

  it('keeps the session tool list byte-identical when provided (cache) and appends missing review tools', async () => {
    const provider = scriptedProvider([[{ type: 'text', text: 'Nothing to save.' }]]);
    const sessionTools = [{ name: 'bash', description: 'shell', input_schema: { type: 'object' as const, properties: {} } }];
    const reviewer = new BackgroundReviewer({
      getProvider: () => provider,
      getReplay: () => ({ system: 'SYS', messages: replayMessages, tools: sessionTools }),
      getTools: () => [memoryTool([])],
    });
    await reviewer.runReview('s', 'u', ['turns']);
    expect(provider.requests[0].tools?.map(tool => tool.name)).toEqual(['bash', 'memory']);
  });

  it('caps at 16 iterations', async () => {
    const provider = scriptedProvider([[{ type: 'tool_use', id: 'x', name: 'memory', input: {} }]]);
    const reviewer = new BackgroundReviewer({
      getProvider: () => provider,
      getReplay: () => ({ system: 'SYS', messages: replayMessages }),
      getTools: () => [memoryTool([])],
    });
    const summary = await reviewer.runReview('s', 'u', ['turns']);
    expect(summary.iterations).toBe(16);
    expect(provider.complete).toHaveBeenCalledTimes(16);
  });

  it('skips cleanly without provider/replay and reports provider errors', async () => {
    const none = new BackgroundReviewer({ getProvider: () => undefined, getReplay: () => null, getTools: () => [memoryTool([])] });
    expect((await none.runReview('s', 'u', ['turns'])).error).toBe('no_provider');
    const failing: LLMProvider = { name: 'f', isAvailable: () => true, complete: vi.fn().mockRejectedValue(new Error('429')) };
    const reviewer = new BackgroundReviewer({
      getProvider: () => failing,
      getReplay: () => ({ system: 'SYS', messages: replayMessages }),
      getTools: () => [memoryTool([])],
    });
    expect((await reviewer.runReview('s', 'u', ['turns'])).error).toBe('429');
  });

  it('appendReviewInstruction preserves alternation when the replay ends on a user turn', () => {
    const messages = appendReviewInstruction([{ role: 'user', content: 'hi' }], 'REVIEW');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'hi' }, { type: 'text', text: 'REVIEW' }]);
    expect(appendReviewInstruction(replayMessages, 'R')).toHaveLength(3);
    expect(BACKGROUND_REVIEW_PROMPT).toContain('lessons, not logs');
  });
});

describe('review tool adapters', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tools-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('wraps native skills and skips missing ones', async () => {
    const native = defineSkill('memory', 'core').onNativeExecute(async ctx => ({ success: true, output: `user=${ctx.userId} ${JSON.stringify(ctx.args)}` })).build().skill;
    const tools = reviewToolsFromRegistry({ getSkill: name => (name === 'memory' ? native : undefined) }, ['memory', 'session_search'], { workspace: dir });
    expect(tools.map(tool => tool.definition.name)).toEqual(['memory']);
    await expect(tools[0].execute({ a: 1 }, { sessionId: 's', userId: 'u9' })).resolves.toMatchObject({ output: 'user=u9 {"a":1}' });
  });

  it('read_file is confined to its roots', async () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo\nthree');
    const tool = createReviewReadFileTool({ roots: [dir] });
    const ok = await tool.execute({ path: 'notes.md', offset: 2, limit: 1 }, { sessionId: 's', userId: 'u' });
    expect(ok).toMatchObject({ success: true, output: '2|two\n[1 more lines]' });
    expect((await tool.execute({ path: '/etc/hosts' }, { sessionId: 's', userId: 'u' })).success).toBe(false);
    expect((await tool.execute({ path: '../outside' }, { sessionId: 's', userId: 'u' })).success).toBe(false);
  });
});
