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

export const DRAFT_KEY = 'smartbot:composer-draft';

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

export interface TextareaMetrics {
  /** el.scrollHeight measured with height reset to 'auto' (content + padding). */
  scrollHeight: number;
  /** Computed line-height in px. */
  lineHeight: number;
  /** padding-top + padding-bottom in px. */
  paddingY: number;
  /** border-top + border-bottom in px (scrollHeight excludes borders). */
  borderY: number;
}

/** Height (border-box px) for the auto-growing textarea, derived from the
 *  rendered content height so soft-wrapped long lines grow the field too,
 *  not just hard newlines. Clamped to maxRows so a pasted wall of text turns
 *  into a scrollbar instead of pushing the send button off screen.
 *  `overflow` says whether the content exceeds the cap (show the scrollbar). */
export function textareaHeight(m: TextareaMetrics, maxRows = 10): { height: number; overflow: boolean } {
  const lineHeight = m.lineHeight > 0 ? m.lineHeight : 20;
  const min = lineHeight + m.paddingY + m.borderY;
  const max = lineHeight * maxRows + m.paddingY + m.borderY;
  const content = m.scrollHeight + m.borderY;
  return {
    height: Math.max(min, Math.min(content, max)),
    overflow: content > max + 1,
  };
}
