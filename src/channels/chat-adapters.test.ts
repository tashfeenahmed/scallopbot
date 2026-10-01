/**
 * End-to-end-ish tests for the Discord, Slack, WhatsApp, Signal and Matrix
 * adapters against mocked SDK clients: start, inbound message -> agent ->
 * reply, allowlist enforcement, and proactive delivery.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// SDK fakes
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  modules: {} as Record<string, unknown>,
  discordClients: [] as any[],
  restPut: null as any,
  spawnCalls: [] as Array<{ cmd: string; args: string[]; proc: any }>,
}));

vi.mock('../utils/dynamic-import.js', () => ({
  safeImport: vi.fn(async (name: string) => h.modules[name] ?? null),
  isModuleAvailable: vi.fn(async (name: string) => name in h.modules),
}));

vi.mock('discord.js', () => {
  class FakeClient {
    handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    user = { id: 'bot-1', tag: 'Scallop#0001' };
    application = { id: 'app-1' };
    login = vi.fn(async () => 'ok');
    destroy = vi.fn(async () => undefined);
    dmSend = vi.fn(async () => ({ id: 'dm-msg-1' }));
    users = { fetch: vi.fn(async () => ({ send: this.dmSend })) };
    constructor() {
      h.discordClients.push(this);
    }
    on(event: string, fn: (...args: any[]) => unknown) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    once(event: string, fn: (...args: any[]) => unknown) {
      return this.on(event, fn);
    }
    async emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) await fn(...args);
    }
  }
  h.restPut = vi.fn(async () => undefined);
  class FakeREST {
    setToken() {
      return this;
    }
    put = h.restPut;
  }
  return {
    Client: FakeClient,
    REST: FakeREST,
    Routes: { applicationCommands: (id: string) => `/applications/${id}/commands` },
    Events: {
      ClientReady: 'clientReady',
      MessageCreate: 'messageCreate',
      InteractionCreate: 'interactionCreate',
      Error: 'error',
    },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Partials: { Channel: 0, Message: 1 },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const proc: any = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = vi.fn();
      if (cmd === 'which') {
        process.nextTick(() => proc.emit('close', 0));
      } else {
        // signal-cli JSON-RPC: acknowledge every request on stdout.
        proc.stdin = {
          write: vi.fn((line: string) => {
            const req = JSON.parse(line);
            setImmediate(() => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { timestamp: 1 } }) + '\n'));
            return true;
          }),
        };
      }
      h.spawnCalls.push({ cmd, args, proc });
      return proc;
    }),
  };
});

// ---------------------------------------------------------------------------
// Shared agent/session fakes
// ---------------------------------------------------------------------------

function makeDeps() {
  const agent = {
    processMessage: vi.fn(async () => ({
      response: 'Agent reply',
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
      iterationsUsed: 1,
      completionReason: 'completed',
    })),
  } as unknown as Agent & { processMessage: ReturnType<typeof vi.fn> };
  const sessionManager = {
    createSession: vi.fn(async ({ userId }: { userId: string }) => ({ id: `session-${userId}` })),
    getSession: vi.fn(async (id: string) => ({ id, messages: [] })),
    startNewSession: vi.fn(async ({ userId }: { userId: string }) => ({ id: `fresh-${userId}` })),
  } as unknown as SessionManager & { createSession: ReturnType<typeof vi.fn> };
  const logger = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  } as unknown as Logger;
  (logger.child as any).mockReturnValue(logger);
  const onUserMessage = vi.fn();
  return { agent, sessionManager, logger, onUserMessage };
}

beforeEach(() => {
  h.modules = {};
  h.discordClients.length = 0;
  h.spawnCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

describe('chat-support helpers', () => {
  it('renders a pending approval as a yes/no prompt', async () => {
    const { renderAgentReply } = await import('./chat-support.js');
    expect(renderAgentReply({ response: 'Done.' })).toBe('Done.');
    expect(renderAgentReply({ response: '', pendingApproval: { id: 'a1', question: 'Delete the file?' } }))
      .toBe('Delete the file?\n\n(Reply "yes" to allow or "no" to cancel.)');
  });

  it('serializes turns per conversation key', async () => {
    const { KeyedSerialQueue } = await import('./chat-support.js');
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.run('u1', () => new Promise<void>((resolve) => {
      order.push('first-start');
      release = () => { order.push('first-end'); resolve(); };
    }));
    const second = queue.run('u1', async () => { order.push('second'); });
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

describe('DiscordChannel (mocked discord.js)', () => {
  async function startDiscord(allowedUsers?: string[]) {
    const deps = makeDeps();
    const { DiscordChannel } = await import('./discord.js');
    const channel = new DiscordChannel({ ...deps, botToken: 'discord-token', allowedUsers });
    await channel.start();
    return { channel, deps, client: h.discordClients.at(-1) };
  }

  function dm(authorId: string, content: string) {
    return {
      author: { id: authorId, bot: false },
      content,
      guild: null,
      channel: { sendTyping: vi.fn(async () => undefined) },
      mentions: { has: vi.fn(() => false) },
      reply: vi.fn(async () => undefined),
    };
  }

  it('logs in on start and registers slash commands once ready', async () => {
    const { channel, client } = await startDiscord();
    expect(client.login).toHaveBeenCalledWith('discord-token');
    expect(channel.isRunning()).toBe(true);
    await client.emit('clientReady');
    await vi.waitFor(() => expect(h.restPut).toHaveBeenCalledWith('/applications/app-1/commands', expect.anything()));
  });

  it('routes an allowed DM to the agent and replies', async () => {
    const { client, deps } = await startDiscord(['111']);
    const message = dm('111', 'hello bot');
    await client.emit('messageCreate', message);

    expect(deps.sessionManager.createSession).toHaveBeenCalledWith({ userId: 'discord:111', channelId: 'discord' });
    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-discord:111', 'hello bot');
    expect(deps.onUserMessage).toHaveBeenCalledWith('discord:111', 'hello bot');
    expect(message.reply).toHaveBeenCalledWith('Agent reply');
  });

  it('ignores users outside the allowlist', async () => {
    const { client, deps } = await startDiscord(['111']);
    const message = dm('999', 'let me in');
    await client.emit('messageCreate', message);
    expect(deps.agent.processMessage).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('delivers proactive DMs only to allowlisted users', async () => {
    const { channel, client } = await startDiscord(['111']);
    await expect(channel.sendMessage('111', 'reminder')).resolves.toEqual({
      sent: true, channel: 'discord', messageIds: ['dm-msg-1'],
    });
    expect(client.users.fetch).toHaveBeenCalledWith('111');
    expect(client.dmSend).toHaveBeenCalledWith('reminder');

    await expect(channel.sendMessage('999', 'nope')).resolves.toBe(false);
    await expect(channel.sendMessage('default', 'to owner')).resolves.toMatchObject({ sent: true });
    expect(client.users.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function installFakeBolt() {
  const apps: any[] = [];
  class FakeApp {
    options: any;
    messageHandler: any;
    events = new Map<string, any>();
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    client = {
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '1700000000.0001' })) },
      conversations: { open: vi.fn(async () => ({ channel: { id: 'D1' } })) },
      files: { uploadV2: vi.fn(async () => ({ ok: true })) },
    };
    constructor(options: any) {
      this.options = options;
      apps.push(this);
    }
    message(fn: any) { this.messageHandler = fn; }
    event(name: string, fn: any) { this.events.set(name, fn); }
    command() {}
  }
  h.modules['@slack/bolt'] = { App: FakeApp, LogLevel: { INFO: 'info' } };
  return apps;
}

describe('SlackChannel (mocked @slack/bolt)', () => {
  async function startSlack(allowedUsers?: string[]) {
    const apps = installFakeBolt();
    const deps = makeDeps();
    const { SlackChannel } = await import('./slack.js');
    const channel = new SlackChannel({ ...deps, botToken: 'xoxb-1', appToken: 'xapp-1', allowedUsers });
    await channel.start();
    return { channel, deps, app: apps[0] };
  }

  it('starts a Socket Mode app with both tokens', async () => {
    const { app, channel } = await startSlack();
    expect(app.options).toMatchObject({ token: 'xoxb-1', appToken: 'xapp-1', socketMode: true });
    expect(app.start).toHaveBeenCalled();
    expect(channel.isRunning()).toBe(true);
  });

  it('routes an allowed DM to the agent and replies via say()', async () => {
    const { app, deps } = await startSlack(['U1']);
    const say = vi.fn(async () => undefined);
    await app.messageHandler({ message: { user: 'U1', text: 'hi slack', channel: 'D1', channel_type: 'im' }, say });

    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-slack:U1', 'hi slack');
    expect(say).toHaveBeenCalledWith('Agent reply');
  });

  it('answers channel mentions once (app_mention) and never via the message handler', async () => {
    const { app, deps } = await startSlack(['U1']);
    const say = vi.fn(async () => undefined);
    await app.messageHandler({ message: { user: 'U1', text: '<@B1> hi', channel: 'C1', channel_type: 'channel' }, say });
    expect(deps.agent.processMessage).not.toHaveBeenCalled();

    await app.events.get('app_mention')({ event: { user: 'U1', text: '<@B1> hi', channel: 'C1' }, say });
    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-slack:U1', 'hi');
    expect(say).toHaveBeenCalledWith('Agent reply');
  });

  it('ignores users outside the allowlist and bot echoes', async () => {
    const { app, deps } = await startSlack(['U1']);
    const say = vi.fn(async () => undefined);
    await app.messageHandler({ message: { user: 'U2', text: 'hi', channel: 'D2', channel_type: 'im' }, say });
    await app.messageHandler({ message: { user: 'U1', bot_id: 'B1', text: 'echo', channel: 'D1', channel_type: 'im' }, say });
    await app.events.get('app_mention')({ event: { user: 'U2', text: '<@B1> hi', channel: 'C1' }, say });
    expect(deps.agent.processMessage).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('delivers proactive messages to allowlisted users only', async () => {
    const { app, channel } = await startSlack(['U1']);
    await expect(channel.sendMessage('U1', 'reminder')).resolves.toEqual({
      sent: true, channel: 'slack', messageIds: ['1700000000.0001'],
    });
    expect(app.client.chat.postMessage).toHaveBeenCalledWith({ channel: 'U1', text: 'reminder' });
    await expect(channel.sendMessage('U2', 'nope')).resolves.toBe(false);
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('fails start cleanly when @slack/bolt is not installed', async () => {
    const deps = makeDeps();
    const { SlackChannel } = await import('./slack.js');
    const channel = new SlackChannel({ ...deps, botToken: 'xoxb-1', appToken: 'xapp-1' });
    await expect(channel.start()).rejects.toThrow(/@slack\/bolt/);
    expect(channel.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

function installFakeBaileys(registered = true) {
  const sockets: any[] = [];
  const makeWASocket = vi.fn(() => {
    const handlers = new Map<string, any>();
    const socket = {
      handlers,
      ev: { on: vi.fn((event: string, fn: any) => handlers.set(event, fn)) },
      sendMessage: vi.fn(async () => ({ key: { id: `wa-${sockets.length}` } })),
      sendPresenceUpdate: vi.fn(async () => undefined),
      requestPairingCode: vi.fn(async () => 'ABCD-1234'),
      end: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  });
  h.modules['@whiskeysockets/baileys'] = {
    default: makeWASocket,
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    useMultiFileAuthState: vi.fn(async () => ({ state: { creds: { registered } }, saveCreds: vi.fn() })),
    downloadMediaMessage: vi.fn(),
  };
  return { sockets, makeWASocket };
}

describe('WhatsAppChannel (mocked baileys)', () => {
  const authDir = path.join(os.tmpdir(), `scallop-wa-test-${process.pid}`);

  async function startWhatsApp(opts: { allowedNumbers?: string[]; registered?: boolean; phoneNumber?: string } = {}) {
    const fake = installFakeBaileys(opts.registered ?? true);
    const deps = makeDeps();
    const { WhatsAppChannel } = await import('./whatsapp.js');
    const channel = new WhatsAppChannel({
      ...deps,
      authDir,
      enableVoice: false,
      allowedNumbers: opts.allowedNumbers ?? ['+1 555 123 4567'],
      phoneNumber: opts.phoneNumber,
    });
    await channel.start();
    return { channel, deps, ...fake, socket: fake.sockets[0] };
  }

  const textMsg = (key: Record<string, unknown>, text: string) => ({ key: { fromMe: false, ...key }, message: { conversation: text } });

  it('routes an allowed number to the agent and replies in the same chat', async () => {
    const { socket, deps, channel } = await startWhatsApp();
    await socket.handlers.get('messages.upsert')({
      type: 'notify',
      messages: [textMsg({ remoteJid: '15551234567@s.whatsapp.net' }, 'hi wa')],
    });

    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-whatsapp:15551234567', 'hi wa');
    expect(socket.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', { text: 'Agent reply' });
    await channel.stop();
  });

  it('resolves LID-addressed chats through remoteJidAlt for the allowlist', async () => {
    const { socket, deps, channel } = await startWhatsApp();
    await socket.handlers.get('messages.upsert')({
      type: 'notify',
      messages: [textMsg({ remoteJid: '987654@lid', remoteJidAlt: '15551234567@s.whatsapp.net' }, 'via lid')],
    });
    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-whatsapp:15551234567', 'via lid');
    expect(socket.sendMessage).toHaveBeenCalledWith('987654@lid', { text: 'Agent reply' });
    await channel.stop();
  });

  it('ignores non-allowlisted numbers, unresolvable LIDs, and groups', async () => {
    const { socket, deps, channel } = await startWhatsApp();
    await socket.handlers.get('messages.upsert')({
      type: 'notify',
      messages: [
        textMsg({ remoteJid: '447700900000@s.whatsapp.net' }, 'stranger'),
        textMsg({ remoteJid: '111@lid' }, 'unknown lid'),
        textMsg({ remoteJid: '1203630@g.us', participant: '15551234567@s.whatsapp.net' }, 'group'),
      ],
    });
    expect(deps.agent.processMessage).not.toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
    await channel.stop();
  });

  it('reconnects with a fresh socket after a non-logout close', async () => {
    vi.useFakeTimers();
    const { socket, makeWASocket, channel } = await startWhatsApp();
    await socket.handlers.get('connection.update')({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(makeWASocket).toHaveBeenCalledTimes(2);
    await channel.stop();
  });

  it('logs a pairing code instead of a QR when the account number is configured', async () => {
    const { socket, deps, channel } = await startWhatsApp({ registered: false, phoneNumber: '+1 555 000 1111' });
    await socket.handlers.get('connection.update')({ qr: 'qr-data' });
    expect(socket.requestPairingCode).toHaveBeenCalledWith('15550001111');
    expect(deps.logger.warn).toHaveBeenCalledWith({ pairingCode: 'ABCD-1234' }, expect.stringContaining('pairing code'));
    await channel.stop();
  });

  it('delivers proactive messages to allowlisted numbers only', async () => {
    const { socket, channel } = await startWhatsApp();
    await expect(channel.sendMessage('+1 (555) 123-4567', 'reminder')).resolves.toMatchObject({ sent: true, channel: 'whatsapp' });
    expect(socket.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', { text: 'reminder' });
    await expect(channel.sendMessage('447700900000', 'nope')).resolves.toBe(false);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    await channel.stop();
  });
});

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

describe('SignalChannel (mocked signal-cli process)', () => {
  async function startSignal(allowedNumbers?: string[]) {
    const deps = makeDeps();
    const { SignalChannel } = await import('./signal.js');
    const channel = new SignalChannel({
      ...deps,
      phoneNumber: '+15550001111',
      enableVoice: false,
      allowedNumbers,
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const started = channel.start();
    await vi.advanceTimersByTimeAsync(2000);
    await started;
    vi.useRealTimers();
    const proc = h.spawnCalls.find((c) => c.cmd === 'signal-cli')!.proc;
    return { channel, deps, proc };
  }

  const receive = (source: string, message: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    jsonrpc: '2.0',
    method: 'receive',
    params: { envelope: { source, sourceNumber: source, timestamp: 1, dataMessage: { timestamp: 1, message, ...extra } } },
  });

  const sentRequests = (proc: any) => proc.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line));

  it('spawns signal-cli in JSON-RPC mode for the bot number', async () => {
    const { channel } = await startSignal();
    const call = h.spawnCalls.find((c) => c.cmd === 'signal-cli')!;
    expect(call.args).toEqual(['-a', '+15550001111', 'jsonRpc']);
    expect(channel.isRunning()).toBe(true);
    await channel.stop();
  });

  it('routes an allowed sender to the agent and replies over JSON-RPC', async () => {
    const { channel, deps, proc } = await startSignal(['+15552223333']);
    channel.handleLine(receive('+15552223333', 'hi signal'));

    await vi.waitFor(() => expect(sentRequests(proc)).toHaveLength(1));
    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-signal:+15552223333', 'hi signal');
    expect(sentRequests(proc)[0]).toMatchObject({
      method: 'send',
      params: { recipient: ['+15552223333'], message: 'Agent reply' },
    });
    await channel.stop();
  });

  it('ignores senders outside the allowlist and group messages', async () => {
    const { channel, deps, proc } = await startSignal(['+15552223333']);
    channel.handleLine(receive('+15559999999', 'stranger'));
    channel.handleLine(receive('+15552223333', 'group chat', { groupInfo: { groupId: 'g1' } }));
    await new Promise((r) => setImmediate(r));
    expect(deps.agent.processMessage).not.toHaveBeenCalled();
    expect(proc.stdin.write).not.toHaveBeenCalled();
    await channel.stop();
  });

  it('confirms proactive delivery from the JSON-RPC response and enforces the allowlist', async () => {
    const { channel, proc } = await startSignal(['+15552223333']);
    await expect(channel.sendMessage('+15552223333', 'reminder')).resolves.toBe(true);
    expect(sentRequests(proc)[0]).toMatchObject({ params: { recipient: ['+15552223333'], message: 'reminder' } });
    await expect(channel.sendMessage('+15559999999', 'nope')).resolves.toBe(false);
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    await channel.stop();
  });
});

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

function installFakeMatrix() {
  const clients: any[] = [];
  const createClient = vi.fn((opts: any) => {
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const client = {
      opts,
      handlers,
      on: vi.fn((event: string, fn: any) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); }),
      removeListener: vi.fn(),
      startClient: vi.fn(async () => {
        for (const fn of handlers.get('sync') ?? []) fn('PREPARED');
      }),
      stopClient: vi.fn(),
      getUserId: vi.fn(() => '@scallop:hs.example'),
      whoami: vi.fn(async () => ({ user_id: '@scallop:hs.example' })),
      sendMessage: vi.fn(async () => ({ event_id: '$evt1' })),
      sendTyping: vi.fn(async () => ({})),
      joinRoom: vi.fn(async () => ({})),
    };
    clients.push(client);
    return client;
  });
  h.modules['matrix-js-sdk'] = {
    createClient,
    ClientEvent: { Sync: 'sync', SyncUnexpectedError: 'sync.unexpectedError' },
    RoomEvent: { Timeline: 'Room.timeline' },
    RoomMemberEvent: { Membership: 'RoomMember.membership' },
  };
  return clients;
}

describe('MatrixChannel (mocked matrix-js-sdk)', () => {
  async function startMatrix(opts: { allowedUsers?: string[]; allowedRooms?: string[]; userId?: string } = {}) {
    const clients = installFakeMatrix();
    const deps = makeDeps();
    const { MatrixChannel } = await import('./matrix.js');
    const channel = new MatrixChannel({
      ...deps,
      homeserverUrl: 'https://hs.example',
      accessToken: 'syt_token',
      userId: opts.userId ?? '@scallop:hs.example',
      allowedUsers: opts.allowedUsers,
      allowedRooms: opts.allowedRooms,
    });
    await channel.start();
    return { channel, deps, client: clients.at(-1) };
  }

  const textEvent = (sender: string, body: string, type = 'm.room.message') => ({
    getType: () => type,
    getSender: () => sender,
    getContent: () => ({ msgtype: 'm.text', body }),
    getTs: () => Date.now() + 1000,
  });
  const dmRoom = { roomId: '!dm:hs.example', getJoinedMemberCount: () => 2 };

  it('waits for the initial sync and resolves its own MXID when not configured', async () => {
    const { channel, client } = await startMatrix({ userId: '' });
    expect(client.opts).toMatchObject({ baseUrl: 'https://hs.example', accessToken: 'syt_token', userId: '@scallop:hs.example' });
    expect(client.startClient).toHaveBeenCalled();
    expect(channel.getStatus().connected).toBe(true);
  });

  it('routes an allowed DM to the agent and replies in the room', async () => {
    const { channel, deps, client } = await startMatrix({ allowedUsers: ['@me:hs.example'] });
    await channel.handleTimelineEvent(textEvent('@me:hs.example', 'hi matrix'), dmRoom, false);

    expect(deps.agent.processMessage).toHaveBeenCalledWith('session-matrix:!dm:hs.example', 'hi matrix');
    expect(client.sendMessage).toHaveBeenCalledWith('!dm:hs.example', expect.objectContaining({ msgtype: 'm.text', body: 'Agent reply' }));
  });

  it('ignores senders outside the allowlist, encrypted events, and history', async () => {
    const { channel, deps, client } = await startMatrix({ allowedUsers: ['@me:hs.example'] });
    await channel.handleTimelineEvent(textEvent('@stranger:hs.example', 'hi'), dmRoom, false);
    await channel.handleTimelineEvent(textEvent('@me:hs.example', 'secret', 'm.room.encrypted'), dmRoom, false);
    await channel.handleTimelineEvent({ ...textEvent('@me:hs.example', 'old'), getTs: () => 0 }, dmRoom, false);
    expect(deps.agent.processMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('delivers proactive messages only to allowlisted rooms', async () => {
    const { channel, client } = await startMatrix({ allowedRooms: ['!dm:hs.example'] });
    await expect(channel.sendMessage('!dm:hs.example', 'reminder')).resolves.toEqual({
      sent: true, channel: 'matrix', messageIds: ['$evt1'],
    });
    await expect(channel.sendMessage('!other:hs.example', 'nope')).resolves.toBe(false);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});
