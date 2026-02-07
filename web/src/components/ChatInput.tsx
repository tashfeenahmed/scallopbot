import { type FormEvent, type KeyboardEvent, type RefObject, useState } from 'react';

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isWaiting: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}

export default function ChatInput({ onSend, onStop, isWaiting, disabled, inputRef }: ChatInputProps) {
  const [text, setText] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isWaiting) {
      onStop();
      return;
    }
    if (text.trim()) {
      onSend(text);
      setText('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <footer className="px-[10%] py-2 border-t border-gray-200 bg-white max-md:px-3">
      <form onSubmit={handleSubmit} className="flex gap-2 items-center max-w-3xl mx-auto">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          disabled={disabled}
          autoComplete="off"
          className="flex-1 px-4 py-3 text-sm bg-gray-50 border border-gray-200 rounded-full text-gray-900 outline-none focus:border-blue-300 focus:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-gray-400"
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
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="white" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          )}
        </button>
      </form>
    </footer>
  );
}
