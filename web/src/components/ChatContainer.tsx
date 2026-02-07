import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../App';
import MessageBubble from './MessageBubble';
import DebugMessage from './DebugMessage';
import FileMessage from './FileMessage';
import TypingIndicator from './TypingIndicator';

interface ChatContainerProps {
  messages: ChatMessage[];
  debugMode: boolean;
  isWaiting: boolean;
}

export default function ChatContainer({ messages, debugMode, isWaiting }: ChatContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, isWaiting, debugMode]);

  return (
    <main ref={containerRef} className="flex-1 overflow-y-auto px-[10%] py-2 bg-gray-50 max-md:px-3">
      <div className="flex flex-col gap-1 max-w-3xl mx-auto">
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
