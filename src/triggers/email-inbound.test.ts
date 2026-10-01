import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { loadEmailSettings } from '../integrations/email/config.js';
import { FakeImap, capturingTransport, fakeImapFactory, type CapturedMail, type FakeMessage } from '../integrations/email/testing.js';
import {
  EmailInbound,
  isAuthenticatedSender,
  isAutomated,
  parseHeaderBlock,
  stripQuotedReply,
  type EmailInboundOptions,
} from './email-inbound.js';
import { createAgentEmailHandler, emailSessionId, inboundEmailPrompt, startMailAndCalendarTriggers } from './mail-calendar.js';

const settings = loadEmailSettings({
  EMAIL_IMAP_HOST: 'imap.gmail.com',
  EMAIL_IMAP_USER: 'bot@example.com',
  EMAIL_IMAP_PASS: 'pw',
});
const logger = pino({ level: 'silent' });
const GMAIL_PASS = 'mx.google.com; dkim=pass header.i=@boss.com header.s=s1; spf=pass smtp.mailfrom=owner@boss.com; dmarc=pass (p=REJECT) header.from=boss.com';

function mail(uid: number, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    uid,
    from: { name: 'Owner', address: 'owner@boss.com' },
    to: [{ address: 'bot@example.com' }],
    subject: `Message ${uid}`,
    body: `What is on my calendar tomorrow? (${uid})`,
    headers: { 'Authentication-Results': GMAIL_PASS },
    ...overrides,
  };
}

describe('sender authentication', () => {
  it('accepts DMARC pass or aligned DKIM pass, nothing else', () => {
    expect(isAuthenticatedSender(GMAIL_PASS, 'owner@boss.com')).toBe(true);
    expect(isAuthenticatedSender('mx.google.com; dkim=pass header.i=@mail.boss.com', 'owner@boss.com')).toBe(true);
    expect(isAuthenticatedSender('mx.google.com; dkim=pass header.i=@evil.com; spf=pass', 'owner@boss.com')).toBe(false);
    expect(isAuthenticatedSender('mx.google.com; dkim=fail; spf=softfail; dmarc=fail header.from=boss.com', 'owner@boss.com')).toBe(false);
    expect(isAuthenticatedSender('mx.google.com; dmarc=pass header.from=evil.com', 'owner@boss.com')).toBe(false);
    expect(isAuthenticatedSender(undefined, 'owner@boss.com')).toBe(false);
  });

  it('only trusts the top-most Authentication-Results header', () => {
    const headers = parseHeaderBlock(
      'Authentication-Results: mx.google.com;\r\n dkim=fail;\r\n dmarc=fail header.from=boss.com\r\nAuthentication-Results: forged; dmarc=pass header.from=boss.com\r\n',
    );
    const first = headers.find(([name]) => name === 'authentication-results')?.[1];
    expect(first).toBe('mx.google.com; dkim=fail; dmarc=fail header.from=boss.com');
    expect(isAuthenticatedSender(first, 'owner@boss.com')).toBe(false);
  });

  it('flags automated mail', () => {
    expect(isAutomated([['auto-submitted', 'auto-replied']])).toBe(true);
    expect(isAutomated([['auto-submitted', 'no']])).toBe(false);
    expect(isAutomated([['precedence', 'bulk']])).toBe(true);
    expect(isAutomated([['list-id', '<news.example.com>']])).toBe(true);
    expect(isAutomated([])).toBe(false);
  });

  it('strips quoted history', () => {
    expect(stripQuotedReply('Yes please.\n\nOn Tue, 1 Oct 2026 at 10:00, Bot <bot@example.com> wrote:\n> Shall I book it?')).toBe('Yes please.');
    expect(stripQuotedReply('Fine\n-----Original Message-----\nFrom: x')).toBe('Fine');
    expect(stripQuotedReply('no quotes here')).toBe('no quotes here');
  });
});

describe('EmailInbound polling', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'email-inbound-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function inbound(imap: FakeImap, overrides: Partial<EmailInboundOptions> = {}) {
    const sent: CapturedMail[] = [];
    const handleEmail = vi.fn(async ({ text }: { text: string }) => `Answer to: ${text}`);
    const notifyOwner = vi.fn(async () => true);
    const trigger = new EmailInbound({
      settings,
      allowedSenders: ['owner@boss.com'],
      notify: 'important',
      requireAuth: true,
      pollIntervalMs: 60_000,
      stateFile: join(dir, 'state.json'),
      logger,
      handleEmail,
      notifyOwner,
      imapFactory: fakeImapFactory(imap),
      transportFactory: capturingTransport(sent),
      ...overrides,
    });
    return { trigger, sent, handleEmail, notifyOwner };
  }

  it('baselines on first run and never processes old mail', async () => {
    const imap = new FakeImap([mail(1), mail(2)]);
    const { trigger, handleEmail } = inbound(imap);
    expect(await trigger.pollOnce()).toBe(0);
    expect(await trigger.pollOnce()).toBe(0);
    expect(handleEmail).not.toHaveBeenCalled();
    expect(imap.loggedOut).toBe(true);
  });

  it('turns new allowlisted mail into one agent turn and replies in-thread to the sender only', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail, sent } = inbound(imap);
    await trigger.pollOnce();
    imap.messages.push(mail(2, {
      messageId: '<q2@boss.com>',
      body: 'Book a table for two.\n\nOn Mon, someone wrote:\n> old stuff',
      headers: { 'Authentication-Results': GMAIL_PASS, 'Reply-To': 'attacker@evil.com' },
      to: [{ address: 'bot@example.com' }, { address: 'friend@example.com' }],
    }));
    expect(await trigger.pollOnce()).toBe(1);
    expect(handleEmail).toHaveBeenCalledTimes(1);
    expect(handleEmail.mock.calls[0][0]).toMatchObject({ sender: 'owner@boss.com', subject: 'Message 2', text: 'Book a table for two.' });
    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toMatch(/^To: owner@boss.com$/m);
    expect(sent[0].raw).not.toMatch(/^Cc:/m);
    expect(sent[0].raw).not.toContain('attacker@evil.com');
    expect(sent[0].raw).toMatch(/^In-Reply-To: <q2@boss.com>$/m);
    expect(sent[0].raw).toMatch(/^Subject: Re: Message 2$/m);
    // Processed exactly once.
    expect(await trigger.pollOnce()).toBe(0);
    expect(handleEmail).toHaveBeenCalledTimes(1);
  });

  it('ignores senders outside the allowlist (no agent turn, no reply)', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail, sent, notifyOwner } = inbound(imap);
    await trigger.pollOnce();
    imap.messages.push(mail(2, { from: { address: 'stranger@example.net' }, headers: { 'Authentication-Results': 'x; dmarc=pass header.from=example.net' } }));
    await trigger.pollOnce();
    expect(handleEmail).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(notifyOwner).not.toHaveBeenCalled(); // not important
  });

  it('refuses spoofed allowlisted senders and tells the owner', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail, sent, notifyOwner } = inbound(imap);
    await trigger.pollOnce();
    imap.messages.push(mail(2, { headers: { 'Authentication-Results': 'mx.google.com; dkim=none; spf=fail; dmarc=fail header.from=boss.com' } }));
    await trigger.pollOnce();
    expect(handleEmail).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringMatching(/failed sender authentication/));
  });

  it('does not answer auto-replies from allowlisted senders (mail loop guard)', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail } = inbound(imap);
    await trigger.pollOnce();
    imap.messages.push(mail(2, { headers: { 'Authentication-Results': GMAIL_PASS, 'Auto-Submitted': 'auto-replied' } }));
    await trigger.pollOnce();
    expect(handleEmail).not.toHaveBeenCalled();
  });

  it('notifies the owner about important mail from anyone else, without an LLM', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, notifyOwner, handleEmail } = inbound(imap, { allowedSenders: [] , handleEmail: undefined });
    await trigger.pollOnce();
    imap.messages.push(
      mail(2, { from: { name: 'Bank', address: 'alerts@bank.example' }, subject: 'Card payment', labels: ['\\Important'] }),
      mail(3, { from: { address: 'news@shop.example' }, subject: 'Sale!' }),
    );
    await trigger.pollOnce();
    expect(handleEmail).not.toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith('New email from Bank <alerts@bank.example>: "Card payment"');
  });

  it('caps agent turns per poll and picks the rest up next time', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail } = inbound(imap, { maxTurnsPerPoll: 2 });
    await trigger.pollOnce();
    imap.messages.push(mail(2), mail(3), mail(4));
    await trigger.pollOnce();
    expect(handleEmail).toHaveBeenCalledTimes(2);
    await trigger.pollOnce();
    expect(handleEmail).toHaveBeenCalledTimes(3);
  });

  it('re-baselines when UIDVALIDITY changes', async () => {
    const imap = new FakeImap([mail(1)]);
    const { trigger, handleEmail } = inbound(imap);
    await trigger.pollOnce();
    imap.uidValidity = 2n;
    imap.messages.push(mail(2));
    expect(await trigger.pollOnce()).toBe(0);
    expect(handleEmail).not.toHaveBeenCalled();
  });
});

describe('agent wiring', () => {
  it('runs each sender in its own email session and never forwards approval to email', async () => {
    const sessions = new Map<string, unknown>();
    const sessionManager = {
      getSession: vi.fn(async (id: string) => sessions.get(id)),
      createSession: vi.fn(async (meta: { id: string }) => { sessions.set(meta.id, meta); return meta; }),
    };
    const agent = {
      processMessage: vi.fn(async () => ({ response: 'Drafted it.', pendingApproval: { id: 'a', question: 'q' } })),
    };
    const handler = createAgentEmailHandler(agent as any, sessionManager as any);
    const email = { sender: 'owner@boss.com', subject: 'Hi', text: 'yes', message: {} as any };
    const reply = await handler(email);
    expect(sessionManager.createSession).toHaveBeenCalledWith({ id: emailSessionId('owner@boss.com'), userId: 'email:owner@boss.com', channelId: 'email' });
    expect(agent.processMessage).toHaveBeenCalledWith(emailSessionId('owner@boss.com'), inboundEmailPrompt(email));
    expect(inboundEmailPrompt(email)).toMatch(/^\[Email from owner@boss.com/);
    expect(reply).toMatch(/can't be given by email/);
    await handler(email);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('starts nothing unless configured', () => {
    expect(startMailAndCalendarTriggers({
      agent: {} as any, sessionManager: {} as any, logger, notifyOwner: async () => true, ownerTimeZone: () => 'UTC', env: {},
    })).toBeNull();
  });
});
