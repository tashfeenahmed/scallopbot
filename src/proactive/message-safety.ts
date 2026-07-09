import { extractJSON, stripThinkTags } from './proactive-utils.js';

const INTERNAL_PATTERNS: RegExp[] = [
  /\bthe user\b/i,
  /\b(?:assistant|agent|bot)\s+should\b/i,
  /\b(?:send|write|compose|draft)\s+(?:a\s+)?(?:proactive\s+)?(?:message|nudge|follow[- ]?up)\b/i,
  /\b(?:message|nudge|follow[- ]?up)\s+(?:to|for)\s+(?:the\s+)?user\b/i,
  /^\s*(?:ask|tell|remind|message|ping|nudge|follow up with|check in with)\s+(?:the\s+)?user\b/i,
  /\b(?:when|if)\s+(?:this|the)\s+(?:trigger|reminder|nudge|scheduled item)\s+(?:fires|runs)\b/i,
  /\b(?:internal note|system prompt|task goal|sub-agent|proactive_evaluator)\b/i,
  /\b(?:sourceId|gapType|trigger_time|taskConfig|tool_name|tool_input)\b/i,
  /^\s*(?:reasoning|analysis|plan|guidance|instructions?)\s*[:\-]/i,
  /<(?:function_calls|invoke|tool|query|command|result|output|thinking|think)\b/i,
];

function trimOuterQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractMessageField(text: string): string | null {
  const parsed = extractJSON<Record<string, unknown>>(text);
  if (!parsed) return null;

  for (const key of ['message', 'content', 'text', 'body']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function stripUserFacingPrefix(text: string): string {
  let cleaned = text;

  const sendPrefix = cleaned.match(
    /^(?:send|write|compose|draft)\s+(?:a\s+)?(?:short\s+)?(?:proactive\s+)?(?:message|nudge|follow[- ]?up)(?:\s+(?:to|for)\s+(?:the\s+)?user)?\s*[:\-]\s*(.+)$/i,
  );
  if (sendPrefix?.[1]) {
    cleaned = sendPrefix[1];
  }

  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(
      /^(?:final\s+)?(?:proactive\s+)?(?:telegram\s+)?(?:message|nudge|text)(?:\s+to\s+send)?\s*[:\-]\s*/i,
      '',
    );
    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned;
}

export function looksLikeInternalProactiveText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[{[]/.test(trimmed)) return true;
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Return a user-facing proactive message, or null when the text looks like
 * model instructions/planning rather than something safe to send to a user.
 */
export function sanitizeProactiveMessage(raw: string): string | null {
  if (!raw) return null;

  let cleaned = stripThinkTags(raw)
    .replace(/```(?:json|text|markdown)?/gi, '')
    .replace(/```/g, '')
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/gi, '')
    .replace(/<invoke[\s\S]*?(<\/invoke>|$)/gi, '')
    .replace(/<(tool|query|command|result|output|search_query|input|args|parameters|tool_name|tool_input)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();

  const messageField = extractMessageField(cleaned);
  if (messageField) {
    cleaned = messageField;
  }

  cleaned = trimOuterQuotes(stripUserFacingPrefix(cleaned))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned || looksLikeInternalProactiveText(cleaned)) return null;
  return cleaned;
}
