import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { COMMANDS, type CommandDefinition } from '../commands';
import CommandMenu from './CommandMenu';
import { composerKeyAction, loadDraft, saveDraft, textareaHeight } from '../hooks/composer';

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isWaiting: boolean;
  disabled: boolean;
  placeholder?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

function draftStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function ChatInput({ onSend, onStop, isWaiting, disabled, placeholder = 'Message...', inputRef }: ChatInputProps) {
  // A half-typed message survives a refresh or a disconnect-reload.
  const [text, setText] = useState(() => loadDraft(draftStorage()));
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    saveDraft(draftStorage(), text);
  }, [text]);

  // Auto-grow from the rendered content height (so soft-wrapped lines count,
  // not just hard newlines), capped at a max row count; past the cap the
  // field scrolls. Layout effect so the resize lands before paint.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    el.style.height = 'auto';
    const { height, overflow } = textareaHeight({
      scrollHeight: el.scrollHeight,
      lineHeight: px(cs.lineHeight),
      paddingY: px(cs.paddingTop) + px(cs.paddingBottom),
      borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
    });
    el.style.height = `${height}px`;
    el.style.overflowY = overflow ? 'auto' : 'hidden';
    // Keep the caret in view once the field is scrolling.
    if (overflow) el.scrollTop = el.scrollHeight;
  }, [text, inputRef]);

  // Filter commands based on current input after "/"
  const filtered = useMemo(() => {
    if (!menuOpen) return [];
    const query = text.startsWith('/') ? text.slice(1).toLowerCase() : '';
    return COMMANDS.filter((c) => c.name.toLowerCase().includes(query));
  }, [menuOpen, text]);

  // Reset active index when filtered list changes
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const footer = (e.target as HTMLElement).closest('footer');
      if (!footer) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [menuOpen]);

  const selectCommand = (cmd: CommandDefinition) => {
    setMenuOpen(false);
    if (cmd.name === 'stop') {
      onStop();
      setText('');
    } else if (cmd.sendImmediately) {
      onSend(`/${cmd.name}`);
      setText('');
    } else {
      setText(`/${cmd.name} `);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isWaiting) {
      onStop();
      return;
    }
    if (text.trim()) {
      onSend(text);
      setText('');
      setMenuOpen(false);
    }
  };

  const handleChange = (value: string) => {
    setText(value);
    // Open menu when input starts with "/" and has no space yet
    if (value.startsWith('/') && !value.includes(' ')) {
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    switch (composerKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      menuActive: menuOpen && filtered.length > 0,
      isWaiting,
      enabled: !disabled,
    })) {
      case 'next-command':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      case 'prev-command':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      case 'select-command':
        e.preventDefault();
        selectCommand(filtered[activeIndex]);
        return;
      case 'dismiss-menu':
        // Close the menu but keep what the user typed (previously Escape
        // wiped the whole draft).
        e.preventDefault();
        setMenuOpen(false);
        return;
      case 'stop':
        e.preventDefault();
        onStop();
        return;
      case 'send':
        e.preventDefault();
        handleSubmit(e);
        return;
      case 'newline':
        // Let the browser insert "\n" natively.
        return;
      default:
        return;
    }
  };

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
    } else {
      setMenuOpen(true);
      if (!text) {
        setText('/');
      }
      inputRef.current?.focus();
    }
  };

  return (
    <footer className="px-[10%] py-2 bg-transparent max-md:px-3">
      <form onSubmit={handleSubmit} className="relative flex gap-2 items-end max-w-3xl mx-auto">
        {menuOpen && (
          <CommandMenu commands={filtered} activeIndex={activeIndex} onSelect={selectCommand} />
        )}

        <button
          type="button"
          onClick={toggleMenu}
          aria-label="Commands"
          className="w-11 h-11 flex items-center justify-center rounded-full shrink-0 transition-colors bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
          title="Commands"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={true}
          rows={1}
          aria-label="Message. Shift+Enter adds a new line."
          className="flex-1 px-4 py-3 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl text-gray-900 dark:text-gray-100 outline-none focus:border-blue-300 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-gray-400 dark:placeholder:text-gray-500 leading-relaxed resize-none box-border"
        />
        <button
          type="submit"
          disabled={disabled}
          aria-label={isWaiting ? 'Stop generation' : 'Send message'}
          className={`w-11 h-11 flex items-center justify-center rounded-full shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            isWaiting
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-blue-500 hover:bg-blue-600'
          }`}
          title={isWaiting ? 'Stop generation' : 'Send message'}
        >
          {isWaiting ? (
            <svg viewBox="0 0 24 24" width="20" height="20">
              <rect fill="white" x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </form>
    </footer>
  );
}
