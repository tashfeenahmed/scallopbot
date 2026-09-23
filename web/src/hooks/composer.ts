// Pure composer logic for the chat input, kept free of React so the root
// vitest suite (node environment) can cover it, same convention as
// hooks/connection.ts.

export interface ComposerKeyContext {
  key: string;
  shiftKey: boolean;
  /** Slash-command menu is open with at least one match. */
  menuActive: boolean;
  /** A reply is streaming and Enter acts as Stop. */
  isWaiting: boolean;
  /** The composer accepts input right now. */
  enabled: boolean;
}

export type ComposerAction =
  | 'next-command'
  | 'prev-command'
  | 'select-command'
  | 'dismiss-menu'
  | 'stop'
  | 'send'
  | 'newline'
  | 'default';

/** Decision table for keydown in the composer. Shift+Enter always inserts a
 *  newline (ChatGPT / Open WebUI / LibreChat convention); plain Enter sends
 *  unless the slash menu is open, where it selects the highlighted command. */
export function composerKeyAction(ctx: ComposerKeyContext): ComposerAction {
  if (ctx.key === 'ArrowDown' && ctx.menuActive) return 'next-command';
  if (ctx.key === 'ArrowUp' && ctx.menuActive) return 'prev-command';
  if ((ctx.key === 'Enter' || ctx.key === 'Tab') && ctx.menuActive && !ctx.shiftKey) {
    return 'select-command';
  }
  if (ctx.key === 'Escape') return ctx.menuActive ? 'dismiss-menu' : 'default';
  if (ctx.key === 'Enter') {
    if (ctx.shiftKey) return 'newline';
    if (!ctx.enabled) return 'default';
    if (ctx.isWaiting) return 'stop';
    return 'send';
  }
  return 'default';
}

export const DRAFT_KEY = 'smartbo…raft';

/** Draft persistence with a storage that may throw (Safari private mode) or
 *  be missing (SSR/tests). All operations are best-effort. */
export function saveDraft(storage: Storage | null | undefined, text: string): void {
  if (!storage) return;
  try {
    if (text.trim()) storage.setItem(DRAFT_KEY, text);
    else storage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable — draft is simply not persisted */
  }
}

export function loadDraft(storage: Storage | null | undefined): string {
  if (!storage) return '';
  try {
    return storage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Lines the auto-growing textarea should show: one per hard newline,
 *  clamped so a pasted wall of text turns into a scrollbar instead of
 *  pushing the send button off screen. */
export function textareaRows(text: string, maxRows = 10): number {
  const lines = text === '' ? 1 : text.split('\n').length;
  return Math.max(1, Math.min(lines, maxRows));
}
