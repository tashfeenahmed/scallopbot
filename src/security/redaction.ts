/** Shared best-effort redaction for persisted traces and subprocess output. */

export const SENSITIVE_ENV_NAME_RE = /(?:api[_-]?key|token|secret|password|passwd|private[_-]?key|credential|auth|cookie|session[_-]?key)/i;

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/gi, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, '[REDACTED]'],
  [/("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*")[^"]+("?)/gi, '$1[REDACTED]$2'],
  [/\b((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)\s*=\s*)[^\s]+/gi, '$1[REDACTED]'],
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values from secret-named environment variables, excluding tiny/noisy values. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME_RE.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

/**
 * Redact known runtime secret values and common token formats.
 * This is defense in depth; it does not claim to identify arbitrary secrets.
 */
export function redactSensitiveText(
  text: string,
  additionalSecrets: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = text;
  const values = [...new Set([...environmentSecrets(env), ...additionalSecrets])]
    .filter(value => value.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    redacted = redacted.replace(new RegExp(escapeRegex(value), 'g'), '[REDACTED]');
  }
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
