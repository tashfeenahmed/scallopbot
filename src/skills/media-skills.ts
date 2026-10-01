/**
 * Wires the media skills (image_gen, phone_call, sms) into a running gateway.
 *
 * The skills are bundled as SKILL.md + scripts/ like every other bundled
 * skill, so their description and input schema come from disk. Their work
 * needs live runtime objects (cost tracker, approval store, channel delivery,
 * webhook server), so the gateway re-registers each one as an in-process
 * skill with a native handler. SDK-sourced entries survive reloadFromDisk().
 */

import type { Logger } from 'pino';
import type { SkillRegistry } from './registry.js';
import type { SkillHandlerContext, SkillHandlerFn } from './types.js';
import { createImageGenHandler, type ImageCostLedger } from './bundled/image_gen/scripts/handler.js';
import { selectImageProvider } from './bundled/image_gen/scripts/providers.js';
import { callOwner, createPhoneCallHandler, createSmsHandler, type PhoneApprovals, type PhoneDeps } from './bundled/phone_call/scripts/handler.js';
import {
  CallStateStore,
  createTwilioWebhook,
  twilioConfigFromEnv,
  type TwilioWebhookHandler,
} from './bundled/phone_call/scripts/twilio.js';
import { messageWasDelivered, type MessageDeliveryHandler } from '../triggers/types.js';

export interface MediaSkillDeps {
  registry: SkillRegistry;
  logger?: Logger;
  costTracker?: ImageCostLedger;
  deliverFile?: (userId: string, filePath: string, caption: string | undefined, ctx: SkillHandlerContext) => Promise<boolean>;
  getApprovals?: () => PhoneApprovals | undefined;
  /** Send a plain chat message to a user (call replies). */
  notify?: (userId: string, text: string) => Promise<unknown>;
  synthesize?: PhoneDeps['synthesize'];
  env?: Record<string, string | undefined>;
}

export interface MediaSkills {
  /** Mounted by the API server under /api/twilio/. */
  twilioWebhook: TwilioWebhookHandler;
  /** Wrap the scheduler's delivery handler to escalate opted-in reminders to a call. */
  withReminderCalls: (handler: MessageDeliveryHandler) => MessageDeliveryHandler;
}

function overrideWithHandler(
  registry: SkillRegistry,
  name: string,
  handler: SkillHandlerFn,
  availability?: { available: boolean; reason?: string },
): boolean {
  const disk = registry.getSkill(name);
  if (!disk) return false;
  const available = availability?.available ?? disk.available;
  registry.registerSkill({
    ...disk,
    source: 'sdk',
    hasScripts: true,
    handler,
    available,
    unavailableReason: available ? undefined : (availability?.reason ?? disk.unavailableReason),
  });
  return true;
}

const REMINDER_CALL_TAG = /\b(?:call|phone|ring)\s+me\b|\burgent\b/i;

export function registerMediaSkills(deps: MediaSkillDeps): MediaSkills {
  const env = deps.env ?? process.env;
  const getConfig = () => twilioConfigFromEnv(env);

  const provider = selectImageProvider(env);
  overrideWithHandler(
    deps.registry,
    'image_gen',
    createImageGenHandler({ costTracker: deps.costTracker, deliverFile: deps.deliverFile, env }),
    'error' in provider ? { available: false, reason: provider.error } : { available: true },
  );

  const state = new CallStateStore();
  const phoneDeps: PhoneDeps = {
    getConfig,
    state,
    costTracker: deps.costTracker,
    getApprovals: deps.getApprovals,
    synthesize: deps.synthesize,
  };
  overrideWithHandler(deps.registry, 'phone_call', createPhoneCallHandler(phoneDeps));
  overrideWithHandler(deps.registry, 'sms', createSmsHandler(phoneDeps));

  const twilioWebhook = createTwilioWebhook({
    getConfig,
    state,
    notify: async (userId, text) => {
      await deps.notify?.(userId, text);
    },
  });

  const withReminderCalls = (handler: MessageDeliveryHandler): MessageDeliveryHandler => {
    const wrapped: MessageDeliveryHandler = async (userId, message, metadata) => {
      const result = await handler(userId, message, metadata);
      const mode = (env.PHONE_REMINDER_CALLS ?? 'off').trim().toLowerCase();
      const reminderText = metadata?.outcome?.activeRequest ?? message;
      const isUserReminder = metadata?.outcome?.source === 'scheduler' && metadata.outcome.explicitUserText === true;
      if (
        messageWasDelivered(result)
        && isUserReminder
        && (mode === 'all' || (mode === 'tagged' && REMINDER_CALL_TAG.test(reminderText)))
      ) {
        const spoken = message.replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim();
        void callOwner(phoneDeps, `This is ScallopBot with a reminder. ${spoken}`, metadata?.outcome?.sessionId)
          .then(placed => {
            if (placed) deps.logger?.info({ userId }, 'Reminder escalated to a phone call');
          })
          .catch(err => deps.logger?.warn({ error: (err as Error).message }, 'Reminder call escalation failed'));
      }
      return result;
    };
    if (handler.supportsDeliveryMetadata) wrapped.supportsDeliveryMetadata = true;
    return wrapped;
  };

  return { twilioWebhook, withReminderCalls };
}
