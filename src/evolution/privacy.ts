/** Privacy boundary for turning conversation evidence into procedural memory. */

import { redactSensitiveText } from '../security/redaction.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOME_PATH_RE = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/gi;
const HANDLE_RE = /(?<!\w)@[A-Za-z0-9_]{2,}/g;
const INTRO_NAME_RE = /\b(my name is|call me|i am|i'm)\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?/giu;
const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /<\/?(?:system|assistant|developer|tool_call|tool_response|tools)\b/i, label: 'role/tool markup' },
  { pattern: /^\s*(?:system|assistant|developer|user|tool)\s*:/im, label: 'role-prefixed instruction' },
  { pattern: /(?:\[INST\]|<<SYS>>|###\s*(?:system|developer)\b)/i, label: 'prompt role marker' },
  { pattern: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|system|developer|safety)\s+instructions?\b/i, label: 'instruction override' },
  { pattern: /\b(?:override|bypass|disregard)\s+(?:the\s+)?(?:system|developer|safety)\s+(?:prompt|message|instructions?|rules?)\b/i, label: 'instruction override' },
  { pattern: /\breveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/i, label: 'prompt exfiltration' },
];

export function sanitizeEvolutionEvidence(raw: string): string {
  return redactSensitiveText(raw)
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(IP_RE, '[IP_ADDRESS]')
    .replace(PHONE_RE, '[PHONE]')
    .replace(HOME_PATH_RE, '[HOME_PATH]')
    .replace(HANDLE_RE, '[HANDLE]')
    .replace(INTRO_NAME_RE, '$1 [PERSON]')
    .slice(0, 5000);
}

/** Reject procedural artifacts that still look user/session-specific. */
export function findPersonalDataReason(text: string): string | null {
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(text)) { EMAIL_RE.lastIndex = 0; return 'email address'; }
  IP_RE.lastIndex = 0;
  if (IP_RE.test(text)) { IP_RE.lastIndex = 0; return 'IP address'; }
  PHONE_RE.lastIndex = 0;
  if (PHONE_RE.test(text)) { PHONE_RE.lastIndex = 0; return 'phone number'; }
  HOME_PATH_RE.lastIndex = 0;
  if (HOME_PATH_RE.test(text)) { HOME_PATH_RE.lastIndex = 0; return 'user home path'; }
  HANDLE_RE.lastIndex = 0;
  if (HANDLE_RE.test(text)) { HANDLE_RE.lastIndex = 0; return 'personal handle'; }
  if (/\b(?:telegram|discord|slack|whatsapp)\s*(?:user|chat)?\s*id\b/i.test(text)) return 'channel user identifier';
  if (/\b(?:user said|conversation with|session transcript|the user's name is)\b/i.test(text)) return 'session-specific narrative';
  return null;
}

/**
 * Deterministic boundary shared by generated prompt fragments and SKILL.md.
 * Returning a reason (rather than redacting) prevents unsafe generated
 * instructions from ever reaching the optional LLM gates or live runtime.
 */
export function findUnsafeEvolutionContentReason(text: string): string | null {
  const personal = findPersonalDataReason(text);
  if (personal) return `personal data: ${personal}`;
  for (const check of PROMPT_INJECTION_PATTERNS) {
    check.pattern.lastIndex = 0;
    if (check.pattern.test(text)) return `prompt injection: ${check.label}`;
  }
  // This catches known token formats and exact values from secret-named
  // environment variables. A changed result means a secret would be redacted.
  if (redactSensitiveText(text) !== text) return 'secret or credential pattern';
  return null;
}
