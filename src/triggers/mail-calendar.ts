/**
 * Starts the opt-in email inbox trigger and calendar heads-up from env.
 * The gateway calls this once after channels are up and `stop()` on shutdown.
 *
 *   EMAIL_INBOUND_ENABLED=true        poll the mailbox (needs EMAIL_IMAP_*)
 *   EMAIL_ALLOWED_SENDERS=a@x,@y.com  their mail becomes agent turns, replies go back by SMTP
 *   EMAIL_NOTIFY=off|important|all    note other new mail on the owner's channel
 *   EMAIL_POLL_INTERVAL_SECONDS=60
 *   EMAIL_REQUIRE_AUTH=true           require DMARC/DKIM pass for allowlisted senders
 *   CALENDAR_REMINDER_MINUTES=15      heads-up before timed events (needs a calendar)
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import { loadEmailSettings, parseAllowedSenders } from '../integrations/email/config.js';
import { resolveCalendarSource } from '../integrations/calendar/actions.js';
import { defaultInboundStateFile, EmailInbound, type EmailNotifyMode, type InboundEmail } from './email-inbound.js';
import { CalendarReminders } from './calendar-reminders.js';

export interface MailCalendarTriggerDeps {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  notifyOwner: (text: string) => Promise<unknown>;
  ownerTimeZone: () => string;
  env?: Record<string, string | undefined>;
}

export interface MailCalendarTriggers {
  stop(): void;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

function notifyMode(value: string | undefined): EmailNotifyMode {
  const mode = value?.trim().toLowerCase();
  return mode === 'important' || mode === 'all' ? mode : 'off';
}

/** One persistent session per allowlisted sender. */
export function emailSessionId(sender: string): string {
  return `email-${createHash('sha256').update(sender.toLowerCase()).digest('hex').slice(0, 20)}`;
}

/** The agent turn text for an inbound email. Never a bare "yes", so it cannot answer an approval prompt. */
export function inboundEmailPrompt(email: InboundEmail): string {
  return [
    `[Email from ${email.sender}. Your reply is sent back to them by email as plain text.]`,
    `Subject: ${email.subject || '(no subject)'}`,
    '',
    email.text || '(empty body)',
  ].join('\n');
}

export function createAgentEmailHandler(agent: Agent, sessionManager: SessionManager) {
  return async (email: InboundEmail): Promise<string | null> => {
    const sessionId = emailSessionId(email.sender);
    if (!(await sessionManager.getSession(sessionId))) {
      await sessionManager.createSession({ id: sessionId, userId: `email:${email.sender}`, channelId: 'email' });
    }
    const result = await agent.processMessage(sessionId, inboundEmailPrompt(email));
    let reply = result.response?.trim() ?? '';
    if (result.pendingApproval) {
      reply += `${reply ? '\n\n' : ''}(That step needs the owner's approval, which can't be given by email.)`;
    }
    return reply || null;
  };
}

export function startMailAndCalendarTriggers(deps: MailCalendarTriggerDeps): MailCalendarTriggers | null {
  const env = deps.env ?? process.env;
  const stoppers: Array<() => void> = [];

  if (flag(env.EMAIL_INBOUND_ENABLED, false)) {
    const settings = loadEmailSettings(env);
    if (!settings.imap) {
      deps.logger.warn('EMAIL_INBOUND_ENABLED is set but EMAIL_IMAP_HOST/USER/PASS are missing; email trigger not started');
    } else {
      const allowedSenders = parseAllowedSenders(env.EMAIL_ALLOWED_SENDERS);
      const notify = notifyMode(env.EMAIL_NOTIFY);
      const inbound = new EmailInbound({
        settings,
        allowedSenders,
        notify,
        requireAuth: flag(env.EMAIL_REQUIRE_AUTH, true),
        pollIntervalMs: Math.max(15, Number.parseInt(env.EMAIL_POLL_INTERVAL_SECONDS ?? '', 10) || 60) * 1000,
        stateFile: defaultInboundStateFile(),
        logger: deps.logger,
        handleEmail: allowedSenders.length > 0 ? createAgentEmailHandler(deps.agent, deps.sessionManager) : undefined,
        notifyOwner: deps.notifyOwner,
      });
      inbound.start();
      stoppers.push(() => inbound.stop());
      deps.logger.info({ allowedSenders: allowedSenders.length, notify, smtp: Boolean(settings.smtp) }, 'Email inbound trigger started');
    }
  }

  const leadMinutes = Number.parseInt(env.CALENDAR_REMINDER_MINUTES ?? '', 10);
  if (Number.isFinite(leadMinutes) && leadMinutes > 0) {
    const source = resolveCalendarSource({ env });
    if (source.kind === 'none') {
      deps.logger.warn('CALENDAR_REMINDER_MINUTES is set but no calendar is configured; heads-up not started');
    } else {
      const reminders = new CalendarReminders({
        source,
        leadMinutes: Math.min(leadMinutes, 24 * 60),
        timeZone: deps.ownerTimeZone,
        notifyOwner: deps.notifyOwner,
        logger: deps.logger,
      });
      reminders.start();
      stoppers.push(() => reminders.stop());
      deps.logger.info({ leadMinutes, source: source.kind }, 'Calendar heads-up started');
    }
  }

  if (stoppers.length === 0) return null;
  return { stop: () => stoppers.forEach(stop => stop()) };
}
