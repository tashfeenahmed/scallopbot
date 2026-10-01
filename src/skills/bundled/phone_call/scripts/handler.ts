/**
 * In-process handlers for the phone_call and sms skills (Twilio).
 *
 * Numbers outside PHONE_ALLOWED_NUMBERS need an explicit approval: the first
 * attempt registers a one-tap approval prompt and refuses; once the user taps
 * yes (or types it), the re-issued call goes through. Calls and SMS are also
 * budget-checked and their estimated price is recorded in the cost tracker.
 */

import { randomBytes } from 'crypto';
import type { SkillHandlerContext, SkillHandlerFn } from '../../../types.js';
import type { ToolUseContent } from '../../../../providers/types.js';
import { APPROVAL_PROMPT_HINT, grantPatternFor } from '../../../../agent/approvals.js';
import {
  TWILIO_ESTIMATED_COST,
  TwilioClient,
  buildCallTwiml,
  isNumberAllowed,
  normalizePhoneNumber,
  type CallStateStore,
  type FetchLike,
  type TwilioConfig,
} from './twilio.js';

export interface PhoneCostLedger {
  canAfford(estimatedCost: number): { allowed: boolean; reason?: string };
  recordFlatCost(params: { model: string; provider: string; sessionId: string; cost: number }): void;
}

/** The slice of ApprovalStore these handlers use. */
export interface PhoneApprovals {
  has(userId: string, sessionId: string, pattern: string | null): boolean;
  registerPending(input: {
    sessionId: string;
    userId: string;
    toolUse: ToolUseContent;
    question: string;
    description: string;
  }): { id: string } | null;
}

export interface PhoneDeps {
  getConfig: () => TwilioConfig | null;
  state: CallStateStore;
  fetch?: FetchLike;
  costTracker?: PhoneCostLedger;
  getApprovals?: () => PhoneApprovals | undefined;
  /** Optional TTS; when it returns mp3/wav and PUBLIC_BASE_URL is set, the call plays it. */
  synthesize?: (text: string) => Promise<{ audio: Buffer; format: string } | null>;
}

const MAX_CALL_MESSAGE = 1000;
const MAX_SMS_BODY = 1600;

type Fail = { success: false; output: string; error: string };
const fail = (error: string): Fail => ({ success: false, output: '', error });

/**
 * Allowlisted numbers pass. Anything else needs a grant for exactly this
 * tool + number; without one, register the approval prompt and refuse.
 */
function checkRecipient(
  tool: 'phone_call' | 'sms',
  to: string,
  config: TwilioConfig,
  ctx: SkillHandlerContext,
  deps: PhoneDeps,
  summary: string,
): Fail | null {
  if (isNumberAllowed(config, to)) return null;
  const userId = ctx.userId ?? 'default';
  const toolUse: ToolUseContent = {
    type: 'tool_use',
    id: ctx.idempotencyKey ?? randomBytes(6).toString('hex'),
    name: tool,
    input: { ...ctx.args, to },
  };
  const pattern = grantPatternFor(toolUse);
  const approvals = deps.getApprovals?.();
  if (approvals?.has(userId, ctx.sessionId, pattern)) return null;
  const pending = approvals?.registerPending({
    sessionId: ctx.sessionId,
    userId,
    toolUse,
    question: `Do you want me to ${summary}? ${to} is not in your allowed numbers.`,
    description: summary,
  });
  return fail(
    `[TOOL_ERROR code=APPROVAL_REQUIRED] ${to} is not in PHONE_ALLOWED_NUMBERS.`
    + (pending ? ` ${APPROVAL_PROMPT_HINT} After the user approves, call ${tool} again with the same number.` : ' No approval channel is available, so this cannot proceed.'),
  );
}

function budgetCheck(deps: PhoneDeps, estimate: number, what: string): Fail | null {
  const check = deps.costTracker?.canAfford(estimate);
  if (check && !check.allowed) {
    return fail(`[TOOL_ERROR code=BUDGET_EXCEEDED] ${what} not sent: ${check.reason}. Tell the user the budget is used up; do not retry.`);
  }
  return null;
}

const AUDIO_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav' };

export function createPhoneCallHandler(deps: PhoneDeps): SkillHandlerFn {
  return async (ctx) => {
    const config = deps.getConfig();
    if (!config) return fail('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).');
    const to = normalizePhoneNumber(ctx.args.to);
    if (!to) return fail('`to` must be a phone number in international format, e.g. +447700900123');
    const message = typeof ctx.args.message === 'string' ? ctx.args.message.trim() : '';
    if (!message) return fail('Missing required parameter: message');
    if (message.length > MAX_CALL_MESSAGE) return fail(`message is too long for a call (max ${MAX_CALL_MESSAGE} characters)`);

    const blocked = checkRecipient('phone_call', to, config, ctx, deps, `call ${to} and say "${message.slice(0, 80)}"`);
    if (blocked) return blocked;
    const overBudget = budgetCheck(deps, TWILIO_ESTIMATED_COST.callPerMinute, 'Call');
    if (overBudget) return overBudget;

    const wantsReply = ctx.args.wait_for_reply === true;
    const notes: string[] = [];
    let gatherActionUrl: string | undefined;
    if (wantsReply) {
      if (config.publicBaseUrl) {
        const token = deps.state.addCall({ userId: ctx.userId ?? 'default', sessionId: ctx.sessionId, to, message });
        gatherActionUrl = `${config.publicBaseUrl}/api/twilio/gather?t=${token}`;
      } else {
        notes.push('Reply collection skipped: PUBLIC_BASE_URL is not set, so Twilio cannot reach the webhook.');
      }
    }

    let audioUrl: string | undefined;
    if (config.publicBaseUrl && deps.synthesize) {
      try {
        const speech = await deps.synthesize(message);
        const contentType = speech ? AUDIO_TYPES[speech.format.toLowerCase()] : undefined;
        if (speech && contentType) {
          audioUrl = `${config.publicBaseUrl}/api/twilio/audio/${deps.state.addClip(speech.audio, contentType)}`;
        }
      } catch {
        // Twilio's own <Say> voice is the fallback.
      }
    }

    const twiml = buildCallTwiml({ message, audioUrl, gatherActionUrl });
    let call;
    try {
      call = await new TwilioClient(config, deps.fetch ?? fetch).placeCall(to, twiml);
    } catch (error) {
      return fail((error as Error).message);
    }
    deps.costTracker?.recordFlatCost({
      model: 'voice-call',
      provider: 'twilio',
      sessionId: ctx.sessionId,
      cost: TWILIO_ESTIMATED_COST.callPerMinute,
    });
    const result = {
      call_sid: call.sid,
      status: call.status,
      to,
      voice: audioUrl ? 'scallopbot-tts' : 'twilio-say',
      reply: gatherActionUrl ? 'the reply will be sent to the user in chat when the callee answers' : 'not requested',
    };
    return { success: true, output: [JSON.stringify(result), ...notes].join('\n') };
  };
}

export function createSmsHandler(deps: PhoneDeps): SkillHandlerFn {
  return async (ctx) => {
    const config = deps.getConfig();
    if (!config) return fail('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).');
    const to = normalizePhoneNumber(ctx.args.to);
    if (!to) return fail('`to` must be a phone number in international format, e.g. +447700900123');
    const body = typeof ctx.args.message === 'string' ? ctx.args.message.trim() : '';
    if (!body) return fail('Missing required parameter: message');
    if (body.length > MAX_SMS_BODY) return fail(`message is too long (max ${MAX_SMS_BODY} characters)`);

    const blocked = checkRecipient('sms', to, config, ctx, deps, `text ${to}: "${body.slice(0, 80)}"`);
    if (blocked) return blocked;
    const segments = Math.max(1, Math.ceil(body.length / 153));
    const overBudget = budgetCheck(deps, segments * TWILIO_ESTIMATED_COST.smsPerSegment, 'SMS');
    if (overBudget) return overBudget;

    let sent;
    try {
      sent = await new TwilioClient(config, deps.fetch ?? fetch).sendSms(to, body);
    } catch (error) {
      return fail((error as Error).message);
    }
    deps.costTracker?.recordFlatCost({
      model: 'sms',
      provider: 'twilio',
      sessionId: ctx.sessionId,
      cost: sent.numSegments * TWILIO_ESTIMATED_COST.smsPerSegment,
    });
    return { success: true, output: JSON.stringify({ message_sid: sent.sid, status: sent.status, to, segments: sent.numSegments }) };
  };
}

/**
 * Place a plain spoken call to the owner (used by reminder escalation).
 * Skips silently when Twilio, the owner number or the budget is missing.
 */
export async function callOwner(deps: PhoneDeps, message: string, sessionId = 'reminder-escalation'): Promise<boolean> {
  const config = deps.getConfig();
  if (!config?.ownerNumber) return false;
  if (budgetCheck(deps, TWILIO_ESTIMATED_COST.callPerMinute, 'Call')) return false;
  const twiml = buildCallTwiml({ message: message.slice(0, MAX_CALL_MESSAGE) });
  await new TwilioClient(config, deps.fetch ?? fetch).placeCall(config.ownerNumber, twiml);
  deps.costTracker?.recordFlatCost({
    model: 'voice-call',
    provider: 'twilio',
    sessionId,
    cost: TWILIO_ESTIMATED_COST.callPerMinute,
  });
  return true;
}
