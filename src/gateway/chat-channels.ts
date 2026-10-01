/**
 * Chat channels beyond Telegram and the web UI: Discord, Slack, WhatsApp,
 * Signal, Matrix. Each starts only when its credentials are configured, is
 * imported lazily (so a Pi install never loads an SDK it does not use), and
 * a failure to start one is logged without taking the gateway down.
 */

import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Config } from '../config/config.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { VoiceManager } from '../voice/index.js';
import type { ChatUserMessageHook, ProactiveChatChannel } from '../channels/chat-support.js';

export interface ChatChannelDeps {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  voiceManager?: VoiceManager;
  onUserMessage?: ChatUserMessageHook;
}

export interface ChatChannelSpec {
  name: 'discord' | 'slack' | 'whatsapp' | 'signal' | 'matrix';
  create: () => Promise<ProactiveChatChannel>;
}

type ChannelsConfig = Partial<Config['channels']>;

/**
 * Specs for every chat channel that is enabled and has its credentials.
 * Enabled-but-incomplete configuration is logged and skipped.
 */
export function configuredChatChannels(channels: ChannelsConfig, deps: ChatChannelDeps): ChatChannelSpec[] {
  const { logger } = deps;
  const base = {
    agent: deps.agent,
    sessionManager: deps.sessionManager,
    logger: deps.logger,
    db: deps.db,
    onUserMessage: deps.onUserMessage,
  };
  const specs: ChatChannelSpec[] = [];

  const discord = channels.discord;
  if (discord?.enabled) {
    if (!discord.botToken) {
      logger.warn('Discord enabled but DISCORD_BOT_TOKEN is empty; skipping');
    } else {
      specs.push({
        name: 'discord',
        create: async () => {
          const { DiscordChannel } = await import('../channels/discord.js');
          return new DiscordChannel({
            ...base,
            botToken: discord.botToken,
            applicationId: discord.applicationId || undefined,
            allowedUsers: discord.allowedUsers,
          });
        },
      });
      warnIfOpen(logger, 'discord', discord.allowedUsers, 'DISCORD_ALLOWED_USERS');
    }
  }

  const slack = channels.slack;
  if (slack?.enabled) {
    if (!slack.botToken || !slack.appToken) {
      logger.warn('Slack enabled but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is empty; skipping');
    } else {
      specs.push({
        name: 'slack',
        create: async () => {
          const { SlackChannel } = await import('../channels/slack.js');
          return new SlackChannel({
            ...base,
            botToken: slack.botToken,
            appToken: slack.appToken,
            socketMode: true,
            allowedUsers: slack.allowedUsers,
          });
        },
      });
      warnIfOpen(logger, 'slack', slack.allowedUsers, 'SLACK_ALLOWED_USERS');
    }
  }

  const whatsapp = channels.whatsapp;
  if (whatsapp?.enabled) {
    // The bot links to a real WhatsApp account; without an allowlist it would
    // answer everyone who messages that account.
    if (!whatsapp.allowedNumbers?.length) {
      logger.error('WhatsApp enabled but WHATSAPP_ALLOWED_NUMBERS is empty; refusing to start it');
    } else {
      specs.push({
        name: 'whatsapp',
        create: async () => {
          const { WhatsAppChannel } = await import('../channels/whatsapp.js');
          return new WhatsAppChannel({
            ...base,
            authDir: whatsapp.authDir || undefined,
            phoneNumber: whatsapp.phoneNumber || undefined,
            allowedNumbers: whatsapp.allowedNumbers,
            voiceManager: deps.voiceManager,
          });
        },
      });
    }
  }

  const signal = channels.signal;
  if (signal?.enabled) {
    if (!signal.phoneNumber) {
      logger.warn('Signal enabled but SIGNAL_PHONE_NUMBER is empty; skipping');
    } else {
      specs.push({
        name: 'signal',
        create: async () => {
          const { SignalChannel } = await import('../channels/signal.js');
          return new SignalChannel({
            ...base,
            phoneNumber: signal.phoneNumber,
            signalCliPath: signal.cliPath || undefined,
            configPath: signal.configPath || undefined,
            allowedNumbers: signal.allowedNumbers,
            voiceManager: deps.voiceManager,
          });
        },
      });
      warnIfOpen(logger, 'signal', signal.allowedNumbers, 'SIGNAL_ALLOWED_NUMBERS');
    }
  }

  const matrix = channels.matrix;
  if (matrix?.enabled) {
    if (!matrix.homeserverUrl || !matrix.accessToken) {
      logger.warn('Matrix enabled but MATRIX_HOMESERVER_URL or MATRIX_ACCESS_TOKEN is empty; skipping');
    } else {
      specs.push({
        name: 'matrix',
        create: async () => {
          const { MatrixChannel } = await import('../channels/matrix.js');
          return new MatrixChannel({
            ...base,
            homeserverUrl: matrix.homeserverUrl,
            accessToken: matrix.accessToken,
            userId: matrix.userId || undefined,
            allowedUsers: matrix.allowedUsers,
            allowedRooms: matrix.allowedRooms,
          });
        },
      });
      warnIfOpen(logger, 'matrix', [...(matrix.allowedUsers ?? []), ...(matrix.allowedRooms ?? [])], 'MATRIX_ALLOWED_USERS');
    }
  }

  return specs;
}

function warnIfOpen(logger: Logger, channel: string, allowlist: string[] | undefined, envName: string): void {
  if (!allowlist?.length) {
    logger.warn({ channel }, `${envName} is empty: anyone who can message the bot can use it`);
  }
}

/**
 * Start every spec concurrently. Returns the channels that started; each
 * failure is logged and dropped so one bad token cannot block the rest.
 */
export async function startChatChannels(specs: ChatChannelSpec[], logger: Logger): Promise<ProactiveChatChannel[]> {
  const results = await Promise.allSettled(
    specs.map(async (spec) => {
      const channel = await spec.create();
      try {
        await channel.start();
      } catch (error) {
        await channel.stop().catch(() => {});
        throw error;
      }
      return channel;
    }),
  );

  const started: ProactiveChatChannel[] = [];
  results.forEach((result, index) => {
    const name = specs[index].name;
    if (result.status === 'fulfilled') {
      started.push(result.value);
      logger.info({ channel: name }, 'Chat channel started');
    } else {
      const reason = result.reason as Error;
      logger.error({ channel: name, error: reason?.message ?? String(reason) }, 'Chat channel failed to start; continuing without it');
    }
  });
  return started;
}
