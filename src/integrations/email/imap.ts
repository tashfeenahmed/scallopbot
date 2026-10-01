/**
 * IMAP reads: list, search, read, mailboxes.
 *
 * The client is created through an injectable factory so tests run against a
 * fake; production uses imapflow. Message bodies are fetched with BODY.PEEK,
 * so reading never marks mail as seen.
 */
import { simpleParser, type AddressObject } from 'mailparser';
import type {
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  MailboxObject,
  MessageAddressObject,
  SearchObject,
} from 'imapflow';
import type { MailServerSettings } from './config.js';

/** The subset of imapflow's ImapFlow this module uses. */
export interface ImapClientLike {
  mailbox: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined>;
  list(): Promise<ListResponse[]>;
}

export type ImapClientFactory = (settings: MailServerSettings) => Promise<ImapClientLike>;

export const defaultImapFactory: ImapClientFactory = async (settings) => {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    logger: false,
  }) as unknown as ImapClientLike;
};

export interface EmailSummary {
  uid: number;
  date: string | null;
  from: string;
  to: string[];
  subject: string;
  unread: boolean;
  flagged: boolean;
  important?: boolean;
}

export interface EmailMessage extends EmailSummary {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  replyTo: string[];
  cc: string[];
  text: string;
  truncated: boolean;
  attachments: Array<{ filename: string | null; contentType: string; size: number }>;
}

const SUMMARY_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, internalDate: true };

export function formatAddress(entry: { name?: string; address?: string }): string {
  const address = entry.address ?? '';
  return entry.name && entry.name !== address ? `${entry.name} <${address}>` : address;
}

function envelopeList(list: MessageAddressObject[] | undefined): string[] {
  return (list ?? []).map(formatAddress).filter(Boolean);
}

function dateString(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function summarize(message: FetchMessageObject): EmailSummary {
  const envelope = message.envelope ?? {};
  const flags = message.flags ?? new Set<string>();
  const summary: EmailSummary = {
    uid: message.uid,
    date: dateString(envelope.date ?? message.internalDate),
    from: envelopeList(envelope.from)[0] ?? '',
    to: envelopeList(envelope.to),
    subject: envelope.subject ?? '',
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
  };
  if (message.labels) summary.important = message.labels.has('\\Important');
  return summary;
}

/** Open a connection, lock a mailbox, run `fn`, always release and log out. */
export async function withMailbox<T>(
  settings: MailServerSettings,
  mailbox: string,
  fn: (client: ImapClientLike) => Promise<T>,
  factory: ImapClientFactory = defaultImapFactory,
): Promise<T> {
  const client = await factory(settings);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function fetchSummaries(client: ImapClientLike, uids: number[], limit: number): Promise<EmailSummary[]> {
  const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
  if (newest.length === 0) return [];
  const messages = await client.fetchAll(newest.join(','), SUMMARY_QUERY, { uid: true });
  return messages.map(summarize).sort((a, b) => b.uid - a.uid);
}

export interface ListOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export async function listMessages(client: ImapClientLike, options: ListOptions = {}): Promise<EmailSummary[]> {
  const limit = clampLimit(options.limit);
  const uids = await client.search(options.unreadOnly ? { seen: false } : { all: true }, { uid: true });
  return fetchSummaries(client, uids || [], limit);
}

export interface SearchOptions {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit?: number;
  /** Use Gmail's own search syntax (X-GM-RAW) for `query`. */
  gmail?: boolean;
}

export function buildSearchQuery(options: SearchOptions): SearchObject {
  const query: SearchObject = {};
  if (options.query?.trim()) {
    if (options.gmail) query.gmraw = options.query.trim();
    else query.text = options.query.trim();
  }
  if (options.from?.trim()) query.from = options.from.trim();
  if (options.to?.trim()) query.to = options.to.trim();
  if (options.subject?.trim()) query.subject = options.subject.trim();
  if (options.since?.trim()) query.since = options.since.trim();
  if (options.before?.trim()) query.before = options.before.trim();
  if (options.unreadOnly) query.seen = false;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

export async function searchMessages(client: ImapClientLike, options: SearchOptions): Promise<EmailSummary[]> {
  const uids = await client.search(buildSearchQuery(options), { uid: true });
  return fetchSummaries(client, uids || [], clampLimit(options.limit));
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  return groups.flatMap(group => group.value.map(entry => formatAddress({ name: entry.name, address: entry.address })))
    .filter(Boolean);
}

export const DEFAULT_MAX_BODY_CHARS = 12_000;

export async function parseMessageSource(
  source: Buffer,
  base: Pick<FetchMessageObject, 'uid' | 'flags' | 'labels'>,
  maxChars = DEFAULT_MAX_BODY_CHARS,
): Promise<EmailMessage> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const text = (parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '')).replace(/\r\n/g, '\n').trim();
  const flags = base.flags ?? new Set<string>();
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : [];
  const message: EmailMessage = {
    uid: base.uid,
    date: dateString(parsed.date),
    from: parsedAddresses(parsed.from)[0] ?? '',
    to: parsedAddresses(parsed.to),
    cc: parsedAddresses(parsed.cc),
    replyTo: parsedAddresses(parsed.replyTo),
    subject: parsed.subject ?? '',
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    attachments: (parsed.attachments ?? []).map(attachment => ({
      filename: attachment.filename ?? null,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
  if (base.labels) message.important = base.labels.has('\\Important');
  return message;
}

export async function readMessage(client: ImapClientLike, uid: number, maxChars?: number): Promise<EmailMessage> {
  const message = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
  if (!message || !message.source) throw new Error(`No message with uid ${uid} in this mailbox`);
  return parseMessageSource(message.source, message, maxChars);
}

export async function listMailboxes(client: ImapClientLike): Promise<Array<{ path: string; specialUse: string | null }>> {
  const boxes = await client.list();
  return boxes.map(box => ({ path: box.path, specialUse: box.specialUse ?? null }));
}

function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : 10;
  return Math.min(Math.max(value, 1), 50);
}

/** Crude HTML -> text for HTML-only mail. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
