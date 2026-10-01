/**
 * Test doubles for IMAP/SMTP (no network). Used by the email skill and the
 * inbound trigger tests.
 */
import nodemailer from 'nodemailer';
import type { FetchMessageObject, FetchQueryObject, MailboxObject, SearchObject } from 'imapflow';
import type { ImapClientFactory, ImapClientLike } from './imap.js';
import type { MailTransportFactory } from './smtp.js';

export interface FakeMessage {
  uid: number;
  from: { name?: string; address: string };
  to?: Array<{ name?: string; address: string }>;
  subject: string;
  body: string;
  date?: string;
  messageId?: string;
  flags?: string[];
  labels?: string[];
  headers?: Record<string, string>;
}

export function rawMessage(message: FakeMessage): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(message.headers ?? {})) lines.push(`${name}: ${value}`);
  const fmt = (entry: { name?: string; address: string }) => entry.name ? `"${entry.name}" <${entry.address}>` : entry.address;
  lines.push(`From: ${fmt(message.from)}`);
  lines.push(`To: ${(message.to ?? [{ address: 'me@example.com' }]).map(fmt).join(', ')}`);
  lines.push(`Subject: ${message.subject}`);
  lines.push(`Date: ${new Date(message.date ?? '2026-10-01T09:00:00Z').toUTCString()}`);
  lines.push(`Message-ID: ${message.messageId ?? `<m${message.uid}@example.com>`}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(message.body);
  return lines.join('\r\n');
}

function headerBlock(message: FakeMessage, fields: string[] | boolean | undefined): Buffer | undefined {
  if (!fields) return undefined;
  const wanted = Array.isArray(fields) ? fields.map(f => f.toLowerCase()) : null;
  const lines = Object.entries(message.headers ?? {})
    .filter(([name]) => !wanted || wanted.includes(name.toLowerCase()))
    .map(([name, value]) => `${name}: ${value}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);
}

export class FakeImap implements ImapClientLike {
  mailbox: MailboxObject | false = false;
  connected = false;
  loggedOut = false;
  locks: string[] = [];
  searches: SearchObject[] = [];

  constructor(public messages: FakeMessage[], public uidValidity = 1n) {}

  get uidNext(): number {
    return Math.max(0, ...this.messages.map(m => m.uid)) + 1;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.locks.push(path);
    this.mailbox = { path, uidValidity: this.uidValidity, uidNext: this.uidNext, exists: this.messages.length } as MailboxObject;
    return { release: () => undefined };
  }

  private matches(message: FakeMessage, query: SearchObject): boolean {
    if (query.seen === false && (message.flags ?? []).includes('\\Seen')) return false;
    if (query.uid) {
      const [lo, hi] = String(query.uid).split(':');
      const max = hi === '*' ? Infinity : Number(hi ?? lo);
      // IMAP quirk: "N:*" always includes the highest uid even when < N.
      if (hi === '*' && message.uid === this.uidNext - 1) return true;
      if (message.uid < Number(lo) || message.uid > max) return false;
    }
    const haystack = `${message.from.address} ${message.subject} ${message.body}`.toLowerCase();
    for (const key of ['text', 'gmraw', 'subject', 'from'] as const) {
      const value = query[key];
      if (typeof value === 'string' && !haystack.includes(value.toLowerCase())) return false;
    }
    return true;
  }

  async search(query: SearchObject): Promise<number[]> {
    this.searches.push(query);
    return this.messages.filter(m => this.matches(m, query)).map(m => m.uid);
  }

  private toFetchObject(message: FakeMessage, query: FetchQueryObject): FetchMessageObject {
    const result: FetchMessageObject = { seq: message.uid, uid: message.uid };
    if (query.flags) result.flags = new Set(message.flags ?? []);
    if (query.labels) result.labels = new Set(message.labels ?? []);
    if (query.envelope) {
      result.envelope = {
        date: new Date(message.date ?? '2026-10-01T09:00:00Z'),
        subject: message.subject,
        messageId: message.messageId ?? `<m${message.uid}@example.com>`,
        from: [message.from],
        to: message.to ?? [{ address: 'me@example.com' }],
      };
    }
    if (query.headers) result.headers = headerBlock(message, query.headers);
    if (query.source) result.source = Buffer.from(rawMessage(message));
    return result;
  }

  async fetchAll(range: string, query: FetchQueryObject): Promise<FetchMessageObject[]> {
    const uids = new Set(range.split(',').map(Number));
    return this.messages.filter(m => uids.has(m.uid)).map(m => this.toFetchObject(m, query));
  }

  async fetchOne(range: string, query: FetchQueryObject): Promise<FetchMessageObject | false> {
    const message = this.messages.find(m => m.uid === Number(range));
    return message ? this.toFetchObject(message, query) : false;
  }

  async list() {
    return [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
    ] as unknown as Awaited<ReturnType<ImapClientLike['list']>>;
  }
}

export function fakeImapFactory(imap: FakeImap): ImapClientFactory {
  return async () => imap;
}

export interface CapturedMail {
  options: Record<string, unknown>;
  raw: string;
}

/** Real nodemailer message composition, captured instead of sent. */
export function capturingTransport(sent: CapturedMail[]): MailTransportFactory {
  return async () => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return {
      async sendMail(options: Record<string, unknown>) {
        const info = await stream.sendMail(options);
        sent.push({ options, raw: (info.message as Buffer).toString('utf8') });
        return { messageId: info.messageId, accepted: info.envelope.to, rejected: [] };
      },
    };
  };
}
