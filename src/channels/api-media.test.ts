/**
 * API server routes added for media features: the Twilio webhook (no session
 * auth, signature-checked by the handler) and the dashboard voice endpoints.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { ApiChannel } from './api.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { VoiceManager } from '../voice/index.js';
import { CallStateStore, computeTwilioSignature, createTwilioWebhook, twilioConfigFromEnv } from '../skills/bundled/phone_call/scripts/twilio.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;

function makeChannel(port: number, extra: Record<string, unknown>): ApiChannel {
  return new ApiChannel({
    port,
    host: '127.0.0.1',
    apiKey: 'operator-key',
    agent: {} as Agent,
    sessionManager: {} as SessionManager,
    logger,
    ...extra,
  });
}

describe('ApiChannel media routes', () => {
  let channel: ApiChannel | null = null;
  const port = 4100 + Math.floor(Math.random() * 800);

  afterEach(async () => {
    if (channel?.isRunning()) await channel.stop();
    channel = null;
  });

  it('forwards Twilio callbacks without session auth and enforces the signature', async () => {
    const base = 'https://bot.example.com';
    const state = new CallStateStore();
    const token = state.addCall({ userId: 'telegram:1', sessionId: 's', to: '+447700900123', message: 'm' });
    const notify = vi.fn().mockResolvedValue(undefined);
    const twilioWebhook = createTwilioWebhook({
      getConfig: () => twilioConfigFromEnv({
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_FROM_NUMBER: '+15005550006',
        PUBLIC_BASE_URL: base,
      }),
      state,
      notify,
    });
    channel = makeChannel(port, { twilioWebhook });
    await channel.start();

    const pathAndQuery = `/api/twilio/gather?t=${token}`;
    const params = { Digits: '1', CallSid: 'CA1' };
    const body = new URLSearchParams(params).toString();

    const forged = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' },
      body,
    });
    expect(forged.status).toBe(403);

    const signed = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': computeTwilioSignature('tok', `${base}${pathAndQuery}`, params),
      },
      body,
    });
    expect(signed.status).toBe(200);
    expect(signed.headers.get('content-type')).toBe('text/xml');
    expect(notify).toHaveBeenCalledWith('telegram:1', 'Phone call reply: +447700900123 pressed: 1', expect.anything());

    // Everything else under /api still needs credentials.
    expect((await fetch(`http://127.0.0.1:${port}/api/voice/status`)).status).toBe(401);
  });

  it('transcribes raw audio and synthesizes speech for the dashboard', async () => {
    const voiceManager = {
      isAvailable: vi.fn().mockResolvedValue({ stt: true, tts: true, recording: false, playback: false }),
      transcribe: vi.fn().mockResolvedValue({ text: '  hello there ' }),
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from('ID3fake'), format: 'mp3' }),
    } as unknown as VoiceManager;
    channel = makeChannel(port + 1, { voiceManager });
    await channel.start();
    const auth = { 'X-API-Key': 'operator-key' };

    const status = await fetch(`http://127.0.0.1:${port + 1}/api/voice/status`, { headers: auth });
    expect(await status.json()).toEqual({ stt: true, tts: true });

    const audio = Buffer.from('fake-webm-bytes');
    const stt = await fetch(`http://127.0.0.1:${port + 1}/api/voice/transcribe`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'audio/webm' },
      body: audio,
    });
    expect(await stt.json()).toEqual({ text: 'hello there' });
    expect((voiceManager.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(audio);

    const tts = await fetch(`http://127.0.0.1:${port + 1}/api/voice/speak`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hi!' }),
    });
    expect(tts.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await tts.arrayBuffer()).toString()).toBe('ID3fake');
  });

  it('returns 503 for voice endpoints when no voice manager is configured', async () => {
    channel = makeChannel(port + 2, {});
    await channel.start();
    const res = await fetch(`http://127.0.0.1:${port + 2}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'X-API-Key': 'operator-key' },
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(503);
  });
});
