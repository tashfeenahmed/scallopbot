import { describe, expect, it } from 'vitest';
import {
  composerKeyAction,
  loadDraft,
  saveDraft,
  textareaRows,
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

describe('textareaRows', () => {
  it('shows one row for empty text', () => {
    expect(textareaRows('')).toBe(1);
  });

  it('grows one row per hard newline', () => {
    expect(textareaRows('one\ntwo')).toBe(2);
    expect(textareaRows('a\nb\nc\nd')).toBe(4);
  });

  it('clamps at the max so pasted walls scroll instead of pushing the footer away', () => {
    const wall = Array(50).fill('line').join('\n');
    expect(textareaRows(wall)).toBe(10);
    expect(textareaRows(wall, 4)).toBe(4);
  });
});
