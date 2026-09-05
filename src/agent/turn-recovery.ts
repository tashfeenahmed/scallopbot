/**
 * Recovery nudges for malformed model turns (Hermes-style).
 *
 * Small models regularly end a turn with (a) nothing at all, or (b) prose that
 * announces a tool call ("Let me check the tracker…", "Calling notion now")
 * without emitting a tool_use block. Both would otherwise be shipped to the
 * user as the final reply. The agent loop injects one short system nudge and
 * loops once more, bounded by MAX_MALFORMED_TURN_NUDGES per turn.
 */

export const MAX_MALFORMED_TURN_NUDGES = 2;

export const EMPTY_TURN_NUDGE =
  '[System: Your last message was empty. Continue exactly where you left off.]';

export const UNMADE_TOOL_CALL_NUDGE =
  '[System: You described a tool call but did not make one. Make the tool call now.]';

const ACTION_VERB = String.raw`(?:check|look\s+up|search|query|fetch|pull|read|open|list|call|run|execute|use|invoke|log|add|create|update|save|record|write|send|post|schedule|delete|remove|query|retrieve|grab|get)`;

/** "Let me check…", "I'll call…", "I'm going to search…", "Let me use the notion tool". */
const ANNOUNCED_CALL = new RegExp(
  String.raw`\b(?:let\s+me|i(?:['’]ll|\s+will|['’]m\s+going\s+to|\s+am\s+going\s+to|['’]m\s+about\s+to)|i(?:['’]m|\s+am)\s+(?:now\s+)?(?:calling|running|using|checking|querying|searching|fetching|looking\s+up|logging|adding|creating|updating|saving|sending))\s+(?:now\s+|just\s+|quickly\s+|go\s+ahead\s+and\s+)?(?:${ACTION_VERB}|calling|running|using|checking|querying|searching|fetching|looking\s+up)\b`,
  'i',
);

/** "Calling the notion tool", "Running the search now", "Using bash to…". */
const BARE_ANNOUNCED_CALL = /(?:^|[.!?:;\n]\s*)(?:calling|running|invoking|using|querying|searching|fetching|checking|looking\s+up)\s+(?:the\s+|a\s+|my\s+)?(?:[\w-]+\s+)?(?:tool|skill|api|command|script|database|tracker|search|calendar|notion|board|memory)\b/i;

/** Questions, conditionals and hedges propose; they do not announce. */
const HEDGED = /\?|\b(?:if|unless|should\s+i|shall\s+i|want\s+me\s+to|would\s+you\s+like|do\s+you\s+want|could|can['’]t|cannot|unable|not\s+able|won['’]t|will\s+not|instead|manually|yourself)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

/**
 * True when the text announces a tool call that this response did not make.
 * Callers must only invoke this for responses without tool_use blocks.
 */
export function describesUnmadeToolCall(text: string, toolNames: readonly string[] = []): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const sentences = sentencesOf(trimmed);
  const toolMention = toolNames.length > 0
    ? new RegExp(String.raw`\b(?:${toolNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\b`, 'i')
    : null;
  return sentences.some(sentence => {
    if (HEDGED.test(sentence)) return false;
    if (ANNOUNCED_CALL.test(sentence)) return true;
    if (BARE_ANNOUNCED_CALL.test(sentence)) return true;
    // "Calling notion…" / "Using board to add…" with a known tool name.
    return !!toolMention
      && toolMention.test(sentence)
      && /\b(?:calling|running|invoking|using|querying|via|with\s+the)\b/i.test(sentence)
      && /\b(?:now|next|first)\b|…|\.\.\.$/i.test(sentence);
  });
}
