import { forwardRef, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage } from '../App';
import MessageBubble from './MessageBubble';
import DebugMessage from './DebugMessage';
import FileMessage from './FileMessage';
import TypingIndicator from './TypingIndicator';

interface ChatContainerProps {
  messages: ChatMessage[];
  debugMode: boolean;
  isWaiting: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  historyLoaded?: boolean;
  historyError?: string | null;
  onRetryHistory?: () => void;
}

const ChatContainer = forwardRef<HTMLDivElement, ChatContainerProps>(
  function ChatContainer({ messages, debugMode, isWaiting, onLoadMore, isLoadingMore, hasMore, historyLoaded, historyError, onRetryHistory }, ref) {
    const internalRef = useRef<HTMLDivElement>(null);
    const containerRef = (ref as React.RefObject<HTMLDivElement>) || internalRef;
    const isNearBottomRef = useRef(true);

    const checkNearBottom = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    }, [containerRef]);

    // Auto-scroll to bottom when new messages arrive (only if user is near bottom)
    useEffect(() => {
      const el = containerRef.current;
      if (el && isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }, [messages, isWaiting, debugMode, containerRef]);

    const handleScroll = useCallback(() => {
      checkNearBottom();
      const el = containerRef.current;
      if (!el || !onLoadMore || isLoadingMore || !hasMore) return;
      if (el.scrollTop < 100) {
        onLoadMore();
      }
    }, [containerRef, onLoadMore, isLoadingMore, hasMore, checkNearBottom]);

    return (
      <main ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden px-[10%] py-2 bg-gray-50 dark:bg-gray-950 max-md:px-3">
        <div className="flex flex-col gap-1 max-w-3xl mx-auto">
          {isLoadingMore && (
            <div className="flex justify-center py-3">
              <div className="w-5 h-5 border-2 border-gray-400 dark:border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {hasMore && !isLoadingMore && (
            <button
              onClick={onLoadMore}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 py-2 mx-auto"
            >
              Load older messages
            </button>
          )}
          {historyError && (
            <div role="alert" className="mx-auto my-6 max-w-md rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-center">
              <p className="text-sm text-red-700 dark:text-red-300">{historyError}</p>
              {onRetryHistory && (
                <button
                  onClick={onRetryHistory}
                  className="mt-3 rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {!historyError && historyLoaded && messages.length === 0 && !isWaiting && (
            <div className="mx-auto my-16 max-w-md text-center" data-testid="chat-empty-state">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-gray-200 dark:border-neutral-700 text-gray-500 dark:text-gray-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">No conversations yet</h2>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Say hello, ask a question, or tell me something to remember — conversations here are shared with your other channels.
              </p>
            </div>
          )}
          {messages.map((msg) => {
            if (msg.type === 'file') {
              return <FileMessage key={msg.id} filePath={msg.filePath} caption={msg.caption} />;
            }
            if (msg.type === 'debug' || msg.type === 'memory') {
              if (!debugMode) return null;
              return <DebugMessage key={msg.id} message={msg} />;
            }
            return <MessageBubble key={msg.id} message={msg} />;
          })}
          {isWaiting && <TypingIndicator />}
        </div>
      </main>
    );
  }
);

export default ChatContainer;
