/**
 * Email settings from the environment.
 *
 * IMAP reads mail, SMTP sends it. Both work with Gmail app passwords
 * (imap.gmail.com:993 / smtp.gmail.com:465). SMTP user/password fall back to
 * the IMAP ones, and an `imap.` host maps to `smtp.` when no SMTP host is set.
 */

export interface MailServerSettings {
  host: string;
  port: number;
  /** Implicit TLS (993/465). False means STARTTLS on 143/587. */
  secure: boolean;
  user: string;
  pass: string;
}

export interface EmailSettings {
  imap: MailServerSettings | null;
  smtp: MailServerSettings | null;
  /** Address used in From: (defaults to the SMTP user). */
  from: string | null;
  /** Mailbox read by default and watched by the inbound trigger. */
  mailbox: string;
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEmailSettings(env: Env = process.env): EmailSettings {
  const imapHost = clean(env.EMAIL_IMAP_HOST);
  const imapUser = clean(env.EMAIL_IMAP_USER);
  const imapPass = clean(env.EMAIL_IMAP_PASS);
  const imapPort = port(env.EMAIL_IMAP_PORT, 993);
  const imap = imapHost && imapUser && imapPass
    ? { host: imapHost, port: imapPort, secure: imapPort !== 143, user: imapUser, pass: imapPass }
    : null;

  const smtpHost = clean(env.EMAIL_SMTP_HOST)
    || (/^imap\./i.test(imapHost) ? imapHost.replace(/^imap\./i, 'smtp.') : '');
  const smtpUser = clean(env.EMAIL_SMTP_USER) || imapUser;
  const smtpPass = clean(env.EMAIL_SMTP_PASS) || imapPass;
  const smtpPort = port(env.EMAIL_SMTP_PORT, 465);
  const smtp = smtpHost && smtpUser && smtpPass
    ? { host: smtpHost, port: smtpPort, secure: smtpPort === 465, user: smtpUser, pass: smtpPass }
    : null;

  return {
    imap,
    smtp,
    from: clean(env.EMAIL_FROM) || smtpUser || imapUser || null,
    mailbox: clean(env.EMAIL_MAILBOX) || 'INBOX',
  };
}

/** Lowercased bare address from "Name <a@b.c>" or "a@b.c". */
export function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function isValidAddress(value: string): boolean {
  return ADDRESS.test(bareAddress(value));
}

/** Comma/semicolon separated string or array -> trimmed list. */
export function addressList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Sender allowlist entries: full addresses (bob@example.com) or whole
 * domains (@example.com).
 */
export function parseAllowedSenders(value: string | undefined): string[] {
  return addressList(value ?? '').map(entry => entry.toLowerCase());
}

export function senderAllowed(sender: string, allowlist: readonly string[]): boolean {
  const address = bareAddress(sender);
  if (!isValidAddress(address)) return false;
  const domain = address.slice(address.lastIndexOf('@'));
  return allowlist.some(entry => entry === address || (entry.startsWith('@') && entry === domain));
}
