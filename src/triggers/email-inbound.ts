/**
 * Email as an inbound trigger.
 *
 * Polls one IMAP mailbox for new mail (by UID, so nothing is re-processed and
 * flags are never changed):
 * - Mail from EMAIL_ALLOWED_SENDERS becomes an agent turn in that sender's own
 *   session; the agent's answer goes back as a threaded SMTP reply. Sender
 *   authenticity is checked on the receiving server's Authentication-Results
 *   (DMARC or aligned DKIM pass) unless EMAIL_REQUIRE_AUTH=false.
 * - Optionally (EMAIL_NOTIFY=important|all) other new mail produces a short
 *   "new email" note on the owner's primary channel. No LLM reads it.
 *
 * Email-originated turns cannot approve anything: approval prompts only
 * accept a bare "yes"/"no", and these turns always carry an email header.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { FetchMessageObject } from 'imapflow';
import { bareAddress, senderAllowed, type EmailSettings } from '../integrations/email/config.js';
import {
  defaultImapFactory,
  formatAddress,
  parseMessageSource,
  type EmailMessage,
  type ImapClientFactory,
  type ImapClientLike,
} from '../integrations/email/imap.js';
import { buildReply, defaultTransportFactory, sendEmail, type MailTransportFactory } from '../integrations/email/smtp.js';

export type EmailNotifyMode = 'off' | 'important' | 'all';

export interface InboundEmail {
  sender: string;
  subject: string;
  text: string;
  message: EmailMessage;
}

export interface EmailInboundOptions {
  settings: EmailSettings;
  allowedSenders: string[];
  notify: EmailNotifyMode;
  requireAuth: boolean;
  pollIntervalMs: number;
  stateFile: string;
  logger: Logger;
  /** Run one agent turn for an allowlisted email; return the reply text (null = no reply). */
  handleEmail?: (email: InboundEmail) => Promise<string | null>;
  /** Deliver a short notification to the owner's primary channel. */
  notifyOwner?: (text: string) => Promise<unknown>;
  imapFactory?: ImapClientFactory;
  transportFactory?: MailTransportFactory;
  /** Max agent turns per poll; the rest wait for the next poll. Default 5. */
  maxTurnsPerPoll?: number;
}

interface InboundState {
  uidValidity: string;
  lastUid: number;
}

const HEADER_FIELDS = ['authentication-results', 'auto-submitted', 'precedence', 'list-id', 'x-auto-response-suppress'];

/** Unfolded headers in order, names lowercased. */
export function parseHeaderBlock(raw: Buffer | string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const text = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  const headers: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

function domainMatches(candidate: string, senderDomain: string): boolean {
  const domain = candidate.replace(/^@/, '').toLowerCase();
  return domain === senderDomain || senderDomain.endsWith(`.${domain}`) || domain.endsWith(`.${senderDomain}`);
}

/**
 * True when the receiving server's (top-most) Authentication-Results header
 * says DMARC passed for the From domain, or DKIM passed for a domain aligned
 * with it. Lower headers can be forged by the sender, so only the first counts.
 */
export function isAuthenticatedSender(authResults: string | undefined, sender: string): boolean {
  if (!authResults) return false;
  const address = bareAddress(sender);
  const senderDomain = address.slice(address.lastIndexOf('@') + 1);
  if (!senderDomain) return false;
  const clauses = authResults.split(';').map(clause => clause.trim());
  for (const clause of clauses) {
    const dmarc = clause.match(/^dmarc=pass\b/i);
    if (dmarc) {
      const from = clause.match(/header\.from=([^\s;]+)/i)?.[1];
      if (!from || domainMatches(from, senderDomain)) return true;
    }
    if (/^dkim=pass\b/i.test(clause)) {
      const signer = clause.match(/header\.(?:d|i)=@?([^\s;]+)/i)?.[1];
      if (signer && domainMatches(signer.slice(signer.lastIndexOf('@') + 1), senderDomain)) return true;
    }
  }
  return false;
}

/** Auto-replies, bulk and list mail never trigger agent turns (loop guard). */
export function isAutomated(headers: Array<[string, string]>): boolean {
  const get = (name: string) => headers.find(([key]) => key === name)?.[1];
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;
  if (/^(?:bulk|junk|list|auto_reply)$/i.test(get('precedence') ?? '')) return true;
  if (get('list-id')) return true;
  if (get('x-auto-response-suppress')) return true;
  return false;
}

/** Drop the quoted history under "On ... wrote:" / "-----Original Message-----". */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const cut = lines.findIndex((line, index) =>
    /^-{2,}\s*Original Message\s*-{2,}/i.test(line)
    || (/^On .+wrote:\s*$/i.test(line) && lines.slice(index + 1).some(next => next.startsWith('>')))
    || (/^On .+$/i.test(line) && /wrote:\s*$/i.test(lines[index + 1] ?? '')));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter(line => !line.startsWith('>'));
  return kept.join('\n').trim();
}

export function defaultInboundStateFile(): string {
  return join(process.env.SCALLOPBOT_DATA_DIR || join(homedir(), '.scallopbot'), 'email-inbound.json');
}

export class EmailInbound {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = true;
  private readonly imapFactory: ImapClientFactory;
  private readonly transportFactory: MailTransportFactory;

  constructor(private readonly options: EmailInboundOptions) {
    this.imapFactory = options.imapFactory ?? defaultImapFactory;
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      void this.pollOnce()
        .catch(error => this.options.logger.warn({ error: (error as Error).message }, 'Email poll failed'))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.options.pollIntervalMs);
        });
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private loadState(): InboundState | null {
    try {
      if (!existsSync(this.options.stateFile)) return null;
      const parsed = JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as Partial<InboundState>;
      if (typeof parsed.uidValidity === 'string' && typeof parsed.lastUid === 'number') {
        return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid };
      }
    } catch {
      // Unreadable state: re-baseline below.
    }
    return null;
  }

  private saveState(state: InboundState): void {
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.options.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.options.stateFile);
  }

  /** One poll. Returns how many new messages were seen (for tests/logging). */
  async pollOnce(): Promise<number> {
    const imap = this.options.settings.imap;
    if (!imap || this.polling) return 0;
    this.polling = true;
    const client = await this.imapFactory(imap);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.options.settings.mailbox, { readOnly: true });
      try {
        return await this.processMailbox(client);
      } finally {
        lock.release();
      }
    } finally {
      this.polling = false;
      await client.logout().catch(() => undefined);
    }
  }

  private async processMailbox(client: ImapClientLike): Promise<number> {
    const mailbox = client.mailbox;
    if (!mailbox) return 0;
    const uidValidity = String(mailbox.uidValidity);
    const state = this.loadState();
    if (!state || state.uidValidity !== uidValidity) {
      // First run (or the mailbox was rebuilt): start from "now", never from history.
      this.saveState({ uidValidity, lastUid: Math.max(0, mailbox.uidNext - 1) });
      this.options.logger.info({ mailbox: this.options.settings.mailbox }, 'Email inbound baseline set; only new mail will be processed');
      return 0;
    }
    if (mailbox.uidNext - 1 <= state.lastUid) return 0;

    const uids = ((await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || [])
      .filter(uid => uid > state.lastUid)
      .sort((a, b) => a - b)
      .slice(0, 50);
    if (uids.length === 0) return 0;

    const messages = await client.fetchAll(uids.join(','), {
      uid: true,
      envelope: true,
      flags: true,
      labels: true,
      headers: HEADER_FIELDS,
    }, { uid: true });
    messages.sort((a, b) => a.uid - b.uid);

    const self = bareAddress(this.options.settings.from ?? this.options.settings.imap?.user ?? '');
    const maxTurns = this.options.maxTurnsPerPoll ?? 5;
    let turns = 0;
    let lastUid = state.lastUid;
    for (const message of messages) {
      const sender = message.envelope?.from?.[0];
      const senderAddress = (sender?.address ?? '').toLowerCase();
      const wantsTurn = Boolean(this.options.handleEmail)
        && senderAddress !== self
        && senderAllowed(senderAddress, this.options.allowedSenders);
      if (wantsTurn && turns >= maxTurns) break; // leave it for the next poll
      // Advance first: a crash mid-turn must not replay the email (at most once).
      lastUid = Math.max(lastUid, message.uid);
      this.saveState({ uidValidity, lastUid });
      try {
        if (wantsTurn) {
          turns++;
          await this.handleAllowed(client, message, senderAddress);
        } else if (senderAddress !== self) {
          await this.maybeNotify(message);
        }
      } catch (error) {
        this.options.logger.warn({ uid: message.uid, error: (error as Error).message }, 'Failed to process inbound email');
      }
    }
    return messages.length;
  }

  private async handleAllowed(client: ImapClientLike, summary: FetchMessageObject, senderAddress: string): Promise<void> {
    const headers = parseHeaderBlock(summary.headers);
    if (isAutomated(headers)) {
      this.options.logger.info({ uid: summary.uid }, 'Skipping automated email from allowlisted sender');
      return;
    }
    const authResults = headers.find(([name]) => name === 'authentication-results')?.[1];
    if (this.options.requireAuth && !isAuthenticatedSender(authResults, senderAddress)) {
      this.options.logger.warn({ uid: summary.uid, sender: senderAddress }, 'Ignoring email that failed sender authentication (DMARC/DKIM)');
      await this.options.notifyOwner?.(
        `Ignored an email claiming to be from ${senderAddress} ("${summary.envelope?.subject ?? ''}"): it failed sender authentication.`,
      );
      return;
    }
    const full = await client.fetchOne(String(summary.uid), { uid: true, flags: true, source: true }, { uid: true });
    if (!full || !full.source) return;
    const message = await parseMessageSource(full.source, full, 8_000);
    const text = stripQuotedReply(message.text) || message.text;
    const reply = await this.options.handleEmail!({ sender: senderAddress, subject: message.subject, text, message });
    if (!reply?.trim()) return;
    const smtp = this.options.settings.smtp;
    if (!smtp || !this.options.settings.from) {
      this.options.logger.warn('Email reply skipped: SMTP is not configured');
      return;
    }
    const outgoing = buildReply(message, reply, { from: this.options.settings.from, quote: true });
    // Only ever answer the allowlisted sender, never Reply-To redirects or Cc.
    outgoing.to = [senderAddress];
    outgoing.cc = [];
    await sendEmail(smtp, outgoing, this.transportFactory);
    this.options.logger.info({ uid: summary.uid, to: senderAddress }, 'Replied to inbound email');
  }

  private async maybeNotify(message: FetchMessageObject): Promise<void> {
    const mode = this.options.notify;
    if (mode === 'off' || !this.options.notifyOwner) return;
    const important = message.labels?.has('\\Important') || message.flags?.has('\\Flagged');
    if (mode === 'important' && !important) return;
    if (mode === 'all' && isAutomated(parseHeaderBlock(message.headers)) && !important) return;
    const from = message.envelope?.from?.[0];
    const subject = (message.envelope?.subject ?? '(no subject)').replace(/\s+/g, ' ').slice(0, 140);
    await this.options.notifyOwner(`New email from ${from ? formatAddress(from) : 'unknown sender'}: "${subject}"`);
  }
}
