/**
 * Strip inline reasoning markup emitted in visible text by some local and
 * OpenAI-compatible models. Structured `thinking` content blocks are handled
 * separately by the agent and are intentionally unaffected.
 */
export function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unterminated think block: everything after the orphan tag is reasoning.
  const orphan = out.search(/<think>/i);
  if (orphan !== -1) out = out.slice(0, orphan);
  // Some models close a block they never opened (prefix reasoning).
  const orphanClose = out.search(/<\/think>/i);
  if (orphanClose !== -1) out = out.slice(orphanClose + '</think>'.length);
  return out.trim();
}
