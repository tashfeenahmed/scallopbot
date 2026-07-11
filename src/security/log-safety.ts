import { redactSensitiveText } from './redaction.js';
import { createHash } from 'node:crypto';

const PRIVATE_PAYLOAD_KEYS = new Set([
  'args', 'body', 'command', 'combined', 'content', 'goal', 'input', 'message',
  'messages', 'output', 'payload', 'preview', 'prompt', 'recentconversation',
  'request', 'response', 'sourcechunk', 'system', 'task', 'toolinput', 'tooloutput',
]);
const IDENTIFIER_KEYS = new Set(['chatid', 'userid']);
const MAX_LOG_STRING = 2_000;
const MAX_LOG_ARRAY = 50;

/**
 * Recursively sanitize structured log arguments. Raw user/tool/LLM payload
 * fields are removed; diagnostic strings are secret-redacted and bounded.
 */
export function sanitizeLogValue(value: unknown, key = '', depth = 0): unknown {
  const normalizedKey = key.toLowerCase();
  if (PRIVATE_PAYLOAD_KEYS.has(normalizedKey)) return '[REDACTED_PAYLOAD]';
  if (IDENTIFIER_KEYS.has(normalizedKey) && (typeof value === 'string' || typeof value === 'number')) {
    const raw = String(value);
    const channel = raw.includes(':') ? `${raw.slice(0, raw.indexOf(':'))}:` : '';
    return `${channel}id_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    return redacted.length > MAX_LOG_STRING
      ? `${redacted.slice(0, MAX_LOG_STRING)}…[TRUNCATED]`
      : redacted;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[TRUNCATED_OBJECT]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogValue(value.message, 'error', depth + 1),
      code: typeof (value as Error & { code?: unknown }).code === 'string'
        ? (value as Error & { code?: string }).code
        : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LOG_ARRAY).map(item => sanitizeLogValue(item, '', depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result[childKey] = sanitizeLogValue(childValue, childKey, depth + 1);
  }
  return result;
}
