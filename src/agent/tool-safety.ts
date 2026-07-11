import { createHash } from 'node:crypto';
import type { ToolUseContent } from '../providers/types.js';
import type { Skill } from '../skills/types.js';

/** Safety context is scoped to the latest genuine user turn. */
export interface TurnToolSafetyContext {
  userMessage: string;
  /** Last human-visible assistant reply immediately preceding this user turn. */
  previousAssistantMessage?: string;
  timezone: string;
  now?: Date;
}

export interface ToolSafetyAssessment {
  allowed: boolean;
  reason?: string;
  isMutation: boolean;
  isExternalMutation: boolean;
  signature: string;
}

export interface ToolOperationIdentity {
  operationId: string;
  userIntentDigest: string;
}

export interface BoundedToolCalls {
  accepted: ToolUseContent[];
  dropped: Array<{ toolUse: ToolUseContent; reason: 'duplicate_id' | 'duplicate_call' | 'limit' }>;
}

const READ_ONLY_TOOLS = new Set([
  'read', 'read_file', 'ls', 'glob', 'grep', 'codesearch', 'web_search',
  'webfetch', 'memory_search', 'get', 'list', 'search', 'find', 'status',
]);
const KNOWN_LOCAL_MUTATING_TOOLS = new Set([
  'apply_patch', 'board', 'edit_file', 'git', 'goals', 'manage_skills',
  'multi_edit', 'npm', 'reminder', 'run_code', 'triggers', 'write_file',
]);
const READ_ONLY_ACTION = /^(?:check|describe|fetch|get|inspect|list|read|search|show|status|view)$/i;

const EXTERNAL_TOOL_NAME =
  /(?:notion|gmail|email|calendar|slack|discord|telegram_send|send_message|send_file|publish|social|crm|airtable|drive)/i;
const MUTATING_ACTION = /^(?:add|append|archive|book|cancel|commit|complete|create|delete|deploy|edit|email|insert|install|log|mark|move|post|publish|push|record|remove|save|schedule|send|set|submit|sync|update|upload|write)$/i;
const EXPLICIT_CONFIRMATION =
  /^\s*(?:yes|yep|yeah|confirm(?:ed)?|go ahead|do it|please do|ok(?:ay)?|proceed|sounds good)\s*[.!]?\s*$/i;
const INFORMATIONAL_UPDATE_REQUEST =
  /\b(?:update|brief|tell|catch)\s+(?:me|us)\s+(?:on|about|regarding)\b/i;
const WRITE_ACTIONS =
  'add|archive|book|cancel|complete|create|delete|deploy|edit|email|insert|log|mark|post|publish|push|record|remove|save|schedule|send|set|submit|sync|update|upload|write';
const DIRECT_WRITE_REQUEST = new RegExp(
  `(?:^\\s*(?:(?:please\\s+)?|(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)|(?:i\\s+(?:want|need|would like)\\s+you\\s+to\\s+))(${WRITE_ACTIONS})\\b)`
  + `|(?:\\b(?:and|then)\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b)`
  + `|(?:[.!?;,:]\\s*(?:please\\s+)?(${WRITE_ACTIONS})\\b)`
  + `|(?:\\b(?:asked|told)\\s+you\\s+to\\s+(${WRITE_ACTIONS})\\b)`,
  'i',
);
const ANY_WRITE_ACTION = new RegExp(`\\b(${WRITE_ACTIONS})\\b`, 'i');
const CONFIRMATION_REQUEST =
  /\b(?:(?:shall|should|may|can)\s+i|(?:do|would)\s+you\s+(?:want|like)\s+me\s+to|confirm(?:ation)?|permission|okay\s+to|ok\s+to)\b/i;
const LOCAL_ACTIONS = `${WRITE_ACTIONS}|append|change|commit|copy|deploy|execute|fix|format|generate|implement|install|make|mkdir|modify|move|patch|push|refactor|rename|restore|run|test|touch|upload|work`;
const DIRECT_LOCAL_REQUEST = new RegExp(
  `(?:^\\s*(?:(?:please\\s+)?|(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?)|(?:i\\s+(?:want|need|would like)\\s+you\\s+to\\s+))(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:and|then)\\s+(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:[.!?;,:]\\s*(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:asked|told)\\s+you\\s+to\\s+(${LOCAL_ACTIONS})\\b)`,
  'i',
);
const SENSITIVE_CONTEXT =
  /\b(?:health|medical|medicine|medication|diagnos(?:is|ed)|doctor|hospital|therapy|therapist|mental health|anxiety|depress(?:ion|ed)|ill|sick|unwell|injur(?:y|ed)|pain|symptom|pregnan|period|weight|salary|bank|account number|legal case)\b/i;
const AMBIGUOUS_SHORTHAND = /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b/i;
const EXPLICIT_SET_REP_WORDING = /\b(?:sets?|reps?|repetitions?|times?|by)\b/i;

function stable(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function toolCallSignature(toolUse: ToolUseContent): string {
  return createHash('sha256')
    .update(`${toolUse.name}\n${stable(toolUse.input)}`)
    .digest('hex')
    .slice(0, 24);
}

/** Stable across process retries while retaining only hashes in durable state. */
export function toolOperationIdentity(
  sessionId: string,
  userMessage: string,
  toolUse: ToolUseContent,
): ToolOperationIdentity {
  const normalizedIntent = userMessage.trim().replace(/\s+/g, ' ').toLowerCase();
  const userIntentDigest = createHash('sha256').update(normalizedIntent).digest('hex');
  const operationId = createHash('sha256')
    .update(`tool-operation-v1\n${sessionId}\n${userIntentDigest}\n${toolCallSignature(toolUse)}`)
    .digest('hex');
  return { operationId, userIntentDigest };
}

export function digestToolOutput(output: string): { outputDigest: string; outputBytes: number } {
  return {
    outputDigest: createHash('sha256').update(output).digest('hex'),
    outputBytes: Buffer.byteLength(output, 'utf8'),
  };
}

/** Reject malformed/duplicated batches before any side effect can run. */
export function boundToolCalls(toolUses: ToolUseContent[], limit: number): BoundedToolCalls {
  const accepted: ToolUseContent[] = [];
  const dropped: BoundedToolCalls['dropped'] = [];
  const ids = new Set<string>();
  const signatures = new Set<string>();
  const safeLimit = Math.max(0, Math.floor(limit));

  for (const toolUse of toolUses) {
    if (!toolUse.id || ids.has(toolUse.id)) {
      dropped.push({ toolUse, reason: 'duplicate_id' });
      continue;
    }
    ids.add(toolUse.id);
    const signature = toolCallSignature(toolUse);
    if (signatures.has(signature)) {
      dropped.push({ toolUse, reason: 'duplicate_call' });
      continue;
    }
    signatures.add(signature);
    if (accepted.length >= safeLimit) {
      dropped.push({ toolUse, reason: 'limit' });
      continue;
    }
    accepted.push(toolUse);
  }
  return { accepted, dropped };
}

function actionFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['action', 'operation', 'method', 'command']) {
    const value = input[key];
    if (typeof value === 'string') return value.trim().split(/\s+/)[0] || null;
  }
  return null;
}

function bashCommand(toolUse: ToolUseContent): string {
  if (toolUse.name !== 'bash') return '';
  return typeof toolUse.input.command === 'string' ? toolUse.input.command : '';
}

function hasExternalShellTarget(command: string): boolean {
  return /https?:\/\/(?!localhost\b|127(?:\.\d+){3}\b|0\.0\.0\.0\b|\[?::1\]?\b)/i.test(command)
    || /\b(?:api\.|notion|gmail|calendar|slack|telegram|discord|airtable)\b/i.test(command);
}

export function isExternalBashMutation(command: string): boolean {
  if (!command) return false;
  if (/\bgit\s+push\b/i.test(command) || /\bgh\s+(?:api|pr|issue|release)\b[^\n;&|]*(?:create|edit|delete|merge|--method\s+(?:POST|PUT|PATCH|DELETE))\b/i.test(command)) {
    return true;
  }
  if (!hasExternalShellTarget(command)) return false;

  const curlWrite = /\bcurl\b[\s\S]*(?:(?:-X|--request)\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:--data(?:-raw|-binary|-urlencode)?|-d)\s)/i.test(command);
  const wgetWrite = /\bwget\b[\s\S]*(?:(?:--method(?:=|\s+))['"]?(?:POST|PUT|PATCH|DELETE)\b|--post-(?:data|file)(?:=|\s+))/i.test(command);
  const httpieWrite = /(?:^|[;&|\n]\s*)(?:http|https)\b[^\n;&|]*\b(?:POST|PUT|PATCH|DELETE)\b/i.test(command);
  const pythonWrite = /\brequests\s*\.\s*(?:post|put|patch|delete)\s*\(/i.test(command)
    || /\bhttpx\s*\.\s*(?:post|put|patch|delete)\s*\(/i.test(command)
    || /\.request\s*\(\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(command);
  const nodeWrite = /\b(?:axios|got)\s*\.\s*(?:post|put|patch|delete)\s*\(/i.test(command)
    || /\bfetch\s*\([\s\S]{0,2000}?\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(command);
  const cliWrite = /\bgh\s+api\b[^\n;&|]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(command);
  return curlWrite || wgetWrite || httpieWrite || pythonWrite || nodeWrite || cliWrite;
}

export function isLikelyMutation(toolUse: ToolUseContent, skill?: Skill | null): boolean {
  const declared = skill?.frontmatter.metadata?.openclaw?.safety;
  if (declared?.externalWrite || declared?.requiresConfirmation) return true;
  if (declared?.readOnly) return false;
  if (READ_ONLY_TOOLS.has(toolUse.name.toLowerCase())) return false;

  const action = actionFromInput(toolUse.input);
  if (action && READ_ONLY_ACTION.test(action)) return false;
  if (action && MUTATING_ACTION.test(action)) return true;
  if (toolUse.name === 'bash') {
    const command = bashCommand(toolUse);
    return isExternalBashMutation(command)
      || /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|git\s+(?:commit|push)|npm\s+install)\b/i.test(command)
      || /(?:^|[^>])>{1,2}\s*[^&]/.test(command);
  }
  if (KNOWN_LOCAL_MUTATING_TOOLS.has(toolUse.name.toLowerCase())) return true;
  return /(?:write|edit|create|delete|remove|send|post|publish|schedule|board|goal)/i.test(toolUse.name);
}

export function isLikelyExternalMutation(toolUse: ToolUseContent, skill?: Skill | null): boolean {
  const declared = skill?.frontmatter.metadata?.openclaw?.safety;
  if (declared?.readOnly) return false;
  if (declared?.externalWrite || declared?.requiresConfirmation) return true;
  if (declared?.localWrite) return false;
  if (toolUse.name === 'bash') return isExternalBashMutation(bashCommand(toolUse));
  if (toolUse.name === 'git' && /^(?:push|upload|deploy)$/i.test(actionFromInput(toolUse.input) ?? '')) return true;
  if (EXTERNAL_TOOL_NAME.test(toolUse.name)) return isLikelyMutation(toolUse, skill);
  if (!isLikelyMutation(toolUse, skill)) return false;
  // Unknown mutating integrations fail closed. A local custom skill must make
  // that confinement explicit via safety.localWrite; otherwise action=create
  // on a name such as "strava" is treated as an external write.
  return !KNOWN_LOCAL_MUTATING_TOOLS.has(toolUse.name.toLowerCase());
}

function zonedDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day') };
}

export function localIsoDate(date: Date, timezone: string, dayOffset = 0): string {
  const parts = zonedDateParts(date, timezone);
  // Noon UTC avoids DST boundary surprises while applying a calendar-day offset.
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12));
  return shifted.toISOString().slice(0, 10);
}

function collectDateArguments(value: unknown, key = '', into: string[] = []): string[] {
  if (typeof value === 'string' && /(?:date|day|when|start|timestamp)/i.test(key)) {
    const matches = value.match(/\b\d{4}-\d{2}-\d{2}\b/g);
    if (matches) into.push(...matches);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDateArguments(item, key, into);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectDateArguments(child, childKey, into);
    }
  }
  return into;
}

function expectedRelativeDate(message: string, now: Date, timezone: string): string | null {
  if (/\byesterday\b/i.test(message)) return localIsoDate(now, timezone, -1);
  if (/\btomorrow\b/i.test(message)) return localIsoDate(now, timezone, 1);
  if (/\btoday\b/i.test(message)) return localIsoDate(now, timezone, 0);
  return null;
}

function toolTargetMentioned(message: string, toolUse: ToolUseContent): boolean {
  const name = toolUse.name.toLowerCase();
  const tokens = toolUse.name.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 4);
  if (tokens.some(token => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message))) {
    return true;
  }
  if (/(?:gmail|email)/.test(name)) return /\b(?:email|gmail)\b/i.test(message);
  if (/calendar/.test(name)) return /\b(?:calendar|event|meeting|reminder)\b/i.test(message);
  if (/send_file/.test(name)) return /\b(?:attachment|file|image|pdf|photo|report|spreadsheet|video|workbook)\b/i.test(message);
  if (/send_message/.test(name)) return /\b(?:chat|message|reply|update)\b/i.test(message);
  if (name === 'bash') {
    if (/\bgit\s+push\b/i.test(bashCommand(toolUse))) {
      return /\b(?:git|repo|repository|remote|push)\b/i.test(message);
    }
    const hosts = [...bashCommand(toolUse).matchAll(/https?:\/\/([^/'"\s]+)/gi)].map(match => match[1].toLowerCase());
    return hosts.some(host => message.toLowerCase().includes(host));
  }
  return false;
}

function toolMutationAction(toolUse: ToolUseContent): string | null {
  const declared = actionFromInput(toolUse.input)?.toLowerCase() ?? null;
  if (declared && new RegExp(`^(?:${WRITE_ACTIONS})$`, 'i').test(declared)) return declared;
  if (toolUse.name === 'bash') {
    const command = bashCommand(toolUse);
    if (/\bgit\s+push\b/i.test(command)) return 'push';
    if (/\bDELETE\b/i.test(command)) return 'delete';
    if (/\b(?:PUT|PATCH)\b/i.test(command)) return 'update';
    if (/\bPOST\b/i.test(command) || /(?:--data(?:-raw|-binary|-urlencode)?|-d)\s/i.test(command)) return 'create';
  }
  if (/^(?:send_message|send_file|telegram_send)$/i.test(toolUse.name)) return 'send';
  return null;
}

function actionsCompatible(requested: string, actual: string | null): boolean {
  if (!actual || requested === actual) return true;
  const groups = [
    new Set(['add', 'book', 'create', 'insert', 'log', 'post', 'publish', 'record', 'save', 'schedule', 'submit', 'write']),
    new Set(['complete', 'edit', 'mark', 'set', 'update']),
    new Set(['archive', 'cancel', 'delete', 'remove']),
    new Set(['email', 'post', 'publish', 'send', 'submit']),
  ];
  return groups.some(group => group.has(requested) && group.has(actual));
}

function directRequestedAction(message: string): string | null {
  const match = message.match(DIRECT_WRITE_REQUEST);
  return (match?.slice(1).find(Boolean) ?? '').toLowerCase() || null;
}

function hasExplicitLocalMutationIntent(message: string): boolean {
  return DIRECT_LOCAL_REQUEST.test(message);
}

function isBoundTargetedConfirmation(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
): boolean {
  if (!EXPLICIT_CONFIRMATION.test(message) || !previousAssistantMessage) return false;
  if (!CONFIRMATION_REQUEST.test(previousAssistantMessage)) return false;
  if (!toolTargetMentioned(previousAssistantMessage, toolUse)) return false;
  const priorAction = previousAssistantMessage.match(ANY_WRITE_ACTION)?.[1]?.toLowerCase();
  return !!priorAction && actionsCompatible(priorAction, toolMutationAction(toolUse));
}

function hasExplicitExternalWriteIntent(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
): boolean {
  if (INFORMATIONAL_UPDATE_REQUEST.test(message)) return false;
  // Delivering progress into the active conversation is part of answering the
  // current turn. It still receives payload-sensitivity and idempotency checks.
  if (toolUse.name === 'send_message') return true;
  if (toolUse.name === 'send_file') {
    if (isBoundTargetedConfirmation(message, previousAssistantMessage, toolUse)) return true;
    const action = directRequestedAction(message);
    return !!action
      && actionsCompatible(action, 'send')
      && /\b(?:attach|download|file|image|pdf|photo|report|send|share|spreadsheet|video|workbook)\b/i.test(message);
  }
  if (isBoundTargetedConfirmation(message, previousAssistantMessage, toolUse)) return true;

  const requestedAction = directRequestedAction(message);
  if (!requestedAction || !actionsCompatible(requestedAction, toolMutationAction(toolUse))) return false;
  const targetIndependent = /^(?:book|deploy|log|push|record|schedule|submit|sync|upload)$/.test(requestedAction);
  const explicitPronoun = new RegExp(
    `^\\s*(?:please\\s+)?(?:${WRITE_ACTIONS})\\s+(?:it|that|this|those|these)\\b`,
    'i',
  ).test(message);
  return targetIndependent || explicitPronoun || toolTargetMentioned(message, toolUse);
}

/**
 * Fail closed only at high-confidence safety boundaries. Ordinary local file
 * edits remain autonomous; sensitive or ambiguous writes to another system do
 * not inherit intent from an older turn.
 */
export function assessToolCallForTurn(
  toolUse: ToolUseContent,
  context: TurnToolSafetyContext,
  skill?: Skill | null,
): ToolSafetyAssessment {
  const isMutation = isLikelyMutation(toolUse, skill);
  const isExternalMutation = isLikelyExternalMutation(toolUse, skill);
  const signature = toolCallSignature(toolUse);
  if (!isMutation) return { allowed: true, isMutation, isExternalMutation, signature };

  const message = context.userMessage.trim();
  const declared = skill?.frontmatter.metadata?.openclaw?.safety;
  if (!isExternalMutation) {
    if (hasExplicitLocalMutationIntent(message)) {
      return { allowed: true, isMutation, isExternalMutation, signature };
    }
    return {
      allowed: false,
      reason: 'This would mutate local state, but the current user message only asks to inspect or explain. Ask for an explicit change request before writing.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }
  const boundConfirmation = isBoundTargetedConfirmation(
    message,
    context.previousAssistantMessage,
    toolUse,
  );
  const explicitIntent = hasExplicitExternalWriteIntent(
    message,
    context.previousAssistantMessage,
    toolUse,
  );
  if (!explicitIntent) {
    return {
      allowed: false,
      reason: 'This would mutate an external service, but the current user message did not explicitly request that external write. Ask for target-specific confirmation first.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  const serializedInput = stable(toolUse.input);
  const payloadIsSensitive = declared?.sensitive || SENSITIVE_CONTEXT.test(serializedInput);
  const currentTurnAcknowledgesSensitivity = SENSITIVE_CONTEXT.test(message) || boundConfirmation;
  if (payloadIsSensitive && !currentTurnAcknowledgesSensitivity) {
    return {
      allowed: false,
      reason: 'The external payload contains sensitive information that the current user message did not acknowledge. Show what category will be written and ask for confirmation first.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  if (AMBIGUOUS_SHORTHAND.test(message) && !EXPLICIT_SET_REP_WORDING.test(message)) {
    return {
      allowed: false,
      reason: 'The current request contains ambiguous numeric shorthand (for example “4x3”). Clarify what each number means before writing structured data.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  const now = context.now ?? new Date();
  const expectedDate = expectedRelativeDate(message, now, context.timezone);
  if (expectedDate) {
    const suppliedDates = collectDateArguments(toolUse.input);
    const mismatched = suppliedDates.find((date) => date !== expectedDate);
    if (mismatched) {
      return {
        allowed: false,
        reason: `The user said a relative day, but the tool arguments use ${mismatched}. The deterministic date for this turn is ${expectedDate} in ${context.timezone}. Correct the arguments before writing.`,
        isMutation,
        isExternalMutation,
        signature,
      };
    }
  }

  return { allowed: true, isMutation, isExternalMutation, signature };
}

/** Strong evidence checks for tools whose process exited successfully. */
export function toolOutputIndicatesFailure(output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.success === false || parsed.ok === false) return true;
    const status = Number(parsed.statusCode ?? parsed.status);
    if (Number.isFinite(status) && status >= 400) return true;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return true;
  } catch {
    // Plain-text command output is handled by the narrow patterns below.
  }
  return /^(?:error|failed|failure)\b/i.test(text)
    || /\bHTTP\/\d(?:\.\d)?\s+[45]\d\d\b/i.test(text)
    || /^\s*[45]\d\d\s+(?:bad request|unauthori[sz]ed|forbidden|not found|conflict|server error)/i.test(text);
}

export function hasUnverifiedSuccessClaim(response: string): boolean {
  return /\b(?:done|successfully|saved|sent|created|updated|logged|recorded|published|scheduled|completed)\b/i.test(response)
    && !/\b(?:not|wasn't|weren't|couldn't|could not|failed|unable|unverified|can't|cannot)\b/i.test(response);
}
