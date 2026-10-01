/**
 * SMTP sends via nodemailer, with an injectable transport for tests.
 *
 * This module only delivers. Whether a send is allowed at all is decided by
 * the agent's approval gate before the skill runs (see safety.confirmActions
 * in the email SKILL.md).
 */
import type { MailServerSettings } from './config.js';
import { bareAddress, isValidAddress } from './config.js';
import type { EmailMessage } from './imap.js';

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendReceipt {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
}

export interface MailTransportLike {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;
}

export type MailTransportFactory = (settings: MailServerSettings) => Promise<MailTransportLike>;

export const defaultTransportFactory: MailTransportFactory = async (settings) => {
  const nodemailer = await import('nodemailer');
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    auth: { user: settings.user, pass: settings.pass },
  }) as unknown as MailTransportLike;
};

export const MAX_RECIPIENTS = 20;

export function validateRecipients(to: string[], cc: string[] = [], bcc: string[] = []): void {
  const all = [...to, ...cc, ...bcc];
  if (to.length === 0) throw new Error('At least one "to" recipient is required');
  if (all.length > MAX_RECIPIENTS) throw new Error(`Too many recipients (${all.length}); the limit is ${MAX_RECIPIENTS}`);
  const invalid = all.filter(address => !isValidAddress(address));
  if (invalid.length > 0) throw new Error(`Invalid email address: ${invalid.join(', ')}`);
}

function addressText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'address' in value) return String((value as { address: unknown }).address);
  return String(value);
}

export async function sendEmail(
  settings: MailServerSettings,
  email: OutgoingEmail,
  factory: MailTransportFactory = defaultTransportFactory,
): Promise<SendReceipt> {
  validateRecipients(email.to, email.cc, email.bcc);
  if (!email.subject.trim() && !email.text.trim()) throw new Error('Refusing to send an empty email');
  const transport = await factory(settings);
  const info = await transport.sendMail({
    from: email.from,
    to: email.to,
    cc: email.cc?.length ? email.cc : undefined,
    bcc: email.bcc?.length ? email.bcc : undefined,
    subject: email.subject,
    text: email.text,
    inReplyTo: email.inReplyTo,
    references: email.references?.length ? email.references : undefined,
  });
  return {
    messageId: info.messageId ?? null,
    accepted: (info.accepted ?? []).map(addressText),
    rejected: (info.rejected ?? []).map(addressText),
  };
}

export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim();
}

export function quoteOriginal(original: Pick<EmailMessage, 'date' | 'from' | 'text'>, maxLines = 40): string {
  const lines = original.text.split('\n');
  const quoted = lines.slice(0, maxLines).map(line => `> ${line}`).join('\n');
  const more = lines.length > maxLines ? '\n> ...' : '';
  const when = original.date ? new Date(original.date).toUTCString() : 'earlier';
  return `On ${when}, ${original.from} wrote:\n${quoted}${more}`;
}

/**
 * Turn a parsed original message into a threaded reply: recipients from
 * Reply-To/From (plus To/Cc for reply-all, minus our own address), "Re:"
 * subject, In-Reply-To and References headers, and a quoted original.
 */
export function buildReply(
  original: EmailMessage,
  body: string,
  options: { from: string; replyAll?: boolean; quote?: boolean },
): OutgoingEmail {
  const self = bareAddress(options.from);
  const primary = original.replyTo.length > 0 ? original.replyTo : [original.from];
  const to = dedupe(primary).filter(address => bareAddress(address) !== self);
  const cc = options.replyAll
    ? dedupe([...original.to, ...original.cc])
      .filter(address => bareAddress(address) !== self && !to.some(t => bareAddress(t) === bareAddress(address)))
    : [];
  const references = [...original.references];
  if (original.messageId && !references.includes(original.messageId)) references.push(original.messageId);
  const text = options.quote === false ? body : `${body.trimEnd()}\n\n${quoteOriginal(original)}`;
  return {
    from: options.from,
    to: to.length > 0 ? to : primary,
    cc,
    subject: replySubject(original.subject),
    text,
    inReplyTo: original.messageId ?? undefined,
    references,
  };
}

function dedupe(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter(address => {
    const key = bareAddress(address);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
