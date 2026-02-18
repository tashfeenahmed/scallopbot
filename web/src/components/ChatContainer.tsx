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
}

const ChatContainer = forwardRef<HTMLDivElement, ChatContainerProps>(
  function ChatContainer({ messages, debugMode, isWaiting, onLoadMore, isLoadingMore, hasMore }, ref) {
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
      <main ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-[10%] py-2 bg-gray-50 dark:bg-gray-950 max-md:px-3">
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
