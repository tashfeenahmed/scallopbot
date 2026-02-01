import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn().mockReturnValue({
    ev: {
      on: vi.fn(),
    },
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    end: vi.fn(),
  }),
  DisconnectReason: {
    loggedOut: 401,
  },
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: {},
    saveCreds: vi.fn(),
  }),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation(() => ({
    message: vi.fn(),
    event: vi.fn(),
    command: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  LogLevel: {
    INFO: 'info',
  },
}));

vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn().mockReturnValue({
    login: vi.fn().mockResolvedValue({ access_token: 'test-token' }),
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    once: vi.fn((event, callback) => {
      if (event === 'sync') callback('PREPARED');
    }),
    on: vi.fn(),
    getUserId: vi.fn().mockReturnValue('@bot:matrix.org'),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn(),
    joinRoom: vi.fn().mockResolvedValue(undefined),
  }),
  ClientEvent: {
    Sync: 'sync',
    SyncUnexpectedError: 'syncError',
  },
  RoomEvent: {
    Timeline: 'Room.timeline',
  },
  RoomMemberEvent: {
    Membership: 'RoomMember.membership',
  },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn(),
    kill: vi.fn(),
  }),
}));

vi.mock('../voice/index.js', () => ({
  VoiceManager: {
    fromEnv: vi.fn().mockReturnValue({
      isAvailable: vi.fn().mockResolvedValue({ stt: false, tts: false }),
      transcribe: vi.fn(),
    }),
  },
}));

const createMockLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

const createMockAgent = () => ({
  processMessage: vi.fn().mockResolvedValue({
    response: 'Test response',
    tokenUsage: { input: 10, output: 20 },
  }),
});

const createMockSessionManager = () => ({
  createSession: vi.fn().mockResolvedValue({ id: 'test-session' }),
  getSession: vi.fn().mockResolvedValue(null),
  deleteSession: vi.fn().mockResolvedValue(true),
});

describe('Channel Types', () => {
  it('should export channel interfaces', async () => {
    const types = await import('./types.js');

    expect(types).toBeDefined();
  });
});

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create channel with options', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
    });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('whatsapp');
  });

  it('should normalize phone numbers', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      allowedNumbers: ['+1-234-567-8900', '9876543210'],
    });

    expect(channel).toBeDefined();
  });

  it('should report not running initially', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
    });

    expect(channel.isRunning()).toBe(false);
  });

  it('should get status', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
    });

    const status = channel.getStatus();

    expect(status.connected).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.lastActivity).toBeDefined();
  });

  it('should get or create session', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
    });

    const sessionId = await channel.getOrCreateSession('1234567890');

    expect(sessionId).toBe('test-session');
    expect(mockSessionManager.createSession).toHaveBeenCalledWith({
      userId: '1234567890',
      channelId: 'whatsapp',
    });
  });

  it('should handle reset', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
    });

    // First create a session
    await channel.getOrCreateSession('1234567890');

    // Then reset
    await channel.handleReset('1234567890');

    expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('test-session');
  });

  it('should report voice support correctly', async () => {
    const { WhatsAppChannel } = await import('./whatsapp.js');

    const channel = new WhatsAppChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      enableVoice: false,
    });

    expect(channel.supportsVoice()).toBe(false);
  });
});

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create channel with bot token', async () => {
    const { SlackChannel } = await import('./slack.js');

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
    });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('slack');
  });

  it('should report not running initially', async () => {
    const { SlackChannel } = await import('./slack.js');

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
    });

    expect(channel.isRunning()).toBe(false);
  });

  it('should get status', async () => {
    const { SlackChannel } = await import('./slack.js');

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
    });

    const status = channel.getStatus();

    expect(status.connected).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it('should throw if deps not installed on start', async () => {
    const { SlackChannel } = await import('./slack.js');

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
    });

    // Dependencies aren't installed in test environment
    await expect(channel.start()).rejects.toThrow('Slack dependencies not installed');
  });

  it('should get or create session', async () => {
    const { SlackChannel } = await import('./slack.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
    });

    const sessionId = await channel.getOrCreateSession('U12345');

    expect(sessionId).toBe('test-session');
    expect(mockSessionManager.createSession).toHaveBeenCalledWith({
      userId: 'U12345',
      channelId: 'slack',
    });
  });

  it('should handle reset', async () => {
    const { SlackChannel } = await import('./slack.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new SlackChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      botToken: 'xoxb-test-token',
    });

    await channel.getOrCreateSession('U12345');
    await channel.handleReset('U12345');

    expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('test-session');
  });
});

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create channel with phone number', async () => {
    const { SignalChannel } = await import('./signal.js');

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
    });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('signal');
  });

  it('should normalize phone numbers', async () => {
    const { SignalChannel } = await import('./signal.js');

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
      allowedNumbers: ['1-555-123-4567', '+44 20 7946 0958'],
    });

    expect(channel).toBeDefined();
  });

  it('should report not running initially', async () => {
    const { SignalChannel } = await import('./signal.js');

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
    });

    expect(channel.isRunning()).toBe(false);
  });

  it('should get status', async () => {
    const { SignalChannel } = await import('./signal.js');

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
    });

    const status = channel.getStatus();

    expect(status.connected).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it('should get or create session with normalized number', async () => {
    const { SignalChannel } = await import('./signal.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
    });

    const sessionId = await channel.getOrCreateSession('+1-555-123-4567');

    expect(sessionId).toBe('test-session');
    expect(mockSessionManager.createSession).toHaveBeenCalledWith({
      userId: '+15551234567',
      channelId: 'signal',
    });
  });

  it('should handle reset', async () => {
    const { SignalChannel } = await import('./signal.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
    });

    await channel.getOrCreateSession('+15551234567');
    await channel.handleReset('+15551234567');

    expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('test-session');
  });

  it('should report voice support correctly', async () => {
    const { SignalChannel } = await import('./signal.js');

    const channel = new SignalChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      phoneNumber: '+1234567890',
      enableVoice: false,
    });

    expect(channel.supportsVoice()).toBe(false);
  });
});

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create channel with homeserver URL', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-token',
    });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('matrix');
  });

  it('should report not running initially', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
    });

    expect(channel.isRunning()).toBe(false);
  });

  it('should get status', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
    });

    const status = channel.getStatus();

    expect(status.connected).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it('should throw if deps not installed on start', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-token',
    });

    // Dependencies aren't installed in test environment
    await expect(channel.start()).rejects.toThrow('Matrix dependencies not installed');
  });

  it('should get or create session by room', async () => {
    const { MatrixChannel } = await import('./matrix.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
    });

    const sessionId = await channel.getOrCreateSession('!room:matrix.org');

    expect(sessionId).toBe('test-session');
    expect(mockSessionManager.createSession).toHaveBeenCalledWith({
      userId: '!room:matrix.org',
      channelId: 'matrix',
    });
  });

  it('should handle reset', async () => {
    const { MatrixChannel } = await import('./matrix.js');
    const mockSessionManager = createMockSessionManager();

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: mockSessionManager as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
    });

    await channel.getOrCreateSession('!room:matrix.org');
    await channel.handleReset('!room:matrix.org');

    expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('test-session');
  });

  it('should configure auto-join', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
      autoJoin: false,
    });

    expect(channel).toBeDefined();
  });

  it('should configure allowed rooms', async () => {
    const { MatrixChannel } = await import('./matrix.js');

    const channel = new MatrixChannel({
      agent: createMockAgent() as any,
      sessionManager: createMockSessionManager() as any,
      logger: createMockLogger() as any,
      homeserverUrl: 'https://matrix.org',
      allowedRooms: ['!allowed1:matrix.org', '!allowed2:matrix.org'],
    });

    expect(channel).toBeDefined();
  });
});

describe('Channel Index Exports', () => {
  it('should export all channel types', async () => {
    const channels = await import('./index.js');

    // Types
    expect(channels).toBeDefined();

    // Telegram
    expect(channels.TelegramChannel).toBeDefined();
    expect(channels.formatMarkdownToHtml).toBeDefined();
    expect(channels.splitMessage).toBeDefined();

    // CLI
    expect(channels.CLIChannel).toBeDefined();
    expect(channels.parseCommand).toBeDefined();

    // Discord
    expect(channels.DiscordChannel).toBeDefined();

    // WhatsApp
    expect(channels.WhatsAppChannel).toBeDefined();

    // Slack
    expect(channels.SlackChannel).toBeDefined();

    // Signal
    expect(channels.SignalChannel).toBeDefined();

    // Matrix
    expect(channels.MatrixChannel).toBeDefined();
  });
});
