import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeEmail } from '../../../../integrations/email/actions.js';
import { loadEmailSettings, senderAllowed, parseAllowedSenders } from '../../../../integrations/email/config.js';
import { FakeImap, capturingTransport, fakeImapFactory, type CapturedMail } from '../../../../integrations/email/testing.js';
import { parseFrontmatter } from '../../../parser.js';
import { assessToolCallForTurn } from '../../../../agent/tool-safety.js';
import { ApprovalStore, grantPatternFor } from '../../../../agent/approvals.js';
import type { Skill } from '../../../types.js';
import type { ToolUseContent } from '../../../../providers/types.js';

const settings = loadEmailSettings({
  EMAIL_IMAP_HOST: 'imap.gmail.com',
  EMAIL_IMAP_USER: 'me@example.com',
  EMAIL_IMAP_PASS: 'app-password',
  EMAIL_FROM: 'Me <me@example.com>',
});

function inbox(): FakeImap {
  return new FakeImap([
    { uid: 10, from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Lunch?', body: 'Lunch on Thursday?', flags: ['\\Seen'] },
    { uid: 11, from: { address: 'billing@shop.example' }, subject: 'Your invoice', body: 'Invoice #42 attached', flags: [] },
    {
      uid: 12,
      from: { name: 'Bob', address: 'bob@example.com' },
      to: [{ address: 'me@example.com' }, { name: 'Carol', address: 'carol@example.com' }],
      subject: 'Project plan',
      body: 'Can you review the plan by Friday?\n\nThanks, Bob',
      messageId: '<plan-1@example.com>',
      flags: ['\\Flagged'],
    },
  ]);
}

describe('email settings', () => {
  it('derives Gmail SMTP from the IMAP host and reuses the app password', () => {
    expect(settings.imap).toMatchObject({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(settings.smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'me@example.com', pass: 'app-password' });
  });

  it('uses STARTTLS on 587', () => {
    const custom = loadEmailSettings({
      EMAIL_SMTP_HOST: 'mail.example.org', EMAIL_SMTP_PORT: '587', EMAIL_SMTP_USER: 'u', EMAIL_SMTP_PASS: 'p',
    });
    expect(custom.imap).toBeNull();
    expect(custom.smtp).toMatchObject({ host: 'mail.example.org', port: 587, secure: false });
    expect(custom.from).toBe('u');
  });

  it('matches allowlisted addresses and domains only', () => {
    const allow = parseAllowedSenders('Boss@Example.com, @family.org');
    expect(senderAllowed('boss@example.com', allow)).toBe(true);
    expect(senderAllowed('"Boss" <BOSS@example.com>', allow)).toBe(true);
    expect(senderAllowed('kid@family.org', allow)).toBe(true);
    expect(senderAllowed('kid@evil-family.org', allow)).toBe(false);
    expect(senderAllowed('boss@example.com.evil.net', allow)).toBe(false);
  });
});

describe('email skill actions (fake IMAP/SMTP)', () => {
  it('lists newest first without touching flags', async () => {
    const imap = inbox();
    const result = await executeEmail({ action: 'list', limit: 2 }, { settings, imapFactory: fakeImapFactory(imap) }) as any;
    expect(result.messages.map((m: any) => m.uid)).toEqual([12, 11]);
    expect(result.messages[0]).toMatchObject({ from: 'Bob <bob@example.com>', subject: 'Project plan', unread: true, flagged: true });
    expect(imap.loggedOut).toBe(true);
    expect(imap.locks).toEqual(['INBOX']);
  });

  it('lists unread only', async () => {
    const result = await executeEmail({ action: 'list', unread_only: true }, { settings, imapFactory: fakeImapFactory(inbox()) }) as any;
    expect(result.messages.map((m: any) => m.uid)).toEqual([12, 11]);
  });

  it('uses Gmail raw search on Gmail', async () => {
    const imap = inbox();
    const result = await executeEmail({ action: 'search', query: 'invoice' }, { settings, imapFactory: fakeImapFactory(imap) }) as any;
    expect(imap.searches[0]).toEqual({ gmraw: 'invoice' });
    expect(result.messages.map((m: any) => m.uid)).toEqual([11]);
  });

  it('reads a message body and marks it untrusted', async () => {
    const result = await executeEmail({ action: 'read', uid: 12 }, { settings, imapFactory: fakeImapFactory(inbox()) }) as any;
    expect(result.note).toMatch(/untrusted/);
    expect(result.message).toMatchObject({
      uid: 12,
      subject: 'Project plan',
      messageId: '<plan-1@example.com>',
      text: 'Can you review the plan by Friday?\n\nThanks, Bob',
    });
    expect(result.message.to).toEqual(['me@example.com', 'Carol <carol@example.com>']);
  });

  it('errors clearly for an unknown uid', async () => {
    await expect(executeEmail({ action: 'read', uid: 99 }, { settings, imapFactory: fakeImapFactory(inbox()) }))
      .rejects.toThrow(/No message with uid 99/);
  });

  it('sends a plain-text email', async () => {
    const sent: CapturedMail[] = [];
    const result = await executeEmail(
      { action: 'send', to: 'alice@example.com, dave@example.com', subject: 'Hi', body: 'Hello there' },
      { settings, transportFactory: capturingTransport(sent) },
    ) as any;
    expect(result).toMatchObject({ sent: true, accepted: ['alice@example.com', 'dave@example.com'] });
    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toMatch(/^From: Me <me@example.com>$/m);
    expect(sent[0].raw).toMatch(/^To: alice@example.com, dave@example.com$/m);
    expect(sent[0].raw).toMatch(/^Subject: Hi$/m);
    expect(sent[0].raw).toContain('Hello there');
  });

  it('rejects invalid recipients before connecting', async () => {
    const sent: CapturedMail[] = [];
    await expect(executeEmail({ action: 'send', to: 'not-an-address', subject: 'x', body: 'y' },
      { settings, transportFactory: capturingTransport(sent) })).rejects.toThrow(/Invalid email address/);
    expect(sent).toHaveLength(0);
  });

  it('replies in-thread with quoted original; reply_all keeps Cc minus self', async () => {
    const sent: CapturedMail[] = [];
    const result = await executeEmail(
      { action: 'reply', uid: 12, body: 'Looks good.', reply_all: true },
      { settings, imapFactory: fakeImapFactory(inbox()), transportFactory: capturingTransport(sent) },
    ) as any;
    expect(result).toMatchObject({ sent: true, to: ['Bob <bob@example.com>'], cc: ['Carol <carol@example.com>'], subject: 'Re: Project plan' });
    const raw = sent[0].raw;
    expect(raw).toMatch(/^In-Reply-To: <plan-1@example.com>$/m);
    expect(raw).toMatch(/^References: <plan-1@example.com>$/m);
    expect(raw).toContain('> Can you review the plan by Friday?');
    expect(raw).not.toMatch(/^Cc:.*me@example.com/m);
  });
});

describe('email send approval', () => {
  const skill = {
    name: 'email',
    frontmatter: parseFrontmatter(readFileSync(join(__dirname, '..', 'SKILL.md'), 'utf8')).frontmatter,
  } as unknown as Skill;
  const send = (body = 'See you at 3'): ToolUseContent => ({
    type: 'tool_use', id: 'e1', name: 'email',
    input: { action: 'send', to: 'alice@example.com', subject: 'Meeting', body },
  });
  const turn = { userMessage: 'Email Alice that I will see her at 3', timezone: 'UTC' };
  let previous: string | undefined;
  beforeEach(() => { previous = process.env.EMAIL_SEND_WITHOUT_APPROVAL; delete process.env.EMAIL_SEND_WITHOUT_APPROVAL; });
  afterEach(() => {
    if (previous === undefined) delete process.env.EMAIL_SEND_WITHOUT_APPROVAL;
    else process.env.EMAIL_SEND_WITHOUT_APPROVAL = previous;
  });

  it('declares send/reply as owner-confirmed in SKILL.md', () => {
    expect(skill.frontmatter.metadata?.openclaw?.safety?.confirmActions).toEqual(['send', 'reply']);
    expect(skill.frontmatter.metadata?.openclaw?.requires?.anyEnv).toContain('EMAIL_IMAP_HOST');
  });

  it('blocks a send even when the user asked for it, and leaves reads alone', () => {
    const verdict = assessToolCallForTurn(send(), turn, skill);
    expect(verdict.allowed).toBe(false);
    expect(verdict.isExternalMutation).toBe(true);
    expect(verdict.reason).toMatch(/always needs the owner's explicit approval/);
    const read = assessToolCallForTurn({ type: 'tool_use', id: 'r', name: 'email', input: { action: 'list' } }, turn, skill);
    expect(read.allowed).toBe(true);
  });

  it('a "yes" approves exactly that email, not a different body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'email-approval-'));
    try {
      const store = new ApprovalStore({ dataDir: dir });
      const pending = store.registerPending({ sessionId: 's', userId: 'u', toolUse: send(), question: 'q', description: 'd' });
      expect(pending?.pattern).toMatch(/^email:send#[0-9a-f]{12}$/);
      expect(store.applyTextReply('s', 'yes')).toBe('granted');
      const grants = (pattern: string) => store.has('u', 's', pattern);
      expect(assessToolCallForTurn(send(), { ...turn, userMessage: 'yes', grants }, skill).allowed).toBe(true);
      expect(assessToolCallForTurn(send('Something else entirely'), { ...turn, userMessage: 'yes', grants }, skill).allowed).toBe(false);
      expect(grantPatternFor(send())).not.toBe(grantPatternFor(send('Something else entirely')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a typed email-channel message can never answer an approval prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'email-approval-'));
    try {
      const store = new ApprovalStore({ dataDir: dir });
      store.registerPending({ sessionId: 's', userId: 'u', toolUse: send(), question: 'q', description: 'd' });
      expect(store.applyTextReply('s', '[Email from bob@example.com. Your reply is sent back to them by email as plain text.]\nSubject: Re: x\n\nyes')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EMAIL_SEND_WITHOUT_APPROVAL=true falls back to the normal intent gate', () => {
    process.env.EMAIL_SEND_WITHOUT_APPROVAL = 'true';
    expect(assessToolCallForTurn(send(), turn, skill).allowed).toBe(true);
    // ...which still blocks a send nobody asked for.
    expect(assessToolCallForTurn(send(), { userMessage: 'what is on my plate today?', timezone: 'UTC' }, skill).allowed).toBe(false);
  });
});
