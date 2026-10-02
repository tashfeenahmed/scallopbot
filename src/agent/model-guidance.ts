/**
 * Per-model-family prompt guidance (Hermes `prompt_builder.py` pattern).
 *
 * Open and mid-tier models share a handful of habits that waste turns: ending
 * on a promise instead of acting, doing arithmetic in their head, asking
 * permission for work the request already authorizes, and paraphrasing
 * literals (ids, paths, numbers) they were asked to preserve. Claude models
 * don't need these reminders, so they get nothing and keep a shorter prompt.
 */

const OPEN_MODEL_RULES = `## WORKING HABITS
- Never end your turn with a promise of future action ("I'll now…", "Next I will…"). Either make the tool call in this response or say plainly what is left undone.
- Use tools for math, counting, hashes, dates, times and system state. Don't compute them in your head.
- Act, don't ask: the user's request already authorizes the work it needs. Ask only for a missing fact.
- Preserve literals exactly: copy ids, paths, numbers, quotes and code verbatim from tool output.`;

const FAMILY_EXTRAS: Array<{ match: RegExp; text: string }> = [
  {
    match: /\b(?:gpt|o[1-9]|codex)/,
    text: '- Prefer the patch tool over rewriting whole files. Keep explanations short; let tool output carry the detail.',
  },
  {
    match: /gemini/,
    text: '- Call tools with valid JSON arguments only; never wrap arguments in markdown.',
  },
  {
    match: /qwen|glm|deepseek|kimi|moonshot/,
    text: '- Make the tool call itself rather than describing it. One response may contain several independent tool calls.',
  },
];

/** Guidance block for the model family, or '' for Claude and unknown ids. */
export function modelGuidanceFor(modelId: string | undefined): string {
  const id = (modelId ?? '').toLowerCase();
  if (!id || /claude|anthropic/.test(id)) return '';
  const extras = FAMILY_EXTRAS.filter((entry) => entry.match.test(id)).map((entry) => entry.text);
  return extras.length > 0 ? `${OPEN_MODEL_RULES}\n${extras.join('\n')}` : OPEN_MODEL_RULES;
}
