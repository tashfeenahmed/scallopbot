import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { CostTracker } from '../../../../routing/cost.js';
import { ApprovalStore, grantPatternFor } from '../../../../agent/approvals.js';
import { callOwner, createPhoneCallHandler, createSmsHandler, type PhoneDeps } from './handler.js';
import {
  CallStateStore,
  buildCallTwiml,
  computeTwilioSignature,
  createTwilioWebhook,
  normalizePhoneNumber,
  parseAllowlist,
  twilioConfigFromEnv,
  validateTwilioSignature,
} from './twilio.js';

const ENV = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret-token',
  TWILIO_FROM_NUMBER: '+15005550006',
  PHONE_ALLOWED_NUMBERS: '+44 7700 900123, +1 (555) 010-0000, not-a-number',
};

function twilioOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

describe('number handling', () => {
  it('normalizes to E.164 and rejects ambiguous input', () => {
    expect(normalizePhoneNumber('+44 7700-900.123')).toBe('+447700900123');
    expect(normalizePhoneNumber('0044 7700 900123')).toBe('+447700900123');
    expect(normalizePhoneNumber('07700900123')).toBeNull();
    expect(normalizePhoneNumber('+0123456789')).toBeNull();
    expect(normalizePhoneNumber(42)).toBeNull();
  });

  it('parses the allowlist and skips junk', () => {
    expect([...parseAllowlist(ENV.PHONE_ALLOWED_NUMBERS)]).toEqual(['+447700900123', '+15550100000']);
  });

  it('builds config only when the three Twilio settings are present', () => {
    expect(twilioConfigFromEnv({})).toBeNull();
    const config = twilioConfigFromEnv({ ...ENV, PUBLIC_BASE_URL: 'https://bot.example.com/', PHONE_OWNER_NUMBER: '+447700900999' });
    expect(config).toMatchObject({ fromNumber: '+15005550006', publicBaseUrl: 'https://bot.example.com', ownerNumber: '+447700900999' });
  });

  it('grants approvals per tool and recipient', () => {
    const pattern = (to: string) => grantPatternFor({ type: 'tool_use', id: '1', name: 'phone_call', input: { to } });
    expect(pattern('+1 (555) 111-2222')).toBe('phone_call:+15551112222');
    expect(grantPatternFor({ type: 'tool_use', id: '1', name: 'sms', input: { to: '00447700900123' } })).toBe('sms:+447700900123');
  });
});

describe('Twilio signature', () => {
  // Example from https://www.twilio.com/docs/usage/security
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  };

  it('matches the documented example', () => {
    expect(computeTwilioSignature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  it('rejects a wrong signature, a tampered param or a missing header', () => {
    const good = computeTwilioSignature('12345', url, params);
    expect(validateTwilioSignature('12345', url, params, good)).toBe(true);
    expect(validateTwilioSignature('12345', url, { ...params, Digits: '9999' }, good)).toBe(false);
    expect(validateTwilioSignature('other', url, params, good)).toBe(false);
    expect(validateTwilioSignature('12345', url, params, undefined)).toBe(false);
  });
});

describe('TwiML', () => {
  it('escapes the message and only gathers when an action URL is given', () => {
    const plain = buildCallTwiml({ message: 'Dinner at 7 <& bring "wine">' });
    expect(plain).toContain('<Say>Dinner at 7 &lt;&amp; bring &quot;wine&quot;&gt;</Say>');
    expect(plain).not.toContain('<Gather');

    const gather = buildCallTwiml({ message: 'Hi', audioUrl: 'https://x/a.mp3', gatherActionUrl: 'https://x/api/twilio/gather?t=abc' });
    expect(gather).toContain('<Gather input="speech dtmf" action="https://x/api/twilio/gather?t=abc" method="POST"');
    expect(gather).toContain('<Play>https://x/a.mp3</Play>');
  });
});

describe('phone_call / sms handlers', () => {
  let dataDir: string;
  let approvals: ApprovalStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'phone-approvals-'));
    approvals = new ApprovalStore({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const ctx = (args: Record<string, unknown>) => ({
    args,
    workspace: '/tmp',
    sessionId: 'sess-1',
    userId: 'telegram:42',
    idempotencyKey: 'op-1',
  });

  function deps(overrides: Partial<PhoneDeps> & { env?: Record<string, string> } = {}): PhoneDeps & { fetch: ReturnType<typeof vi.fn> } {
    const env = { ...ENV, ...(overrides.env ?? {}) };
    const fetchMock = vi.fn().mockResolvedValue(twilioOk({ sid: 'CA999', status: 'queued', num_segments: '1' }));
    return {
      getConfig: () => twilioConfigFromEnv(env),
      state: new CallStateStore(),
      getApprovals: () => approvals,
      ...overrides,
      fetch: (overrides.fetch as ReturnType<typeof vi.fn>) ?? fetchMock,
    } as PhoneDeps & { fetch: ReturnType<typeof vi.fn> };
  }

  it('places a call to an allowlisted number with Basic auth and inline TwiML', async () => {
    const d = deps();
    const tracker = new CostTracker({});
    d.costTracker = tracker;
    const result = await createPhoneCallHandler(d)(ctx({ to: '+447700900123', message: 'Your package arrived.' }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output.split('\n')[0])).toMatchObject({ call_sid: 'CA999', status: 'queued', voice: 'twilio-say' });
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+447700900123');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('Twiml')).toContain('<Say>Your package arrived.</Say>');
    expect(tracker.getUsageHistory()[0]).toMatchObject({ provider: 'twilio', model: 'voice-call' });
    expect(tracker.getDailySpend()).toBeGreaterThan(0);
  });

  it('asks for approval instead of calling a number outside the allowlist, then proceeds once granted', async () => {
    const d = deps();
    const handler = createPhoneCallHandler(d);

    const first = await handler(ctx({ to: '+1 555 222 3333', message: 'Hello' }));
    expect(first.success).toBe(false);
    expect(first.error).toContain('APPROVAL_REQUIRED');
    expect(d.fetch).not.toHaveBeenCalled();
    const pending = approvals.getPending('sess-1');
    expect(pending?.pattern).toBe('phone_call:+15552223333');
    expect(pending?.question).toContain('+15552223333');

    approvals.approve(pending!.id, 'once');
    const second = await handler(ctx({ to: '+15552223333', message: 'Hello' }));
    expect(second.success).toBe(true);
    expect(d.fetch).toHaveBeenCalledOnce();

    // The grant covers that number only.
    const other = await handler(ctx({ to: '+15559998888', message: 'Hello' }));
    expect(other.error).toContain('APPROVAL_REQUIRED');
  });

  it('refuses a non-allowlisted number when no approval channel exists', async () => {
    const d = deps({ getApprovals: () => undefined });
    const result = await createSmsHandler(d)(ctx({ to: '+15552223333', message: 'hi' }));
    expect(result.error).toContain('No approval channel');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the budget is exhausted', async () => {
    const tracker = new CostTracker({ dailyBudget: 0.5 });
    tracker.recordFlatCost({ model: 'x', provider: 'y', sessionId: 's', cost: 0.5 });
    const d = deps({ costTracker: tracker });
    const result = await createPhoneCallHandler(d)(ctx({ to: '+447700900123', message: 'hi' }));
    expect(result.error).toContain('BUDGET_EXCEEDED');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('adds a signed-webhook Gather and our own TTS audio when PUBLIC_BASE_URL is set', async () => {
    const d = deps({
      env: { PUBLIC_BASE_URL: 'https://bot.example.com' },
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from('ID3'), format: 'mp3' }),
    });
    const result = await createPhoneCallHandler(d)(ctx({ to: '+447700900123', message: 'Are you coming?', wait_for_reply: true }));
    expect(result.success).toBe(true);
    const twiml = new URLSearchParams(d.fetch.mock.calls[0][1].body).get('Twiml')!;
    expect(twiml).toMatch(/action="https:\/\/bot\.example\.com\/api\/twilio\/gather\?t=[a-f0-9]{32}"/);
    expect(twiml).toMatch(/<Play>https:\/\/bot\.example\.com\/api\/twilio\/audio\/[a-f0-9]{32}<\/Play>/);
  });

  it('skips the reply step and says why when there is no public URL', async () => {
    const d = deps();
    const result = await createPhoneCallHandler(d)(ctx({ to: '+447700900123', message: 'Hi', wait_for_reply: true }));
    expect(result.output).toContain('PUBLIC_BASE_URL is not set');
    expect(new URLSearchParams(d.fetch.mock.calls[0][1].body).get('Twiml')).not.toContain('<Gather');
  });

  it('sends SMS with the expected form and records per-segment cost', async () => {
    const d = deps();
    const tracker = new CostTracker({});
    d.costTracker = tracker;
    const result = await createSmsHandler(d)(ctx({ to: '+15550100000', message: 'Running late' }));
    expect(result.success).toBe(true);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({ To: '+15550100000', From: '+15005550006', Body: 'Running late' });
    expect(tracker.getUsageHistory()[0]).toMatchObject({ provider: 'twilio', model: 'sms' });
  });

  it('reports Twilio API errors', async () => {
    const d = deps({ fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid To number' }), { status: 400 })) });
    const result = await createSmsHandler(d)(ctx({ to: '+15550100000', message: 'x' }));
    expect(result.error).toBe('Twilio Messages error: Invalid To number');
  });

  it('callOwner only calls when an owner number is configured', async () => {
    const without = deps();
    expect(await callOwner(without, 'hi')).toBe(false);
    const withOwner = deps({ env: { PHONE_OWNER_NUMBER: '+447700900999' } });
    expect(await callOwner(withOwner, 'Reminder: gym')).toBe(true);
    expect(new URLSearchParams(withOwner.fetch.mock.calls[0][1].body).get('To')).toBe('+447700900999');
  });
});

describe('Twilio webhook', () => {
  const base = 'https://bot.example.com';
  const config = () => twilioConfigFromEnv({ ...ENV, PUBLIC_BASE_URL: base });

  it('passes a signed reply to the user who placed the call, once', async () => {
    const state = new CallStateStore();
    const token = state.addCall({ userId: 'telegram:42', sessionId: 's', to: '+447700900123', message: 'Coming?' });
    const notify = vi.fn().mockResolvedValue(undefined);
    const webhook = createTwilioWebhook({ getConfig: config, state, notify });
    const pathAndQuery = `/api/twilio/gather?t=${token}`;
    const params = { AccountSid: 'AC123', SpeechResult: 'Yes, ten minutes', CallSid: 'CA1' };
    const signature = computeTwilioSignature('secret-token', `${base}${pathAndQuery}`, params);

    const res = await webhook({ method: 'POST', pathAndQuery, params, signature });

    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/xml');
    expect(String(res.body)).toContain('<Hangup/>');
    expect(notify).toHaveBeenCalledWith('telegram:42', 'Phone call reply: +447700900123 said: "Yes, ten minutes"', expect.anything());

    await webhook({ method: 'POST', pathAndQuery, params, signature });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('rejects an unsigned or forged callback', async () => {
    const state = new CallStateStore();
    const token = state.addCall({ userId: 'u', sessionId: 's', to: '+447700900123', message: 'm' });
    const notify = vi.fn();
    const webhook = createTwilioWebhook({ getConfig: config, state, notify });
    const pathAndQuery = `/api/twilio/gather?t=${token}`;

    expect((await webhook({ method: 'POST', pathAndQuery, params: { Digits: '1' } })).status).toBe(403);
    const forged = computeTwilioSignature('wrong-token', `${base}${pathAndQuery}`, { Digits: '1' });
    expect((await webhook({ method: 'POST', pathAndQuery, params: { Digits: '1' }, signature: forged })).status).toBe(403);
    expect(notify).not.toHaveBeenCalled();
  });

  it('serves stored TTS audio by token and 404s otherwise', async () => {
    const state = new CallStateStore();
    const token = state.addClip(Buffer.from('ID3audio'), 'audio/mpeg');
    const webhook = createTwilioWebhook({ getConfig: config, state, notify: vi.fn() });
    const res = await webhook({ method: 'GET', pathAndQuery: `/api/twilio/audio/${token}`, params: {} });
    expect(res).toMatchObject({ status: 200, contentType: 'audio/mpeg' });
    expect((await webhook({ method: 'GET', pathAndQuery: `/api/twilio/audio/${'0'.repeat(32)}`, params: {} })).status).toBe(404);
  });

  it('is disabled without PUBLIC_BASE_URL', async () => {
    const webhook = createTwilioWebhook({ getConfig: () => twilioConfigFromEnv(ENV), state: new CallStateStore(), notify: vi.fn() });
    expect((await webhook({ method: 'POST', pathAndQuery: '/api/twilio/gather?t=x', params: {} })).status).toBe(404);
  });
});
