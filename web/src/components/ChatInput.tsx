import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useMemo, useState } from 'react';
import { COMMANDS, type CommandDefinition } from '../commands';
import CommandMenu from './CommandMenu';

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isWaiting: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}

export default function ChatInput({ onSend, onStop, isWaiting, disabled, inputRef }: ChatInputProps) {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (menuOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filtered[activeIndex]);
        return;
      }
    }
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault();
      setMenuOpen(false);
      setText('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
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
      <form onSubmit={handleSubmit} className="relative flex gap-2 items-center max-w-3xl mx-auto">
        {menuOpen && (
          <CommandMenu commands={filtered} activeIndex={activeIndex} onSelect={selectCommand} />
        )}

        <button
          type="button"
          onClick={toggleMenu}
          className="w-11 h-11 flex items-center justify-center rounded-full shrink-0 transition-colors bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
          title="Commands"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          disabled={disabled}
          autoComplete="off"
          className="flex-1 px-4 py-3 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-gray-900 dark:text-gray-100 outline-none focus:border-blue-300 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-gray-400 dark:placeholder:text-gray-500"
        />
        <button
          type="submit"
          disabled={disabled}
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
