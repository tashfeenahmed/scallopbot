import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { CompletionResponse, LLMProvider, ToolUseContent } from '../providers/types.js';
import {
  APPROVAL_PROMPT_HINT,
  ApprovalStore,
  grantPatternFor,
  hardFloorReason,
  isBareAffirmative,
  isBareNegative,
} from './approvals.js';

const tool = (name: string, input: Record<string, unknown> = {}): ToolUseContent =>
  ({ type: 'tool_use', id: `${name}-1`, name, input });

const notionCreate = tool('notion', {
  action: 'create',
  database_id: '1801c5f6-386c-927e-228b-2a0b29321df0',
  properties: {
    Name: { title: [{ text: { content: 'Leg Press' } }] },
    Sets: { number: 3 },
  },
});

describe('grantPatternFor', () => {
  it('keys typed tools by tool:action', () => {
    expect(grantPatternFor(notionCreate)).toBe('notion:create');
    expect(grantPatternFor(tool('board', { operation: 'Add', title: 'x' }))).toBe('board:add');
    expect(grantPatternFor(tool('write_file', { path: 'a.txt' }))).toBe('write_file');
  });

  it('keys bash/run_code by HTTP method + host of the first URL', () => {
    expect(grantPatternFor(tool('bash', {
      command: 'curl -X POST https://api.notion.com/v1/pages -H "Authorization: Bearer x" -d @body.json',
    }))).toBe('bash:POST api.notion.com');
    expect(grantPatternFor(tool('bash', {
      command: 'curl https://api.notion.com/v1/pages -d \'{"a":1}\'',
    }))).toBe('bash:POST api.notion.com');
    expect(grantPatternFor(tool('run_code', {
      code: 'import requests\nrequests.patch("https://api.notion.com/v1/pages/1", json={})',
    }))).toBe('run_code:PATCH api.notion.com');
    expect(grantPatternFor(tool('bash', { command: 'git push origin main' }))).toBe('bash:git push');
    expect(grantPatternFor(tool('bash', { command: 'mkdir -p out' }))).toBe('bash:mkdir');
  });

  it.each([
    ['rm -rf', tool('bash', { command: 'rm -rf ./build' })],
    ['rm -fr', tool('bash', { command: 'rm -fr /tmp/x' })],
    ['git push --force', tool('bash', { command: 'git push --force origin main' })],
    ['git push -f', tool('bash', { command: 'git push -f' })],
    ['mkfs', tool('bash', { command: 'mkfs.ext4 /dev/sda1' })],
    ['curl DELETE', tool('bash', { command: 'curl -X DELETE https://api.notion.com/v1/blocks/1' })],
    ['requests.delete', tool('run_code', { code: 'requests.delete("https://api.notion.com/v1/blocks/1")' })],
    ['http DELETE method input', tool('http', { method: 'DELETE', url: 'https://x.test/1' })],
    ['send_message to another chat', tool('send_message', { chat_id: '12345', message: 'hi' })],
    ['send_file to another chat', tool('send_file', { to: 'someone', path: 'a.pdf' })],
    ['manage_skills set_key', tool('manage_skills', { action: 'set_key', key: 'NOTION_TOKEN' })],
  ])('never offers a grant pattern for hard floor: %s', (_label, toolUse) => {
    expect(hardFloorReason(toolUse)).toBeTruthy();
    expect(grantPatternFor(toolUse)).toBeNull();
  });

  it('does not floor an ordinary send_message into the active chat or a POST', () => {
    expect(grantPatternFor(tool('send_message', { message: 'progress' }))).toBe('send_message');
    expect(hardFloorReason(tool('bash', { command: 'curl -X POST https://api.notion.com/v1/pages' }))).toBeNull();
  });
});

describe('bare replies', () => {
  it.each(['Yes', 'yes!', 'y', 'ok', 'Sure', 'go ahead', 'Do it', 'Yes please', 'approve',
    '[Replying to You (assistant): "Do you want me to log this?"]\n\nYes'])('affirmative: %j', (text) => {
    expect(isBareAffirmative(text)).toBe(true);
    expect(isBareNegative(text)).toBe(false);
  });

  it.each(['No', 'nope', "don't", 'cancel', 'not now', 'No thanks'])('negative: %j', (text) => {
    expect(isBareNegative(text)).toBe(true);
    expect(isBareAffirmative(text)).toBe(false);
  });

  it.each(['Yes but change the date to yesterday', 'Pectoral machine 45kgx6x3', 'yes and also log squats'])(
    'neither for non-bare text: %j', (text) => {
      expect(isBareAffirmative(text)).toBe(false);
      expect(isBareNegative(text)).toBe(false);
    });
});

describe('ApprovalStore', () => {
  let dir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-approvals-'));
    clock = 1_700_000_000_000;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('grants once/session/always with the right lifetimes', () => {
    const store = new ApprovalStore({ dataDir: dir, now });
    expect(store.has('u1', 's1', 'notion:create')).toBe(false);

    expect(store.grant('u1', 's1', 'notion:create', 'once')).toBe(true);
    expect(store.has('u1', 's1', 'notion:create')).toBe(true);
    expect(store.has('u1', 's2', 'notion:create')).toBe(false);
    store.consumeOnceGrants('s1');
    expect(store.has('u1', 's1', 'notion:create')).toBe(false);

    store.grant('u1', 's1', 'notion:create', 'session');
    store.consumeOnceGrants('s1');
    expect(store.has('u1', 's1', 'notion:create')).toBe(true);
    expect(store.has('u2', 's1', 'notion:create')).toBe(false);
    clock += 24 * 60 * 60 * 1_000 + 1;
    expect(store.has('u1', 's1', 'notion:create')).toBe(false);

    store.grant('u1', 's1', 'notion:create', 'always');
    expect(store.has('u1', 'any-session', 'notion:create')).toBe(true);
    expect(store.has('u2', 'any-session', 'notion:create')).toBe(false);
    expect(store.listAlways('u1')).toEqual([{ pattern: 'notion:create', grantedAt: clock }]);
    expect(store.clearAlways('u1')).toBe(1);
    expect(store.has('u1', 'any-session', 'notion:create')).toBe(false);
  });

  it('never records a grant for a hard-floor (null) pattern', () => {
    const store = new ApprovalStore({ dataDir: dir, now });
    const floor = tool('bash', { command: 'rm -rf /' });
    expect(store.grant('u1', 's1', grantPatternFor(floor), 'always')).toBe(false);
    expect(store.registerPending({
      sessionId: 's1', userId: 'u1', toolUse: floor, question: 'q', description: 'd',
    })).toBeNull();
    expect(store.listAlways('u1')).toEqual([]);
  });

  it('persists always-grants atomically with 0600 and survives a corrupt file', () => {
    const a = new ApprovalStore({ dataDir: dir, now });
    a.grant('u1', 's1', 'notion:create', 'always');
    a.grant('u1', 's1', 'bash:POST api.notion.com', 'always');
    const file = path.join(dir, 'approvals.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 1,
      always: { u1: { 'notion:create': { grantedAt: clock } } },
    });

    const b = new ApprovalStore({ dataDir: dir, now });
    expect(b.has('u1', 'other', 'notion:create')).toBe(true);
    expect(b.listAlways('u1').map(g => g.pattern)).toEqual(['bash:POST api.notion.com', 'notion:create']);

    writeFileSync(file, '{not json');
    const c = new ApprovalStore({ dataDir: dir, now });
    expect(c.listAlways('u1')).toEqual([]);
    c.grant('u1', 's1', 'notion:create', 'always');
    expect(new ApprovalStore({ dataDir: dir, now }).has('u1', 'x', 'notion:create')).toBe(true);
  });

  it('keeps one pending prompt per session, newest wins, and expires it after 10 minutes', () => {
    const store = new ApprovalStore({ dataDir: dir, now });
    const first = store.registerPending({
      sessionId: 's1', userId: 'u1', toolUse: notionCreate, question: 'first?', description: 'first',
    })!;
    expect(first.id).toHaveLength(8);
    expect(first.pattern).toBe('notion:create');
    const second = store.registerPending({
      sessionId: 's1', userId: 'u1', toolUse: tool('notion', { action: 'update' }), question: 'second?', description: 'second',
    })!;
    expect(store.getPending('s1')?.id).toBe(second.id);
    expect(store.findPendingById(first.id)).toBeUndefined();

    clock += 10 * 60 * 1_000;
    expect(store.getPending('s1')).toBeUndefined();
    expect(store.approve(second.id, 'session')).toBeUndefined();
    expect(store.has('u1', 's1', 'notion:update')).toBe(false);
  });

  it('approve grants the pending pattern at the chosen scope; deny records a reason', () => {
    const store = new ApprovalStore({ dataDir: dir, now });
    const pending = store.registerPending({
      sessionId: 's1', userId: 'u1', toolUse: notionCreate, question: 'q?', description: 'd',
    })!;
    expect(store.approve(pending.id, 'session')?.id).toBe(pending.id);
    expect(store.has('u1', 's1', 'notion:create')).toBe(true);
    expect(store.getPending('s1')).toBeUndefined();

    const again = store.registerPending({
      sessionId: 's1', userId: 'u1', toolUse: tool('notion', { action: 'update' }), question: 'q?', description: 'd',
    })!;
    expect(store.deny(again.id, 'wrong entry')?.id).toBe(again.id);
    expect(store.has('u1', 's1', 'notion:update')).toBe(false);
    expect(store.getDenial('s1')).toMatchObject({ pattern: 'notion:update', reason: 'wrong entry' });
  });

  it('treats a typed bare yes/no like a button tap', () => {
    const store = new ApprovalStore({ dataDir: dir, now });
    expect(store.applyTextReply('s1', 'Yes')).toBeNull();

    store.registerPending({ sessionId: 's1', userId: 'u1', toolUse: notionCreate, question: 'q?', description: 'd' });
    expect(store.applyTextReply('s1', 'Pectoral machine 45kgx6x3')).toBeNull();
    expect(store.getPending('s1')).toBeDefined();
    expect(store.applyTextReply('s1', 'Yes')).toBe('granted');
    expect(store.has('u1', 's1', 'notion:create')).toBe(true);

    store.registerPending({ sessionId: 's1', userId: 'u1', toolUse: tool('notion', { action: 'update' }), question: 'q?', description: 'd' });
    expect(store.applyTextReply('s1', 'no')).toBe('denied');
    expect(store.has('u1', 's1', 'notion:update')).toBe(false);
  });
});

describe('Agent approval flow', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-approval-agent-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const gymCall = (id: string): ToolUseContent => ({
    type: 'tool_use',
    id,
    name: 'notion',
    input: {
      action: 'create',
      database_id: '1801c5f6-386c-927e-228b-2a0b29321df0',
      properties: { Name: { title: [{ text: { content: 'Leg Press' } }] }, Sets: { number: 3 } },
    },
  });

  const toolTurn = (toolUse: ToolUseContent): CompletionResponse => ({
    content: [toolUse], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'test',
  });
  const textTurn = (text: string): CompletionResponse => ({
    content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'test',
  });

  async function buildAgent(responses: CompletionResponse[], toolName = 'notion') {
    const { Agent } = await import('./agent.js');
    const { SessionManager } = await import('./session.js');
    const { ScallopDatabase } = await import('../memory/db.js');
    const { createSkillRegistry } = await import('../skills/registry.js');
    const { defineSkill } = await import('../skills/sdk.js');

    const handler = vi.fn().mockResolvedValue({ success: true, output: '{"id":"page-1"}' });
    const registry = createSkillRegistry(path.join(dir, 'skills'), pino({ level: 'silent' }));
    await registry.initialize();
    registry.registerSkill(defineSkill(toolName, `${toolName} integration`).onNativeExecute(handler).build().skill);

    const queue = [...responses];
    const complete = vi.fn(async () => queue.shift() ?? textTurn('(no more scripted responses)'));
    const provider: LLMProvider = { name: 'test', isAvailable: () => true, complete };
    const db = new ScallopDatabase(':memory:');
    const sessions = new SessionManager(db);
    const session = await sessions.createSession({ userId: 'telegram:42', channelId: 'telegram' });
    const approvals = new ApprovalStore({ dataDir: dir });
    const agent = new Agent({
      provider,
      sessionManager: sessions,
      skillRegistry: registry,
      workspace: dir,
      logger: pino({ level: 'silent' }),
      maxIterations: 4,
      approvals,
    });
    return { agent, sessions, session, handler, complete, approvals, db };
  }

  it('returns pendingApproval when the intent gate blocks an unrequested write', async () => {
    const { agent, session, handler, complete, approvals, db } = await buildAgent([
      toolTurn(gymCall('c1')),
      textTurn('Do you want me to log Leg Press to Notion?'),
    ]);
    try {
      const result = await agent.processMessage(session.id, 'What did I do at the gym on Monday?');
      expect(handler).not.toHaveBeenCalled();
      expect(result.pendingApproval).toBeDefined();
      expect(result.pendingApproval!.id).toHaveLength(8);
      expect(result.pendingApproval!.question).toMatch(/^Do you want me to add "/);
      expect(approvals.getPending(session.id)?.id).toBe(result.pendingApproval!.id);

      // The model saw the hint on the tool error so it asks once, not twice.
      const secondCall = complete.mock.calls[1]![0] as { messages: Array<{ content: unknown }> };
      expect(JSON.stringify(secondCall.messages)).toContain(APPROVAL_PROMPT_HINT);
      expect(JSON.stringify(secondCall.messages)).toContain('SAFETY_EXTERNAL_INTENT_REQUIRED');
    } finally {
      db.close();
    }
  });

  it('lets the same call through after a session approval, even on a neutral follow-up', async () => {
    const { agent, session, handler, approvals, db } = await buildAgent([
      toolTurn(gymCall('c1')),
      textTurn('Do you want me to log Leg Press to Notion?'),
      toolTurn(gymCall('c2')),
      textTurn('Logged Leg Press.'),
    ]);
    try {
      const first = await agent.processMessage(session.id, 'What did I do at the gym on Monday?');
      expect(handler).not.toHaveBeenCalled();
      expect(approvals.approve(first.pendingApproval!.id, 'session')).toBeDefined();

      // "Thanks" carries no write intent, so only the grant can let this pass.
      const second = await agent.processMessage(session.id, 'Thanks');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.response).toBe('Logged Leg Press.');
      expect(second.pendingApproval).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('a "once" grant covers exactly one turn', async () => {
    const { agent, session, handler, approvals, db } = await buildAgent([
      toolTurn(gymCall('c1')),
      textTurn('Do you want me to log Leg Press to Notion?'),
      toolTurn(gymCall('c2')),
      textTurn('Logged.'),
      toolTurn(gymCall('c3')),
      textTurn('Do you want me to log it again?'),
    ]);
    try {
      const first = await agent.processMessage(session.id, 'What did I do at the gym on Monday?');
      approvals.approve(first.pendingApproval!.id, 'once');
      await agent.processMessage(session.id, 'Thanks');
      expect(handler).toHaveBeenCalledTimes(1);

      const third = await agent.processMessage(session.id, 'Cool');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(third.pendingApproval).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('a typed bare "yes" grants the pending pattern before the turn runs', async () => {
    const { agent, session, handler, approvals, db } = await buildAgent([
      toolTurn(gymCall('c1')),
      textTurn('Do you want me to log Leg Press to Notion?'),
      toolTurn(gymCall('c2')),
      textTurn('Logged.'),
    ]);
    try {
      const first = await agent.processMessage(session.id, 'What did I do at the gym on Monday?');
      const pattern = approvals.getPending(session.id)!.pattern;
      expect(first.pendingApproval).toBeDefined();

      const second = await agent.processMessage(session.id, 'Yes');
      expect(approvals.has('telegram:42', session.id, pattern)).toBe(true);
      expect(approvals.getPending(session.id)).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.response).toBe('Logged.');
    } finally {
      db.close();
    }
  });

  it('never offers an approval for a hard-floor call', async () => {
    const { agent, session, handler, approvals, db } = await buildAgent([
      toolTurn({ type: 'tool_use', id: 'd1', name: 'bash', input: { command: 'curl -X DELETE https://api.notion.com/v1/blocks/abc' } }),
      textTurn('I cannot delete that.'),
    ], 'bash');
    try {
      // Unrequested destructive call: the gate blocks it and no buttons are offered.
      const result = await agent.processMessage(session.id, 'What is in my Notion tracker?');
      expect(handler).not.toHaveBeenCalled();
      expect(result.pendingApproval).toBeUndefined();
      expect(approvals.getPending(session.id)).toBeUndefined();
      // Even an explicit grant attempt records nothing.
      expect(approvals.grant('telegram:42', session.id, grantPatternFor({
        type: 'tool_use', id: 'x', name: 'bash', input: { command: 'curl -X DELETE https://api.notion.com/v1/blocks/abc' },
      }), 'always')).toBe(false);
    } finally {
      db.close();
    }
  });
});
