/**
 * Deterministic checks on a draft final reply.
 *
 * Small models routinely answer a write request with a promise ("I'll add
 * these to Notion now", "Logging today's session…") and then stop without
 * calling any tool. A promise is not a receipt. These helpers detect such
 * promises so the agent can treat them exactly like an unverified success
 * claim, and produce the honest replacement text when the model still does
 * not act.
 */

import { hasUnverifiedSuccessClaim } from './tool-safety.js';

const WRITE_VERB = String.raw`(?:add|log|save|record|create|update|write|put|enter|store|sync|post|send|schedule|track|note|capture|upload|insert|submit|get\s+(?:these|this|those|them|it|that|everything|all)\s+(?:in|into|onto|to|over))`;
const WRITE_VERB_ING = String.raw`(?:adding|logging|saving|recording|creating|updating|writing|putting|entering|storing|syncing|posting|sending|scheduling|tracking|noting|capturing|uploading|inserting|submitting)`;
const FILLER = String.raw`(?:(?:now|just|also|then|quickly|go\s+ahead\s+and|try\s+to|start\s+to|begin\s+to|proceed\s+to)\s+){0,2}`;

/** "I'll add…", "I will log…", "I'm going to save…", "Let me log…", "I'm logging…". */
const SUBJECT_PROMISE = new RegExp(
  String.raw`\b(?:i(?:['’]ll|\s+will|\s+shall|['’]m\s+going\s+to|\s+am\s+going\s+to|['’]m\s+gonna|\s+gonna|['’]m\s+about\s+to)|let\s+me|we(?:['’]ll|\s+will)|(?:i['’]m|i\s+am|we['’]re|we\s+are)\s+(?:now\s+)?(?=${WRITE_VERB_ING}))\s*${FILLER}(?:${WRITE_VERB}|${WRITE_VERB_ING})\b`,
  'i',
);

/** Sentence-initial "Will add…", "Going to log…", "Logging today's session…", "Adding…". */
const BARE_PROMISE = new RegExp(
  String.raw`(?:^|[.!?:;\n]\s*|[-*•]\s+)(?:(?:will|gonna|going\s+to)\s+${FILLER}${WRITE_VERB}|(?:now\s+)?${WRITE_VERB_ING})\b`,
  'i',
);

/** A destination makes a bare progressive ("Logging…") unambiguous. */
const WRITE_TARGET = /\b(?:notion|tracker|log|logs|database|db|board|calendar|sheet|spreadsheet|file|files|note|notes|reminder|memory|table|page|record|records|list|todo|to-do|task|tasks|session|workout|entry|entries|github|slack|trello|jira|airtable|obsidian)\b/i;

/** Conditional or interrogative sentences propose, they do not promise. */
const CONDITIONAL = /\?|\b(?:if|once|unless|whenever|as\s+soon\s+as|should\s+i|shall\s+i|want\s+me\s+to|would\s+you\s+like|do\s+you\s+want|(?:say|reply|answer)\s+["“']?(?:yes|the\s+word|go)|confirm|let\s+me\s+know)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function isPromiseSentence(sentence: string): boolean {
  if (CONDITIONAL.test(sentence)) return false;
  if (SUBJECT_PROMISE.test(sentence)) return true;
  return BARE_PROMISE.test(sentence) && WRITE_TARGET.test(sentence);
}

/**
 * True when the reply promises a state change in future or progressive tense
 * without evidence it happened ("I'll add these to Notion now", "Logging
 * today's session…"). Questions and conditionals ("Want me to add…?") are not
 * promises.
 */
export function hasUnverifiedActionPromise(response: string): boolean {
  return sentencesOf(response).some(isPromiseSentence);
}

export const UNWRITTEN_LINE = 'I have not written this anywhere yet.';

/**
 * Replace a promising draft with an honest one: state plainly that nothing
 * was written, keep the payload the model was about to write (so the user can
 * see exactly what would be logged), and drop the promise/success sentences.
 */
export function honestUnwrittenReply(draft: string): string {
  const kept = draft
    .split('\n')
    .map(line => sentencesOf(line)
      .filter(sentence => !isPromiseSentence(sentence) && !hasUnverifiedSuccessClaim(sentence))
      .join(' ')
      .replace(/[…]+|\.{3,}/g, '')
      .trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!kept) return `${UNWRITTEN_LINE} Reply "yes" and I will write it now.`;
  return `${UNWRITTEN_LINE} Here is what I would write:\n${kept}\n\nReply "yes" and I will write it now.`;
}

/**
 * Paraphrased tool-policy errors turn into invented causes ("the integration
 * lacks access", "system restriction"). Detect that wording so the agent can
 * state the real cause after a policy block.
 */
export function mentionsFalsePolicyCause(response: string): boolean {
  return /\b(?:integrations?|share\s+(?:the\s+)?(?:database|page|db)|permissions?|system\s+restrictions?|platform[-\s]level|can(?:'|’|no)?t\s+override|cannot\s+override|restricted|not\s+authori[sz]ed|access\s+(?:issue|denied|problem)|lacks?\s+access|no\s+access|blocked\s+by)\b/i
    .test(response);
}

export const POLICY_BLOCK_TRUTH = 'To be clear: I skipped that write only because your message did not clearly ask for it, not because of any integration, permission, or platform limit. Reply "yes" and I will do it now.';

/** Append the deterministic cause sentence once. */
export function appendPolicyBlockTruth(response: string): string {
  if (response.includes(POLICY_BLOCK_TRUTH)) return response;
  const trimmed = response.trim();
  return trimmed ? `${trimmed}\n\n${POLICY_BLOCK_TRUTH}` : POLICY_BLOCK_TRUTH;
}
