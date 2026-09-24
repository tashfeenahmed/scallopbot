import { describe, expect, it } from 'vitest';
import {
  composerKeyAction,
  loadDraft,
  saveDraft,
  textareaHeight,
  DRAFT_KEY,
  type ComposerKeyContext,
} from '../../web/src/hooks/composer';

function ctx(overrides: Partial<ComposerKeyContext> = {}): ComposerKeyContext {
  return {
    key: 'Enter',
    shiftKey: false,
    menuActive: false,
    isWaiting: false,
    enabled: true,
    ...overrides,
  };
}

// Minimal in-memory Storage for draft tests.
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

function throwingStorage(): Storage {
  const boom = () => { throw new Error('SecurityError'); };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom } as Storage;
}

describe('composerKeyAction', () => {
  it('Shift+Enter inserts a newline instead of sending', () => {
    expect(composerKeyAction(ctx({ shiftKey: true }))).toBe('newline');
  });

  it('plain Enter sends when idle and enabled', () => {
    expect(composerKeyAction(ctx())).toBe('send');
  });

  it('plain Enter stops generation while waiting for a reply', () => {
    expect(composerKeyAction(ctx({ isWaiting: true }))).toBe('stop');
  });

  it('Enter is inert while the composer is disabled', () => {
    expect(composerKeyAction(ctx({ enabled: false }))).toBe('default');
    expect(composerKeyAction(ctx({ enabled: false, isWaiting: true }))).toBe('default');
  });

  it('Enter and Tab select the highlighted command when the menu is open', () => {
    expect(composerKeyAction(ctx({ menuActive: true }))).toBe('select-command');
    expect(composerKeyAction(ctx({ menuActive: true, key: 'Tab' }))).toBe('select-command');
    // Shift+Enter still writes a newline even with the menu open.
    expect(composerKeyAction(ctx({ menuActive: true, shiftKey: true }))).toBe('newline');
  });

  it('arrows navigate only when the menu is open', () => {
    expect(composerKeyAction(ctx({ key: 'ArrowDown', menuActive: true }))).toBe('next-command');
    expect(composerKeyAction(ctx({ key: 'ArrowUp', menuActive: true }))).toBe('prev-command');
    expect(composerKeyAction(ctx({ key: 'ArrowDown' }))).toBe('default');
  });

  it('Escape dismisses the menu and is otherwise inert', () => {
    expect(composerKeyAction(ctx({ key: 'Escape', menuActive: true }))).toBe('dismiss-menu');
    expect(composerKeyAction(ctx({ key: 'Escape' }))).toBe('default');
  });
});

describe('draft persistence', () => {
  it('round-trips a non-empty draft', () => {
    const s = fakeStorage();
    saveDraft(s, 'half typed note\nsecond line');
    expect(loadDraft(s)).toBe('half typed note\nsecond line');
  });

  it('clears the stored draft when the composer becomes empty', () => {
    const s = fakeStorage({ [DRAFT_KEY]: 'stale' });
    saveDraft(s, '   ');
    expect(loadDraft(s)).toBe('');
    expect(s.getItem(DRAFT_KEY)).toBeNull();
  });

  it('is a no-op with no storage', () => {
    expect(() => saveDraft(null, 'x')).not.toThrow();
    expect(loadDraft(undefined)).toBe('');
  });

  it('survives a storage that throws (private mode)', () => {
    const s = throwingStorage();
    expect(() => saveDraft(s, 'x')).not.toThrow();
    expect(loadDraft(s)).toBe('');
  });
});

describe('DRAFT_KEY', () => {
  it('is a clean, namespaced ASCII key', () => {
    expect(DRAFT_KEY).toBe('smartbot:composer-draft');
  });
});

describe('textareaHeight', () => {
  // line-height 20, padding 12+12, border 1+1
  const m = (scrollHeight: number) => ({ scrollHeight, lineHeight: 20, paddingY: 24, borderY: 2 });

  it('shows one row for empty / single-line content', () => {
    expect(textareaHeight(m(44))).toEqual({ height: 46, overflow: false });
  });

  it('grows with rendered content height, so soft-wrapped lines count too', () => {
    // 3 visual lines (e.g. one long line wrapped) with no hard newline
    expect(textareaHeight(m(84))).toEqual({ height: 86, overflow: false });
  });

  it('clamps at maxRows and reports overflow so pasted walls scroll', () => {
    expect(textareaHeight(m(50 * 20 + 24))).toEqual({ height: 226, overflow: true });
    expect(textareaHeight(m(50 * 20 + 24), 4)).toEqual({ height: 106, overflow: true });
  });

  it('never goes below one row and tolerates a missing line-height', () => {
    expect(textareaHeight({ scrollHeight: 0, lineHeight: 0, paddingY: 0, borderY: 0 }).height).toBe(20);
  });
});
