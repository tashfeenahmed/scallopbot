import { createHash } from 'node:crypto';
import type { ToolUseContent } from '../providers/types.js';
import type { Skill } from '../skills/types.js';
import { grantPatternFor } from './approvals.js';

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
  /**
   * User approvals (once / this session / always) keyed by the coarse grant
   * pattern from `grantPatternFor`. A granted mutation skips the intent gate
   * but still receives the relative-date consistency check.
   */
  grants?: (pattern: string) => boolean;
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
const READ_ONLY_ACTION = /^(?:check|count|describe|detail|details|dry_run|exists|export|fetch|get|help|history|inspect|known|list|preview|query|read|schema|search|show|stats|status|summary|view)$/i;

const MUTATING_ACTION = /^(?:add|append|archive|book|cancel|commit|complete|create|delete|deploy|document|edit|email|insert|install|invite|log|mark|move|note|post|publish|push|record|register|remove|reply|save|schedule|send|set|share|submit|sync|track|update|upload|write)$/i;
/**
 * A short reply that affirms or re-instructs the write the assistant most
 * recently proposed or failed on: "Yes", "Yes try again. You can", "You have
 * the access - use the skill", "Try adding it like u did for others", "Add
 * them", "Do it", "It's done. Mark it". Bound to a prior proposal/failure or
 * the session's established mutation tool by the caller; never sufficient
 * alone.
 */
const AFFIRMATIVE_OPENER =
  /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|confirm(?:ed)?|please(?:\s+do)?|go ahead|do it|do that|proceed|sounds good|go for it|try again|absolutely|of course|it['’]?s done|done)\b/i;
const RE_INSTRUCTION =
  /\b(?:try(?:\s+(?:it|that|this|them))?\s+(?:again|adding|logging|writing|saving|creating|recording|once more)|use\s+the\s+(?:skill|tool|integration|api)|you\s+(?:have|do\s+have|['’]ve\s+got)\s+(?:the\s+)?(?:access|permission)|like\s+(?:you|u)\s+did|(?:add|log|record|save|write|create|mark|note|track|post|send|update)\s+(?:it|them|these|those|this|that)\b|go\s+ahead|you\s+can\b|(?:just\s+)?do\s+it(?:\s+(?:the\s+same\s+way|again|like\s+before|anyway))?|the\s+same\s+way|(?:there\s+is|there['’]?s)\s+no\s+(?:restriction|block|limit|problem|issue)|no\s+restriction|you\s+did\s+it(?:\s+before)?|you['’]?ve\s+done\s+(?:it|this)\s+before)/i;
const AFFIRMATIVE_NEGATION =
  /\b(?:don['’]?t|do\s+not|no\s+need|not\s+yet|wait|hold\s+on|stop|cancel|never\s*mind|instead|but\s+not)\b/i;
const INFORMATIONAL_UPDATE_REQUEST =
  /\b(?:update|brief|tell|catch)\s+(?:me|us)\s+(?:on|about|regarding)\b/i;
/** A sentence or line that opens with a read-only verb or question word. */
const READ_ONLY_REQUEST =
  /(?:^|[.!?;,:\n])\s*(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:check|show|view|list|find|search|read|describe|inspect|look\s+up|get|fetch|what|which|how|did|is|are|was|were|do\s+i|have\s+i|remind\s+me\s+what|explain|summari[sz]e)\b/i;
const WRITE_ACTIONS =
  'add|archive|book|cancel|complete|create|delete|deploy|document|edit|email|insert|install|invite|log|mark|note|post|publish|push|record|register|remove|reply|save|schedule|send|set|share|submit|sync|track|update|upload|write';
// Sentence starts include line starts (m flag) and the punctuation class
// includes newline, so "Leg ext - 50kgx8x3\n\nLog in notion tracker" and
// "In my notion tracker log this for today" both count as direct requests.
const DIRECT_WRITE_REQUEST = new RegExp(
  `(?:^\\s*(?:(?:please\\s+)?|(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?)|(?:i\\s+(?:want|need|would like)\\s+you\\s+to\\s+))(${WRITE_ACTIONS})\\b)`
  + `|(?:\\b(?:and|then)\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b)`
  + `|(?:[.!?;,:\\n]\\s*(?:please\\s+)?(${WRITE_ACTIONS})\\b)`
  + `|(?:\\b(?:asked|told)\\s+you\\s+to\\s+(${WRITE_ACTIONS})\\b)`
  + `|(?:\\b(${WRITE_ACTIONS})\\s+(?:it|this|these|those|them)\\b)`,
  'im',
);
/** Write verbs in a prior assistant message, including simple past/gerund forms. */
const ANY_WRITE_ACTION_FORM = new RegExp(`\\b(${WRITE_ACTIONS})(?:ged|ed|ing|es|s|d)?\\b`, 'ig');
/** The assistant proposed, asked about, or said it was ready to do a write. */
const CONFIRMATION_REQUEST =
  /\b(?:(?:shall|should|may|can|could)\s+i|(?:do\s+you\s+|would\s+you\s+)?(?:want|like)\s+me\s+to|confirm(?:ation)?|permission|okay\s+to|ok\s+to|ready\s+to\s+(?:add|log|write|save|record|create|send|update)|(?:all|them|these|those|it|that|those\s+\w+)\s+now\?|now\?)/i;
/** The assistant reported that a write failed or was blocked. */
const FAILURE_REPORT =
  /\b(?:couldn['’]?t|could\s+not|wasn['’]?t\s+able|unable|blocked|failed|didn['’]?t\s+(?:work|go\s+through|succeed)|error|restriction|not\s+(?:able|allowed|permitted)|permission\s+denied|404|403)\b/i;
const LOCAL_ACTIONS = `${WRITE_ACTIONS}|append|build|change|commit|compile|copy|deploy|execute|export|fix|format|generate|implement|install|make|mkdir|modify|move|patch|push|refactor|render|rename|restore|run|test|touch|upload|work`;
const DIRECT_LOCAL_REQUEST = new RegExp(
  `(?:^\\s*(?:(?:please\\s+)?|(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?)|(?:i\\s+(?:want|need|would like)\\s+you\\s+to\\s+))(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:and|then)\\s+(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:[.!?;,:]\\s*(?:please\\s+)?(${LOCAL_ACTIONS})\\b)`
  + `|(?:\\b(?:asked|told)\\s+you\\s+to\\s+(${LOCAL_ACTIONS})\\b)`,
  'i',
);
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
  const urls = [...command.matchAll(/https?:\/\/([^/'"\s]+)/gi)].map(match => match[1]);
  if (urls.length > 0) {
    return urls.some(host => !/^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?)(?::\d+)?$/i.test(host));
  }
  return /\b(?:api\.|curl|wget|https?|fetch|requests|httpx|axios|got|ssh|scp|rsync|gh)\b/i.test(command);
}

export function isExternalBashMutation(command: string): boolean {
  if (!command) return false;
  if (/\bgit\s+push\b/i.test(command) || /\bgh\s+(?:api|pr|issue|release)\b[^\n;&|]*(?:create|edit|delete|merge|--method\s+(?:POST|PUT|PATCH|DELETE))\b/i.test(command)) {
    return true;
  }
  if (!hasExternalShellTarget(command)) return false;

  // Some APIs expose read-only query/search operations through POST. Apply the
  // exception by operation semantics, not by vendor, and only when every
  // external URL is a recognized read endpoint. Mixed read/write scripts still
  // classify as mutations.
  const externalUrls = [...command.matchAll(/https?:\/\/[^\s'"\\]+/gi)]
    .map(match => match[0].replace(/[),.;]+$/, ''));
  const destructiveQueryMethod = /(?:(?:-X|--request)\s*['"]?(?:PUT|PATCH|DELETE)\b|\b(?:requests|httpx|axios|got)\s*\.\s*(?:put|patch|delete)\s*\(|\bfetch\s*\([\s\S]{0,2000}?\bmethod\s*:\s*['"](?:PUT|PATCH|DELETE)['"])/i.test(command);
  const readOnlyPostsOnly = !destructiveQueryMethod
    && externalUrls.length > 0
    && externalUrls.every(url => /\/(?:query|search|lookup)(?:\?|$)/i.test(url));
  if (readOnlyPostsOnly) return false;

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

  // Shell/code tools are classified by command analysis only: a leading
  // `export`/`cd`/`echo` word says nothing about what the command mutates.
  const action = toolUse.name === 'bash' || toolUse.name === 'run_code' ? null : actionFromInput(toolUse.input);
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

const CAPABILITY_TOKEN_STOPWORDS = new Set([
  'access', 'action', 'actions', 'current', 'data', 'external', 'manage',
  'read', 'search', 'service', 'source', 'system', 'tool', 'typed', 'verified',
  'write',
]);

function capabilityTokens(toolUse: ToolUseContent, skill?: Skill | null): string[] {
  const declaration = [toolUse.name, skill?.frontmatter.name, skill?.frontmatter.description]
    .filter((value): value is string => !!value)
    .join(' ');
  return [...new Set(declaration.toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4 && !CAPABILITY_TOKEN_STOPWORDS.has(token)))];
}

function toolTargetMentioned(message: string, toolUse: ToolUseContent, skill?: Skill | null): boolean {
  const name = toolUse.name.toLowerCase();
  const tokens = capabilityTokens(toolUse, skill);
  if (tokens.some(token => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message))) {
    return true;
  }
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

/**
 * Every write verb the user directly asked for, in message order. A gym log
 * such as "Set 3 ...\nLog it" carries an incidental "set" before the real
 * "log", so callers pick the first verb compatible with the tool call.
 */
function directRequestedActions(message: string): string[] {
  const found: string[] = [];
  const push = (verb: string | undefined, index = 0) => {
    const lower = verb?.toLowerCase();
    if (!lower || found.includes(lower)) return;
    // "Yes but don't log it yet" is not a request to log.
    const preceding = message.slice(Math.max(0, index - 24), index);
    if (/\b(?:don['’]?t|do\s+not|never|not|without|no\s+need\s+to)\s*(?:please\s+)?[.!?;,:]?\s*$/i.test(preceding)) return;
    found.push(lower);
  };
  for (const match of message.matchAll(new RegExp(DIRECT_WRITE_REQUEST.source, 'gim'))) {
    push(match.slice(1).find(Boolean), match.index);
  }

  // Natural requests often include a discourse prefix ("For today, can you
  // log...") or explicit authorization language. They are just as clear as an
  // imperative and must not force the user into a magic-word loop.
  const naturalPatterns = [
    new RegExp(`\\b(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b`, 'gi'),
    new RegExp(`^\\s*(?:yes|yep|yeah|ok(?:ay)?|sure|confirmed?)[,!]?\\s+(?:please\\s+)?(${WRITE_ACTIONS})\\b`, 'gi'),
    new RegExp(`\\b(?:authorize|instruct|ask|tell)\\s+(?:you|the\\s+agent|this\\s+bot)\\s+to\\s+(${WRITE_ACTIONS})\\b`, 'gi'),
  ];
  for (const pattern of naturalPatterns) {
    for (const match of message.matchAll(pattern)) push(match[1]);
  }
  return found;
}

function directRequestedAction(message: string): string | null {
  return directRequestedActions(message)[0] ?? null;
}

/** Numbers with x/× or units (kg/min/reps...) or a multi-line list. */
function hasStructuredPayload(message: string): boolean {
  return /\b\d+(?:\.\d+)?(?:\s*[a-z%]+)?(?:\s*(?:x|×)\s*\d+(?:\.\d+)?(?:\s*[a-z%]+)?)+\b/i.test(message)
    || /\b\d+(?:\.\d+)?\s*(?:kg|kgs|lb|lbs|min|mins|minutes|reps?|sets?|km|sec|secs)\b/i.test(message)
    || isTaskList(message);
}

function hasReadOnlyRequest(message: string): boolean {
  return READ_ONLY_REQUEST.test(message);
}

function isAffirmativeFollowUp(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 160) return false;
  if (AFFIRMATIVE_NEGATION.test(text)) return false;
  return AFFIRMATIVE_OPENER.test(text) || RE_INSTRUCTION.test(text);
}

/** The assistant either proposed a write or reported one failing/blocked. */
function priorMessageProposesOrFailsWrite(previousAssistantMessage: string | undefined): boolean {
  if (!previousAssistantMessage) return false;
  return CONFIRMATION_REQUEST.test(previousAssistantMessage) || FAILURE_REPORT.test(previousAssistantMessage);
}

/** Base form of the last write verb in a prior assistant message, if any. */
function lastPriorWriteAction(previousAssistantMessage: string): string | null {
  const direct = directRequestedAction(previousAssistantMessage);
  if (direct) return direct;
  const last = [...previousAssistantMessage.matchAll(ANY_WRITE_ACTION_FORM)].at(-1)?.[1];
  return last ? last.toLowerCase() : null;
}

function sameTool(continuationMutationTool: string | undefined, toolUse: ToolUseContent): boolean {
  return !!continuationMutationTool
    && continuationMutationTool.toLocaleLowerCase('en-US') === toolUse.name.toLocaleLowerCase('en-US');
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
  const priorPlanningPrompt = !!previousAssistantMessage
    && /\b(?:main focus|priorit(?:y|ies)|plan|agenda|tasks?|to-?do|board|reminder)\b/i.test(previousAssistantMessage);
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

/**
 * An affirmative or re-instructing reply authorizes the write the assistant
 * most recently proposed or failed on. Binding is to (a) the prior assistant
 * message proposing/asking/failing on this tool or target, or (b) the exact
 * tool that already completed a verified write in this session.
 */
function isBoundTargetedConfirmation(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
  skill?: Skill | null,
  continuationMutationTool?: string,
): boolean {
  if (!isAffirmativeFollowUp(message)) return false;
  if (sameTool(continuationMutationTool, toolUse)) return true;
  if (!previousAssistantMessage || !priorMessageProposesOrFailsWrite(previousAssistantMessage)) return false;
  // A proposal or failure that names this tool/target is enough on its own;
  // "I couldn't log that to Notion" needs no write verb from the list.
  if (toolTargetMentioned(previousAssistantMessage, toolUse, skill)) return true;
  // Otherwise ("Want me to add them all now?") bind through the proposed
  // action so a bare "yes" cannot authorize an unrelated destination.
  const priorAction = lastPriorWriteAction(previousAssistantMessage);
  const actual = toolMutationAction(toolUse);
  return !!priorAction && !!actual && actionsCompatible(priorAction, actual);
}

/**
 * Session-established workflow: the same tool already completed a verified
 * write this session and the user now sends more structured data ("Pectoral
 * machine - 40kg x9x3") without any read-only verb.
 */
function isWorkflowContinuation(
  message: string,
  toolUse: ToolUseContent,
  continuationMutationTool?: string,
): boolean {
  return sameTool(continuationMutationTool, toolUse)
    && hasStructuredPayload(message)
    && !hasReadOnlyRequest(message);
}

function hasExplicitExternalWriteIntent(
  message: string,
  previousAssistantMessage: string | undefined,
  toolUse: ToolUseContent,
  continuationMutationTool?: string,
  skill?: Skill | null,
): boolean {
  if (INFORMATIONAL_UPDATE_REQUEST.test(message)) return false;
  // Delivering progress into the active conversation is part of answering the
  // current turn. It still receives payload-sensitivity and idempotency checks.
  if (toolUse.name === 'send_message') return true;
  if (toolUse.name === 'send_file') {
    if (isBoundTargetedConfirmation(message, previousAssistantMessage, toolUse, skill, continuationMutationTool)) return true;
    const action = directRequestedAction(message);
    return !!action
      && actionsCompatible(action, 'send')
      && /\b(?:attach|download|file|image|pdf|photo|report|send|share|spreadsheet|video|workbook)\b/i.test(message);
  }
  if (isBoundTargetedConfirmation(message, previousAssistantMessage, toolUse, skill, continuationMutationTool)) return true;
  if (isWorkflowContinuation(message, toolUse, continuationMutationTool)) return true;
  if (
    previousAssistantMessage
    && turnRequiresMutationReceipt(message, previousAssistantMessage, continuationMutationTool)
    && (
      toolTargetMentioned(previousAssistantMessage, toolUse, skill)
      || sameTool(continuationMutationTool, toolUse)
    )
  ) {
    return true;
  }

  const actual = toolMutationAction(toolUse);
  const requestedAction = directRequestedActions(message)
    .find(action => actionsCompatible(action, actual));
  if (!requestedAction) return false;
  const targetIndependent = /^(?:book|deploy|document|invite|log|note|push|record|register|reply|schedule|share|submit|sync|track|upload)$/.test(requestedAction);
  const explicitPronoun = new RegExp(
    `(?:^|[.!?;,:\\n])\\s*(?:please\\s+)?(?:${WRITE_ACTIONS})\\s+(?:it|that|this|those|these|them)\\b`
    + `|\\b(?:${WRITE_ACTIONS})\\s+(?:it|this|those|these|them)\\b`,
    'im',
  ).test(message);
  return targetIndependent || explicitPronoun || toolTargetMentioned(message, toolUse, skill);
}

/**
 * One-line, human-phrasable summary of a tool call ("notion create: name=Leg
 * Press, date=2026-07-11, sets=3") so a blocked model can name the exact
 * action when it asks the user.
 */
export function describeToolCallForUser(toolUse: ToolUseContent): string {
  const input = toolUse.input ?? {};
  const action = actionFromInput(input);
  const parts: string[] = [];
  if (toolUse.name === 'bash' || toolUse.name === 'run_code') {
    const command = executableContent(toolUse).replace(/\s+/g, ' ').trim();
    const method = command.match(/\b(?:-X|--request|--method[=\s])\s*['"]?(POST|PUT|PATCH|DELETE)\b/i)?.[1]
      ?? command.match(/\b(POST|PUT|PATCH|DELETE)\b/i)?.[1];
    const url = command.match(/https?:\/\/[^\s'"\\]+/i)?.[0];
    const tail = [method?.toUpperCase(), url].filter(Boolean).join(' ')
      || command.slice(0, 80);
    return `${toolUse.name}: ${tail}`;
  }
  const interesting = /^(?:title|name|exercise|date|day|when|start|type|sets|reps|weight|duration|status|column|notes?|subject|to|recipient|message|body|content|text|page|database|path|file_path|kind|id)(?:[^a-z0-9]|$)/i;
  const typedWrapper = /^(?:text|title|rich_text|date|number|select|start|content|plain_text)$/i;
  const seen = new Set<string>();
  const visit = (value: unknown, key: string, depth: number): void => {
    if (parts.length >= 6 || depth > 5) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        // Notion-style typed wrappers ({date:{start}}, {title:[{text:{content}}]})
        // carry the meaningful key one level up, but only once we are inside a
        // named property: a property literally called "Date" is the label.
        const label = interesting.test(key) && typedWrapper.test(childKey) ? key : childKey;
        visit(child, label, depth + 1);
      }
      return;
    }
    if (!interesting.test(key) || key === 'action') return;
    if (typeof value === 'string' && !value.trim()) return;
    const rendered = String(value).replace(/\s+/g, ' ').trim().slice(0, 60);
    const entry = `${key}=${rendered}`;
    if (!seen.has(entry)) {
      seen.add(entry);
      parts.push(entry);
    }
  };
  for (const [key, value] of Object.entries(input)) {
    if (['action', 'operation', 'method', 'command'].includes(key)) continue;
    visit(value, key, 0);
  }
  const head = action ? `${toolUse.name} ${action}` : toolUse.name;
  return parts.length > 0 ? `${head}: ${parts.join(', ')}` : head;
}

/**
 * Human phrasing of a tool call for a yes/no question shown to the user:
 * `add "Leg Press" (Sets=3, Reps=9, Weight (kg)=110, Date=2026-08-21) in notion`.
 * Ids are dropped; the technical form stays in describeToolCallForUser().
 */
export function describeToolCallPlainly(toolUse: ToolUseContent): string {
  if (toolUse.name === 'bash' || toolUse.name === 'run_code') {
    return `run ${describeToolCallForUser(toolUse)}`;
  }
  const technical = describeToolCallForUser(toolUse);
  const colon = technical.indexOf(': ');
  const fields = colon >= 0
    ? technical.slice(colon + 2).split(', ').filter(entry => !/^(?:[a-z_]*id|page|database_id|data_source_id)=/i.test(entry))
    : [];
  const titleIndex = fields.findIndex(entry => /^(?:name|title|exercise|subject)=/i.test(entry));
  const title = titleIndex >= 0 ? fields.splice(titleIndex, 1)[0].replace(/^[^=]+=/, '') : '';
  const action = (actionFromInput(toolUse.input) ?? '').toLowerCase();
  const verb = /^(?:create|add|insert|log|record|save|write|note|track|book|schedule|register|submit)$/.test(action) ? 'add'
    : /^(?:update|edit|set|mark|complete)$/.test(action) ? 'update'
    : /^(?:delete|remove|archive|cancel)$/.test(action) ? 'delete'
    : /^(?:send|post|publish|reply|email|share)$/.test(action) ? 'send'
    : action || 'run';
  const where = typeof toolUse.input.database === 'string' && toolUse.input.database.trim()
    ? `in ${toolUse.input.database.trim()}`
    : `in ${toolUse.name}`;
  const detail = fields.length > 0 ? ` (${fields.join(', ')})` : '';
  return `${verb} ${title ? `"${title}"` : 'this'}${detail} ${where}`;
}

function externalBlockReason(toolUse: ToolUseContent): string {
  const summary = describeToolCallForUser(toolUse);
  const plain = describeToolCallPlainly(toolUse);
  return `BLOCKED: this write (${summary}) was not requested in the current message. `
    + 'Do not retry it with another tool (bash/curl/spawn_agent/execute_goal/workflows are blocked by the same policy) '
    + 'and do not claim it was done. Reply to the user with ONE short question that names the exact action, '
    + `e.g. 'Do you want me to ${plain} now?' — their 'yes' authorizes it.`;
}

function localBlockReason(toolUse: ToolUseContent): string {
  const summary = describeToolCallForUser(toolUse);
  return `BLOCKED: this local write (${summary}) was not requested in the current message. `
    + 'Do not retry it with another tool and do not ask for permission to do it; '
    + 'answer the user\'s actual request without this side effect. '
    + 'If the request cannot be met without it, tell the user in ONE sentence what you would need to change and stop.';
}

/**
 * Keep side effects bound to the active request without imposing
 * domain-specific permission or interpretation rules. Ordinary requested work
 * proceeds autonomously.
 */
export function assessToolCallForTurn(
  toolUse: ToolUseContent,
  context: TurnToolSafetyContext,
  skill?: Skill | null,
): ToolSafetyAssessment {
  const isMutation = isLikelyMutation(toolUse, skill);
  const isExternalMutation = isLikelyExternalMutation(toolUse, skill);
  const signature = toolCallSignature(toolUse);
  const message = currentInstruction(context.userMessage);
  if (!isMutation) return { allowed: true, isMutation, isExternalMutation, signature };
  // An explicit user approval (button tap or typed "yes" to the approval
  // prompt) covers this kind of call; hard-floor calls have no pattern.
  const grantPattern = grantPatternFor(toolUse);
  if (grantPattern && context.grants?.(grantPattern)) {
    return relativeDateMismatch(toolUse, message, context, { isMutation, isExternalMutation, signature })
      ?? { allowed: true, isMutation, isExternalMutation, signature };
  }
  if (!isExternalMutation) {
    // A bare "yes" after "Should I add these tasks to your board?" authorizes
    // the proposed local write when the proposal names this tool.
    const affirmedLocalProposal = isAffirmativeFollowUp(message)
      && priorMessageProposesOrFailsWrite(context.previousAssistantMessage)
      && toolTargetMentioned(context.previousAssistantMessage ?? '', toolUse, skill);
    if (hasExplicitLocalMutationIntent(message)
      || hasImplicitPlanningMutationIntent(message, context.previousAssistantMessage, toolUse)
      || isCorrectiveFollowUp(message, context.previousAssistantMessage)
      || affirmedLocalProposal) {
      if (planningToolClaimsCompletion(toolUse) && !currentTurnStatesCompletion(message)) {
        const summary = describeToolCallForUser(toolUse);
        return {
          allowed: false,
          code: 'TASK_COMPLETION_EVIDENCE_REQUIRED',
          reason: `BLOCKED: this call (${summary}) marks a task complete, but the current user message does not say it is done. `
            + 'Retry the same call with the task pending/in progress instead; never infer today\'s completion from older memory. '
            + 'If you are unsure whether it is done, ask the user ONE short question naming the task.',
          isMutation,
          isExternalMutation,
          signature,
        };
      }
      return { allowed: true, isMutation, isExternalMutation, signature };
    }
    return {
      allowed: false,
      reason: localBlockReason(toolUse),
      isMutation,
      isExternalMutation,
      signature,
    };
  }
  const explicitIntent = hasExplicitExternalWriteIntent(
    message,
    context.previousAssistantMessage,
    toolUse,
    context.continuationMutationTool,
    skill,
  );
  if (!explicitIntent) {
    return {
      allowed: false,
      reason: externalBlockReason(toolUse),
      isMutation,
      isExternalMutation,
      signature,
    };
  }

  return relativeDateMismatch(toolUse, message, context, { isMutation, isExternalMutation, signature })
    ?? { allowed: true, isMutation, isExternalMutation, signature };
}

/** "today"/"yesterday"/"tomorrow" in the request must match every date argument. */
function relativeDateMismatch(
  toolUse: ToolUseContent,
  message: string,
  context: TurnToolSafetyContext,
  base: Pick<ToolSafetyAssessment, 'isMutation' | 'isExternalMutation' | 'signature'>,
): ToolSafetyAssessment | null {
  const now = context.now ?? new Date();
  const expectedDate = expectedRelativeDate(message, now, context.timezone);
  if (!expectedDate) return null;
  const suppliedDates = collectDateArguments(toolUse.input);
  const mismatched = suppliedDates.find((date) => date !== expectedDate);
  if (!mismatched) return null;
  const word = message.match(/\b(?:yesterday|tomorrow|today)\b/i)?.[0].toLowerCase() ?? 'a relative day';
  return {
    allowed: false,
    reason: `BLOCKED: the user said '${word}', but the ${toolUse.name} arguments use ${mismatched}. `
      + `'${word}' in ${context.timezone} is ${expectedDate}. `
      + `Retry the same ${toolUse.name} call now with every date argument set to ${expectedDate}; do not ask the user and do not switch tools.`,
    ...base,
  };
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

/**
 * Determine whether this turn promises a state change whose completion must be
 * backed by a successful tool receipt. This also covers terse continuations
 * bound to the exact integration that most recently completed a write.
 */
/**
 * True when the user's message itself looks like a write payload: a set/rep/kg
 * line, a task list, or an explicit write verb. Used to hold a draft reply that
 * claims a write happened to a tool receipt even when the intent regexes did
 * not classify the turn.
 */
export function messageCarriesWritePayload(userMessage: string): boolean {
  const message = currentInstruction(userMessage);
  if (hasReadOnlyRequest(message)) return false;
  return hasStructuredPayload(message) || directRequestedActions(message).length > 0;
}

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
  if (INFORMATIONAL_UPDATE_REQUEST.test(message)) return false;
  if (directRequestedAction(message)) return true;

  if (isTaskList(message) && /\b(?:priorit|plan|task|deadline|today|board)\b/i.test(previousAssistantMessage ?? '')) {
    return true;
  }

  // Session-established workflow: more structured data after a verified write
  // by the same tool must again end in a tool receipt, whatever the last
  // assistant reply said.
  const structuredPayload = hasStructuredPayload(message) && !hasReadOnlyRequest(message);
  if (continuationMutationTool && structuredPayload) return true;

  const previous = previousAssistantMessage ?? '';
  const priorWriteThread = /\b(?:add|added|adding|create|created|creating|log|logged|logging|record|recorded|save|saved|schedule|scheduled|send|sent|update|updated|write|written|track|tracked|entries|entry)\b/i.test(previous);
  if (!priorWriteThread) return false;
  const priorWriteHandoff = /\b(?:anything else|want me to|another|more|next)\b/i.test(previous);
  const affirmative = isAffirmativeFollowUp(message)
    && (priorMessageProposesOrFailsWrite(previous) || priorWriteHandoff || !!continuationMutationTool);
  if (affirmative) return true;
  return structuredPayload && (priorWriteHandoff || !!continuationMutationTool);
}
