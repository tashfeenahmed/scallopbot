/**
 * Minimal Twilio client + webhook helpers for the phone_call and sms skills.
 *
 * Plain fetch against the Twilio REST API (no SDK). `fetch` is injected so
 * tests never place real calls.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** E.164 numbers that may be called/texted without an approval prompt. */
  allowedNumbers: Set<string>;
  /** Public https base URL that reaches the API server (enables <Gather> and <Play>). */
  publicBaseUrl?: string;
  /** Owner's own number, used for reminder escalation calls. Always allowed. */
  ownerNumber?: string;
}

/** Rough US list prices; recorded so calls/SMS count toward the budget. */
export const TWILIO_ESTIMATED_COST = {
  /** One outbound minute (most calls here are well under one). */
  callPerMinute: 0.014,
  /** One SMS segment (160 GSM chars). */
  smsPerSegment: 0.0083,
};

/**
 * Normalize to E.164 (+ then 8-15 digits). Accepts spaces, dashes, dots,
 * parentheses and a 00 international prefix. Returns null for anything else
 * (no country-code guessing: a bare local number is ambiguous).
 */
export function normalizePhoneNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export function parseAllowlist(raw: string | undefined): Set<string> {
  const numbers = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const normalized = normalizePhoneNumber(part);
    if (normalized) numbers.add(normalized);
  }
  return numbers;
}

export function twilioConfigFromEnv(env: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = normalizePhoneNumber(env.TWILIO_FROM_NUMBER);
  if (!accountSid || !authToken || !fromNumber) return null;
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  return {
    accountSid,
    authToken,
    fromNumber,
    allowedNumbers: parseAllowlist(env.PHONE_ALLOWED_NUMBERS),
    publicBaseUrl: base && /^https?:\/\//.test(base) ? base : undefined,
    ownerNumber: normalizePhoneNumber(env.PHONE_OWNER_NUMBER) ?? undefined,
  };
}

export function isNumberAllowed(config: TwilioConfig, number: string): boolean {
  return config.allowedNumbers.has(number) || config.ownerNumber === number;
}

// ---------------------------------------------------------------------------
// Signature validation (https://www.twilio.com/docs/usage/security)
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA1 over the full request URL followed by every POST parameter,
 * sorted by name, as name+value with no separators; base64-encoded.
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface CallTwimlOptions {
  message: string;
  /** Public URL of pre-rendered TTS audio; replaces <Say> when present. */
  audioUrl?: string;
  /** When set, collect a spoken or keypad reply and POST it here. */
  gatherActionUrl?: string;
  /** Spoken after the message when gathering. */
  gatherPrompt?: string;
  voice?: string;
}

export function buildCallTwiml(options: CallTwimlOptions): string {
  const voiceAttr = options.voice ? ` voice="${escapeXml(options.voice)}"` : '';
  const speak = options.audioUrl
    ? `<Play>${escapeXml(options.audioUrl)}</Play>`
    : `<Say${voiceAttr}>${escapeXml(options.message)}</Say>`;
  if (!options.gatherActionUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${speak}</Response>`;
  }
  const prompt = options.gatherPrompt ?? 'Please say your reply after the tone, or press a key.';
  return '<?xml version="1.0" encoding="UTF-8"?><Response>'
    + `<Gather input="speech dtmf" action="${escapeXml(options.gatherActionUrl)}" method="POST" timeout="6" speechTimeout="auto">`
    + `${speak}<Say${voiceAttr}>${escapeXml(prompt)}</Say>`
    + '</Gather>'
    + `<Say${voiceAttr}>No reply received. Goodbye.</Say>`
    + '</Response>';
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export interface TwilioCallResult { sid: string; status: string }
export interface TwilioMessageResult { sid: string; status: string; numSegments: number }

export class TwilioClient {
  constructor(private config: TwilioConfig, private fetchFn: FetchLike = fetch) {}

  private async post(resource: 'Calls' | 'Messages', form: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/${resource}.json`;
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
      throw new Error(`Twilio ${resource} error: ${message}`);
    }
    return json;
  }

  async placeCall(to: string, twiml: string): Promise<TwilioCallResult> {
    const json = await this.post('Calls', { To: to, From: this.config.fromNumber, Twiml: twiml });
    return { sid: String(json.sid ?? ''), status: String(json.status ?? 'queued') };
  }

  async sendSms(to: string, body: string): Promise<TwilioMessageResult> {
    const json = await this.post('Messages', { To: to, From: this.config.fromNumber, Body: body });
    const segments = Number(json.num_segments);
    return {
      sid: String(json.sid ?? ''),
      status: String(json.status ?? 'queued'),
      numSegments: Number.isFinite(segments) && segments > 0 ? segments : Math.max(1, Math.ceil(body.length / 153)),
    };
  }
}

// ---------------------------------------------------------------------------
// Short-lived state shared with the webhook (gather callbacks, audio clips)
// ---------------------------------------------------------------------------

export interface PendingCall {
  userId: string;
  sessionId: string;
  to: string;
  message: string;
  createdAt: number;
}

const STATE_TTL_MS = 30 * 60 * 1000;

export class CallStateStore {
  private calls = new Map<string, PendingCall>();
  private clips = new Map<string, { audio: Buffer; contentType: string; createdAt: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  private token(): string {
    return randomBytes(16).toString('hex');
  }

  private evict(): void {
    const cutoff = this.now() - STATE_TTL_MS;
    for (const [k, v] of this.calls) if (v.createdAt < cutoff) this.calls.delete(k);
    for (const [k, v] of this.clips) if (v.createdAt < cutoff) this.clips.delete(k);
  }

  addCall(call: Omit<PendingCall, 'createdAt'>): string {
    this.evict();
    const token = this.token();
    this.calls.set(token, { ...call, createdAt: this.now() });
    return token;
  }

  /** One reply per call: the record is removed when read. */
  takeCall(token: string): PendingCall | undefined {
    this.evict();
    const call = this.calls.get(token);
    this.calls.delete(token);
    return call;
  }

  addClip(audio: Buffer, contentType: string): string {
    this.evict();
    const token = this.token();
    this.clips.set(token, { audio, contentType, createdAt: this.now() });
    return token;
  }

  getClip(token: string): { audio: Buffer; contentType: string } | undefined {
    this.evict();
    return this.clips.get(token);
  }
}

// ---------------------------------------------------------------------------
// Webhook (mounted by the API server under /api/twilio/)
// ---------------------------------------------------------------------------

export interface TwilioWebhookRequest {
  method: string;
  /** Path + query exactly as received, e.g. /api/twilio/gather?t=abc */
  pathAndQuery: string;
  params: Record<string, string>;
  signature?: string;
}

export interface TwilioWebhookResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
}

export type TwilioWebhookHandler = (req: TwilioWebhookRequest) => Promise<TwilioWebhookResponse>;

export interface TwilioWebhookDeps {
  getConfig: () => TwilioConfig | null;
  state: CallStateStore;
  /** Pass the caller's reply back to the user who placed the call. */
  notify: (userId: string, text: string, call: PendingCall) => Promise<void>;
}

const twiml = (inner: string): TwilioWebhookResponse => ({
  status: 200,
  contentType: 'text/xml',
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
});

export function createTwilioWebhook(deps: TwilioWebhookDeps): TwilioWebhookHandler {
  return async (req) => {
    const config = deps.getConfig();
    if (!config?.publicBaseUrl) return { status: 404, contentType: 'text/plain', body: 'Not found' };
    const url = new URL(req.pathAndQuery, 'http://local');

    // Audio for <Play>: unguessable one-off token, no secrets in the body.
    const clip = url.pathname.match(/^\/api\/twilio\/audio\/([a-f0-9]{32})$/);
    if (clip && (req.method === 'GET' || req.method === 'HEAD')) {
      const found = deps.state.getClip(clip[1]);
      return found
        ? { status: 200, contentType: found.contentType, body: found.audio }
        : { status: 404, contentType: 'text/plain', body: 'Not found' };
    }

    if (url.pathname === '/api/twilio/gather' && req.method === 'POST') {
      const fullUrl = `${config.publicBaseUrl}${req.pathAndQuery}`;
      if (!validateTwilioSignature(config.authToken, fullUrl, req.params, req.signature)) {
        return { status: 403, contentType: 'text/plain', body: 'Invalid signature' };
      }
      if (req.params.AccountSid && req.params.AccountSid !== config.accountSid) {
        return { status: 403, contentType: 'text/plain', body: 'Wrong account' };
      }
      const call = deps.state.takeCall(url.searchParams.get('t') ?? '');
      if (!call) return twiml('<Say>Thanks. Goodbye.</Say><Hangup/>');
      const speech = req.params.SpeechResult?.trim();
      const digits = req.params.Digits?.trim();
      const reply = speech ? `said: "${speech}"` : digits ? `pressed: ${digits}` : 'gave no reply';
      await deps.notify(call.userId, `Phone call reply: ${call.to} ${reply}`, call);
      return twiml('<Say>Thanks, I will pass that on. Goodbye.</Say><Hangup/>');
    }

    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  };
}
