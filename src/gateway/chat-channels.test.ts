import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { configuredChatChannels, startChatChannels, type ChatChannelDeps } from './chat-channels.js';

function deps(): ChatChannelDeps & { logger: Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  logger.child.mockReturnValue(logger);
  return { agent: {} as any, sessionManager: {} as any, logger };
}

const allConfigured = {
  discord: { enabled: true, botToken: 't', applicationId: '', allowedUsers: ['1'] },
  slack: { enabled: true, botToken: 'xoxb', appToken: 'xapp', allowedUsers: ['U1'] },
  whatsapp: { enabled: true, authDir: '', phoneNumber: '', allowedNumbers: ['15551234567'] },
  signal: { enabled: true, phoneNumber: '+1555', cliPath: 'signal-cli', configPath: '', allowedNumbers: ['+1666'] },
  matrix: {
    enabled: true, homeserverUrl: 'https://hs', accessToken: 'tok', userId: '', allowedUsers: ['@me:hs'], allowedRooms: [],
  },
};

describe('configuredChatChannels', () => {
  it('returns nothing when no chat channel is configured', () => {
    expect(configuredChatChannels({}, deps())).toEqual([]);
  });

  it('returns one spec per fully configured channel', () => {
    const names = configuredChatChannels(allConfigured, deps()).map((s) => s.name);
    expect(names).toEqual(['discord', 'slack', 'whatsapp', 'signal', 'matrix']);
  });

  it('skips enabled channels with missing credentials', () => {
    const d = deps();
    const specs = configuredChatChannels({
      discord: { ...allConfigured.discord, botToken: '' },
      slack: { ...allConfigured.slack, appToken: '' },
      signal: { ...allConfigured.signal, phoneNumber: '' },
      matrix: { ...allConfigured.matrix, accessToken: '' },
    }, d);
    expect(specs).toEqual([]);
    expect(d.logger.warn).toHaveBeenCalledTimes(4);
  });

  it('refuses WhatsApp without an allowlist because it rides a real account', () => {
    const d = deps();
    const specs = configuredChatChannels({ whatsapp: { ...allConfigured.whatsapp, allowedNumbers: [] } }, d);
    expect(specs).toEqual([]);
    expect(d.logger.error).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_ALLOWED_NUMBERS'));
  });

  it('warns when a channel is open to everyone', () => {
    const d = deps();
    configuredChatChannels({ discord: { ...allConfigured.discord, allowedUsers: [] } }, d);
    expect(d.logger.warn).toHaveBeenCalledWith({ channel: 'discord' }, expect.stringContaining('DISCORD_ALLOWED_USERS is empty'));
  });
});

describe('startChatChannels', () => {
  it('keeps the channels that start and logs the ones that fail', async () => {
    const d = deps();
    const good = { name: 'discord', start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const bad = { name: 'slack', start: vi.fn(async () => { throw new Error('invalid_auth'); }), stop: vi.fn(async () => {}) };
    const started = await startChatChannels([
      { name: 'discord', create: async () => good as any },
      { name: 'slack', create: async () => bad as any },
      { name: 'matrix', create: async () => { throw new Error('module missing'); } },
    ], d.logger);

    expect(started).toEqual([good]);
    expect(bad.stop).toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledWith(
      { channel: 'slack', error: 'invalid_auth' },
      expect.stringContaining('failed to start'),
    );
    expect(d.logger.error).toHaveBeenCalledWith(
      { channel: 'matrix', error: 'module missing' },
      expect.stringContaining('failed to start'),
    );
  });
});
