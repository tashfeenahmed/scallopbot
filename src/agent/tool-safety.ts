import { createHash } from 'node:crypto';
import type { ToolUseContent } from '../providers/types.js';
import type { Skill } from '../skills/types.js';

/** Safety context is scoped to the latest genuine user turn. */
export interface TurnToolSafetyContext {
  userMessage: string;
  /** Last human-visible assistant reply immediately preceding this user turn. */
  previousAssistantMessage?: string;
  /**
   * Exact externally-mutating tool most recently verified in this session.
   * Used only to bind a terse continuation to the same destination.
   */
  continuationMutationTool?: string;
  timezone: string;
  now?: Date;
}

export interface ToolSafetyAssessment {
  allowed: boolean;
  /** Optional typed reason more specific than local/external intent. */
  code?: string;
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

export interface BoundedResponseToolCalls extends BoundedToolCalls {
  anomalousBurst: boolean;
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
const MUTATING_ACTION = /^(?:add|append|archive|book|cancel|commit|complete|create|delete|deploy|document|edit|email|insert|install|invite|log|mark|move|note|post|publish|push|record|register|remove|reply|save|schedule|send|set|share|submit|sync|track|update|upload|write)$/i;
const EXPLICIT_CONFIRMATION =
  /^\s*(?:yes|yep|yeah|confirm(?:ed)?|go ahead|do it|please do|ok(?:ay)?|proceed|sounds good)\s*[.!]?\s*$/i;
const INFORMATIONAL_UPDATE_REQUEST =
  /\b(?:update|brief|tell|catch)\s+(?:me|us)\s+(?:on|about|regarding)\b/i;
const WRITE_ACTIONS =
  'add|archive|book|cancel|complete|create|delete|deploy|document|edit|email|insert|install|invite|log|mark|note|post|publish|push|record|register|remove|reply|save|schedule|send|set|share|submit|sync|track|update|upload|write';
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
const LOCAL_ACTIONS = `${WRITE_ACTIONS}|append|build|change|commit|compile|copy|deploy|execute|export|fix|format|generate|implement|install|make|mkdir|modify|move|patch|push|refactor|render|rename|restore|run|test|touch|upload|work`;
const DIRECT_LOCAL_REQUEST = new RegExp(
  `(?:^\\s*(?:(?:please\\s+)?|(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?)|(?:i\\s+(?:want|need|would like)\\s+you\\s+to\\s+))(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:and|then)\\s+(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:[.!?;,:]\\s*(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:asked|told)\\s+you\\s+to\\s+(${LOCAL_ACTIONS})\\b)`,
  'i',
);
const SENSITIVE_CONTEXT =
  /\b(?:health|medical|medicine|medication|diagnos(?:is|ed)|doctor|hospital|therapy|therapist|mental health|anxiety|depress(?:ion|ed)|ill|sick|unwell|injur(?:y|ed)|pain|symptom|pregnan|period|weight|gym|workout|exercise|salary|bank|account number|legal case)\b/i;
const AMBIGUOUS_SHORTHAND = /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b/i;
const EXPLICIT_SET_REP_WORDING = /\b(?:sets?|reps?|repetitions?|times?|by)\b/i;
const STANDARD_THREE_PART_WORKOUT = /(?:\b\d+(?:\.\d+)?\s*(?:kg|lb|lbs)\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:kg|lb|lbs)\b)/i;

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

/**
 * Reject an anomalously large model-authored response as a whole. This avoids
 * executing an arbitrary prefix while allowing unlimited progressive batches
 * across later agent iterations.
 */
export function boundResponseToolCalls(
  toolUses: ToolUseContent[],
  maxCallsPerResponse: number,
): BoundedResponseToolCalls {
  const safeMax = Math.max(0, Math.floor(maxCallsPerResponse));
  const anomalousBurst = toolUses.length > safeMax;
  return {
    ...boundToolCalls(toolUses, anomalousBurst ? 0 : safeMax),
    anomalousBurst,
  };
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

function executableContent(toolUse: ToolUseContent): string {
  if (toolUse.name === 'bash') return bashCommand(toolUse);
  if (toolUse.name === 'run_code' && typeof toolUse.input.code === 'string') {
    return toolUse.input.code;
  }
  return '';
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

  // Some APIs use POST for read-only queries. In particular, Notion's legacy
  // database and current data-source query endpoints do not mutate state.
  // Only apply the exception when every external URL in the command is one of
  // those query endpoints so a mixed query/create script still fails closed.
  const externalUrls = [...command.matchAll(/https?:\/\/[^\s'"\\]+/gi)]
    .map(match => match[0].replace(/[),.;]+$/, ''));
  const destructiveQueryMethod = /(?:(?:-X|--request)\s*['"]?(?:PUT|PATCH|DELETE)\b|\b(?:requests|httpx|axios|got)\s*\.\s*(?:put|patch|delete)\s*\(|\bfetch\s*\([\s\S]{0,2000}?\bmethod\s*:\s*['"](?:PUT|PATCH|DELETE)['"])/i.test(command);
  const notionReadOnlyPostsOnly = !destructiveQueryMethod
    && externalUrls.length > 0
    && externalUrls.every(url =>
      /^https:\/\/api\.notion\.com\/v1\/(?:databases|data_sources)\/[^/\s]+\/query(?:\?|$)/i.test(url)
      || /^https:\/\/api\.notion\.com\/v1\/search(?:\?|$)/i.test(url),
    );
  if (notionReadOnlyPostsOnly) return false;

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
    const commandWithoutNullRedirection = command.replace(/(?:\d?>|&>)\s*\/dev\/null\b/g, '');
    return isExternalBashMutation(command)
      || /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|git\s+(?:commit|push)|npm\s+install)\b/i.test(command)
      || /(?:^|[^>])>{1,2}\s*[^&]/.test(commandWithoutNullRedirection);
  }
  if (toolUse.name === 'run_code' && isExternalBashMutation(executableContent(toolUse))) {
    return true;
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
  if (toolUse.name === 'run_code') return isExternalBashMutation(executableContent(toolUse));
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
    const command = executableContent(toolUse);
    if (/\bgit\s+push\b/i.test(command)) {
      return /\b(?:git|repo|repository|remote|push)\b/i.test(message);
    }
    const hosts = [...command.matchAll(/https?:\/\/([^/'"\s]+)/gi)].map(match => match[1].toLowerCase());
    return hosts.some(host => {
      if (message.toLowerCase().includes(host)) return true;
      const serviceTokens = host.split('.').filter(token =>
        token.length >= 4 && !['api', 'www', 'com', 'org', 'net', 'cloud'].includes(token),
      );
      return serviceTokens.some(token => new RegExp(`\\b${token}\\b`, 'i').test(message));
    });
  }
  if (name === 'run_code') {
    const code = executableContent(toolUse);
    const hosts = [...code.matchAll(/https?:\/\/([^/'"\s]+)/gi)].map(match => match[1].toLowerCase());
    return hosts.some(host => {
      const serviceTokens = host.split('.').filter(token =>
        token.length >= 4 && !['api', 'www', 'com', 'org', 'net', 'cloud'].includes(token),
      );
      return message.toLowerCase().includes(host)
        || serviceTokens.some(token => new RegExp(`\\b${token}\\b`, 'i').test(message));
    });
  }
  return false;
}

function toolMutationAction(toolUse: ToolUseContent): string | null {
  const declared = actionFromInput(toolUse.input)?.toLowerCase() ?? null;
  if (declared && new RegExp(`^(?:${WRITE_ACTIONS})$`, 'i').test(declared)) return declared;
  if (toolUse.name === 'bash' || toolUse.name === 'run_code') {
    const command = executableContent(toolUse);
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
    new Set(['add', 'book', 'create', 'document', 'insert', 'log', 'note', 'post', 'publish', 'record', 'register', 'save', 'schedule', 'submit', 'track', 'write']),
    new Set(['complete', 'edit', 'mark', 'set', 'update']),
    new Set(['archive', 'cancel', 'delete', 'remove']),
    new Set(['email', 'invite', 'post', 'publish', 'reply', 'send', 'share', 'submit']),
  ];
  return groups.some(group => group.has(requested) && group.has(actual));
}

function directRequestedAction(message: string): string | null {
  const match = message.match(DIRECT_WRITE_REQUEST);
  const direct = (match?.slice(1).find(Boolean) ?? '').toLowerCase();
  if (direct) return direct;

  // Natural requests often include a discourse prefix ("For today, can you
  // log...") or explicit authorization language. They are just as clear as an
  // imperative and must not force the user into a magic-word loop.
  const naturalPatterns = [
    new RegExp(`\\b(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b`, 'i'),
    new RegExp(`^\\s*(?:yes|yep|yeah|ok(?:ay)?|sure|confirmed?)[,!]?\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b`, 'i'),
    new RegExp(`\\b(?:authorize|instruct|ask|tell)\\s+(?:you|the\\s+agent|this\\s+bot)\\s+to\\s+(${WRITE_ACTIONS})\\b`, 'i'),
  ];
  for (const pattern of naturalPatterns) {
    const natural = message.match(pattern)?.[1]?.toLowerCase();
    if (natural) return natural;
  }
  return null;
}

function hasExplicitLocalMutationIntent(message: string): boolean {
  return DIRECT_LOCAL_REQUEST.test(message);
}

function isPlanningTool(toolUse: ToolUseContent): boolean {
  return /^(?:board|goals|reminder|triggers)$/i.test(toolUse.name);
}

function isTaskList(message: string): boolean {
  const lines = message.split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(line => line.length > 0 && line.length <= 180);
  return lines.length >= 2;
}

/** A reply to a planning check-in is an instruction to capture the plan. */
function hasImplicitPlanningMutationIntent(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
): boolean {
  if (!isPlanningTool(toolUse)) return false;
  const conversation = `${previousAssistantMessage ?? ''}\n${message}`;
  const priorPlanningPrompt = !!previousAssistantMessage
    && /\b(?:main focus|priorit(?:y|ies)|plan|agenda|tasks?|to-?do|board|reminder)\b/i.test(previousAssistantMessage);
  const explicitlyPlanning = /\b(?:board|reminder|task|to-?do|plan|agenda|priorit(?:y|ies)|schedule)\b/i.test(message);
  if (
    !priorPlanningPrompt
    && !explicitlyPlanning
    && /\b(?:workout|exercise|gym|notion|tracker|database|log(?:ged|ging)?)\b/i.test(conversation)
  ) {
    return false;
  }
  const hasClockTime = /\b(?:at\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)\b/i.test(message);
  const timedItem = hasClockTime
    && /\b(?:remind|schedule|put|call|meet(?:ing)?|appointment|deadline|due|take|pick up|send|submit)\b/i.test(message);
  const correctionContinuation = !!previousAssistantMessage
    && /\b(?:board|reminder|task|nudge|add|schedule)\b/i.test(previousAssistantMessage)
    && /\b(?:not done|isn['’]?t done|new day|today|tomorrow|instead|change|correct)\b/i.test(message);
  return (priorPlanningPrompt && isTaskList(message)) || timedItem || correctionContinuation;
}

function planningToolClaimsCompletion(toolUse: ToolUseContent): boolean {
  if (!isPlanningTool(toolUse)) return false;
  const action = actionFromInput(toolUse.input) ?? '';
  const state = [toolUse.input.status, toolUse.input.column]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /^(?:complete|completed|done)$/i.test(action) || /\b(?:complete|completed|done)\b/i.test(state);
}

function currentTurnStatesCompletion(message: string): boolean {
  if (/\b(?:not|isn['’]?t|wasn['’]?t)\s+(?:done|finished|complete|completed)\b/i.test(message)) return false;
  return /\b(?:done|finished|complete|completed|already did|did it|have done|has been done)\b/i.test(message);
}

/** Telegram/API reply wrappers are context, not the current instruction. */
export function currentInstruction(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('[Replying to ')) return trimmed;
  const closingQuote = trimmed.lastIndexOf('"]');
  if (closingQuote < 0) return trimmed;
  const tail = trimmed.slice(closingQuote + 2).trim();
  return tail || trimmed;
}

function isCorrectiveFollowUp(message: string, previousAssistantMessage?: string): boolean {
  if (!previousAssistantMessage) return false;
  const correction = /\b(?:incorrect|wrong|old|broken|failed|not the|didn['’]?t|doesn['’]?t|you (?:sent|made|created|used))\b/i.test(message);
  const priorArtifactAction = /\b(?:built|created|generated|made|saved|sent|file|pdf|report|document|artifact)\b/i.test(previousAssistantMessage);
  return correction && priorArtifactAction;
}

function isBoundTargetedConfirmation(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
): boolean {
  if (!EXPLICIT_CONFIRMATION.test(message) || !previousAssistantMessage) return false;
  if (!CONFIRMATION_REQUEST.test(previousAssistantMessage)) return false;
  if (!toolTargetMentioned(previousAssistantMessage, toolUse)) return false;
  // Prefer a direct target-specific request ("Confirm: send the PDF") over
  // incidental safety prose such as "external write" earlier in the message.
  const priorAction = directRequestedAction(previousAssistantMessage)
    ?? [...previousAssistantMessage.matchAll(new RegExp(ANY_WRITE_ACTION.source, 'ig'))]
      .at(-1)?.[1]?.toLowerCase();
  return !!priorAction && actionsCompatible(priorAction, toolMutationAction(toolUse));
}

function hasExplicitExternalWriteIntent(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
  continuationMutationTool?: string,
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
  if (
    previousAssistantMessage
    && turnRequiresMutationReceipt(message, previousAssistantMessage, continuationMutationTool)
    && (
      toolTargetMentioned(previousAssistantMessage, toolUse)
      || (
        continuationMutationTool?.toLocaleLowerCase('en-US') === toolUse.name.toLocaleLowerCase('en-US')
        && (
          (/notion/i.test(toolUse.name) && /\b(?:notion|tracker|database|workout log|exercise(?:s| log)?)\b/i.test(previousAssistantMessage))
          || (/gmail|email/i.test(toolUse.name) && /\b(?:gmail|e-?mail|inbox|message)\b/i.test(previousAssistantMessage))
          || (/calendar/i.test(toolUse.name) && /\b(?:calendar|appointment|event|meeting)\b/i.test(previousAssistantMessage))
          || (/slack/i.test(toolUse.name) && /\b(?:slack|channel|workspace)\b/i.test(previousAssistantMessage))
          || (/airtable/i.test(toolUse.name) && /\b(?:airtable|base|table|tracker)\b/i.test(previousAssistantMessage))
        )
      )
    )
  ) {
    return true;
  }

  const requestedAction = directRequestedAction(message);
  if (!requestedAction || !actionsCompatible(requestedAction, toolMutationAction(toolUse))) return false;
  const targetIndependent = /^(?:book|deploy|document|invite|log|note|push|record|register|reply|schedule|share|submit|sync|track|upload)$/.test(requestedAction);
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

  const message = currentInstruction(context.userMessage);
  const declared = skill?.frontmatter.metadata?.openclaw?.safety;
  if (!isExternalMutation) {
    if (hasExplicitLocalMutationIntent(message)
      || hasImplicitPlanningMutationIntent(message, context.previousAssistantMessage, toolUse)
      || isCorrectiveFollowUp(message, context.previousAssistantMessage)) {
      if (planningToolClaimsCompletion(toolUse) && !currentTurnStatesCompletion(message)) {
        return {
          allowed: false,
          code: 'TASK_COMPLETION_EVIDENCE_REQUIRED',
          reason: 'The tool call marks a current task complete, but the current user turn does not say it is complete. Create or keep it pending; never infer today’s completion from older memory.',
          isMutation,
          isExternalMutation,
          signature,
        };
      }
      return { allowed: true, isMutation, isExternalMutation, signature };
    }
    return {
      allowed: false,
      reason: 'This local write is outside the current user request. Do not execute it and do not ask for permission; continue only with the requested outcome.',
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
    context.continuationMutationTool,
  );
  if (!explicitIntent) {
    return {
      allowed: false,
      reason: 'This external write is outside the current user request. Do not execute it and do not ask for permission to expand scope; continue only with the requested outcome or ask what outcome the user wants.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  const serializedInput = stable(toolUse.input);
  const payloadIsSensitive = declared?.sensitive || SENSITIVE_CONTEXT.test(serializedInput);
  const affirmativeFollowUp = /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|confirmed?)\b/i.test(message);
  const currentTurnAcknowledgesSensitivity = SENSITIVE_CONTEXT.test(message)
    || STANDARD_THREE_PART_WORKOUT.test(message)
    || /\b\d+(?:\.\d+)?\s*(?:kg|lb|lbs)\b/i.test(message)
    || boundConfirmation
    || (explicitIntent
      && affirmativeFollowUp
      && !!context.previousAssistantMessage
      && SENSITIVE_CONTEXT.test(context.previousAssistantMessage));
  if (payloadIsSensitive && !currentTurnAcknowledgesSensitivity) {
    return {
      allowed: false,
      reason: 'The external payload introduces sensitive information outside the current user request. Remove that extra information or ask which factual value should be used; do not ask for permission to write the already-requested data.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  if (
    AMBIGUOUS_SHORTHAND.test(message)
    && !EXPLICIT_SET_REP_WORDING.test(message)
    && !STANDARD_THREE_PART_WORKOUT.test(message)
  ) {
    return {
      allowed: false,
      reason: 'The current request contains ambiguous numeric shorthand (for example “4x3”). Clarify what each number means before writing structured data.',
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  // Structured logging must preserve the user's own exercise label. Models
  // sometimes invent a modality (for example "Dumbbell" or "each arm") that
  // changes the meaning of the recorded data even though the numbers match.
  if (/notion/i.test(toolUse.name) && STANDARD_THREE_PART_WORKOUT.test(message)) {
    const serialized = stable(toolUse.input);
    const qualifiers = [
      'barbell', 'cable', 'decline', 'dumbbell', 'each arm', 'incline',
      'machine', 'seated', 'standing', 'unilateral',
    ];
    const invented = qualifiers.find(qualifier => (
      new RegExp(`\\b${qualifier.replace(' ', '\\s+')}\\b`, 'i').test(serialized)
      && !new RegExp(`\\b${qualifier.replace(' ', '\\s+')}\\b`, 'i').test(message)
    ));
    if (invented) {
      return {
        allowed: false,
        code: 'STRUCTURED_LABEL_EXPANSION',
        reason: `The tool arguments add the unsupported workout qualifier "${invented}". Preserve the exercise label exactly as the user supplied it.`,
        isMutation,
        isExternalMutation,
        signature,
      };
    }
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
  return /(?:^|\n)\s*(?:error|failed|failure)\b/i.test(text)
    || /\b(?:id|result|status)\s*:\s*error\b/i.test(text)
    || /\bHTTP\/\d(?:\.\d)?\s+[45]\d\d\b/i.test(text)
    || /^\s*[45]\d\d\s+(?:bad request|unauthori[sz]ed|forbidden|not found|conflict|server error)/i.test(text);
}

export function hasUnverifiedSuccessClaim(response: string): boolean {
  return /\b(?:done|successfully|saved|sent|created|updated|logged|recorded|published|scheduled|completed)\b/i.test(response)
    && !/\b(?:not|wasn't|weren't|couldn't|could not|failed|unable|unverified|can't|cannot)\b/i.test(response);
}

const WORKOUT_COMPARISON = /\b(?:PR|personal record|record high|increase[sd]?|improv(?:e[dm]?|ement)|jump(?:ed)?|up\s+\d+(?:\.\d+)?\s*kg|added\s+\d+(?:\.\d+)?\s*kg|more than last)\b/i;
const WORKOUT_SUBJECT = /\b(?:workout|exercise|press|row|curl|squat|deadlift|machine|cable|kg|reps?|sets?)\b/i;

/**
 * Remove comparison claims that have neither a current user assertion nor a
 * successful tracker query in this turn. A write receipt proves persistence,
 * not a PR or trend.
 */
export function removeUnsupportedWorkoutComparisons(
  response: string,
  userMessage: string,
  hasTrackerQueryEvidence: boolean,
): { response: string; removed: boolean } {
  if (hasTrackerQueryEvidence || WORKOUT_COMPARISON.test(userMessage)) {
    return { response, removed: false };
  }
  const pieces = response.split(/(?<=[.!?])\s+|\s+[—;]\s+/);
  const filtered = pieces.filter(piece => !(WORKOUT_COMPARISON.test(piece) && WORKOUT_SUBJECT.test(piece)));
  if (filtered.length === pieces.length) return { response, removed: false };
  return { response: filtered.join(' ').trim(), removed: true };
}

/**
 * Determine whether this turn promises a state change whose completion must be
 * backed by a successful tool receipt. This also covers terse continuation
 * payloads (for example another workout row after "anything else to add?").
 */
export function turnRequiresMutationReceipt(
  userMessage: string,
  previousAssistantMessage?: string,
  continuationMutationTool?: string,
): boolean {
  const message = currentInstruction(userMessage);
  // A successful mutation receipt is required for writes, not merely for any
  // locally executable request. In particular, "run", "test", "inspect", and
  // "use" may execute tools without changing state. Treating those as writes
  // caused the agent to repeat successful read-only tool calls and could consume
  // mock/provider responses without ever producing a final answer.
  if (directRequestedAction(message) && !INFORMATIONAL_UPDATE_REQUEST.test(message)) return true;

  if (isTaskList(message) && /\b(?:priorit|plan|task|deadline|today|board)\b/i.test(previousAssistantMessage ?? '')) {
    return true;
  }

  const previous = previousAssistantMessage ?? '';
  const explicitMutationThread = /\b(?:notion|tracker|database|calendar|board|reminder|email|message|file|document|spreadsheet)\b/i.test(previous)
    && /\b(?:add|added|anything else to add|create|created|log|logged|record|recorded|save|saved|schedule|scheduled|send|sent|update|updated)\b/i.test(previous);
  const boundImplicitThread = !!continuationMutationTool
    && /\b(?:add|added|anything else|create|created|log|logged|record|recorded|save|saved|schedule|scheduled|send|sent|update|updated|want me to)\b/i.test(previous)
    && /\b(?:it|that|this|those|these|entry|entries|exercise|exercises|workout|item|items|row|rows)\b/i.test(previous);
  const continuesMutationThread = explicitMutationThread || boundImplicitThread;
  if (!continuesMutationThread) return false;

  const affirmative = EXPLICIT_CONFIRMATION.test(message);
  const structuredPayload = /\b\d+(?:\.\d+)?\s*(?:kg|lb|lbs|minutes?|mins?|hours?|hrs?|reps?|sets?)\b/i.test(message)
    || /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?(?:\s*(?:x|×)\s*\d+(?:\.\d+)?)?\b/i.test(message)
    || STANDARD_THREE_PART_WORKOUT.test(message)
    || isTaskList(message);
  return affirmative || structuredPayload;
}
