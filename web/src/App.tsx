import { useCallback, useRef, useState } from 'react';
import { useWebSocket, type WsMessage } from './hooks/useWebSocket';
import { useCosts } from './hooks/useCosts';
import Header from './components/Header';
import CreditsPanel from './components/CreditsPanel';
import ChatContainer from './components/ChatContainer';
import ChatInput from './components/ChatInput';

export interface ChatMessage {
  id: number;
  type: 'user' | 'assistant' | 'system' | 'error' | 'debug' | 'memory' | 'file';
  content: string;
  isMarkdown?: boolean;
  // Debug fields
  debugType?: 'tool-start' | 'tool-complete' | 'tool-error' | 'memory' | 'thinking';
  label?: string;
  // Memory fields
  memoryAction?: string;
  memoryItems?: { type: string; content: string; subject?: string }[];
  // File fields
  filePath?: string;
  caption?: string;
}

let messageIdCounter = 0;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const { costs, refetch: refetchCosts } = useCosts();
  const inputRef = useRef<HTMLInputElement>(null);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: ++messageIdCounter }]);
  }, []);

  const handleWsMessage = useCallback(
    (data: WsMessage) => {
      switch (data.type) {
        case 'response':
          setIsWaiting(false);
          if (data.content) {
            addMessage({ type: 'assistant', content: data.content, isMarkdown: true });
          }
          refetchCosts();
          inputRef.current?.focus();
          break;

        case 'chunk':
          if (data.content) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.type === 'assistant' && last.isMarkdown && !last.label) {
                // Append to the last assistant streaming message
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + data.content },
                ];
              }
              // Start a new streaming message
              return [
                ...prev,
                {
                  id: ++messageIdCounter,
                  type: 'assistant',
                  content: data.content!,
                  isMarkdown: true,
                },
              ];
            });
          }
          break;

        case 'system':
          addMessage({ type: 'system', content: data.content || '' });
          break;

        case 'skill_start':
          addMessage({
            type: 'debug',
            content: data.input || data.message || 'Starting...',
            debugType: 'tool-start',
            label: 'tool:' + (data.skill || 'skill'),
          });
          break;

        case 'skill_complete':
          addMessage({
            type: 'debug',
            content: data.output || data.result || 'Complete',
            debugType: 'tool-complete',
            label: 'tool:' + (data.skill || 'skill'),
          });
          break;

        case 'skill_error':
          addMessage({
            type: 'debug',
            content: data.error || 'Unknown error',
            debugType: 'tool-error',
            label: 'error:' + (data.skill || 'skill'),
          });
          break;

        case 'memory':
          addMessage({
            type: 'memory',
            content: data.message || `${data.count || 0} items`,
            debugType: 'memory',
            label: 'memory:' + (data.action || 'search'),
            memoryAction: data.action || 'search',
            memoryItems: data.items || [],
          });
          break;

        case 'thinking':
          addMessage({
            type: 'debug',
            content: data.message || '...',
            debugType: 'thinking',
            label: 'thinking',
          });
          break;

        case 'debug':
          addMessage({
            type: 'debug',
            content: data.message || '...',
            label: 'debug',
          });
          break;

        case 'trigger':
          setIsWaiting(false);
          if (data.content) {
            addMessage({ type: 'assistant', content: data.content, isMarkdown: true });
          }
          break;

        case 'file':
          addMessage({
            type: 'file',
            content: '',
            filePath: data.path,
            caption: data.caption,
          });
          break;

        case 'error':
          setIsWaiting(false);
          addMessage({ type: 'error', content: data.error || 'An error occurred' });
          inputRef.current?.focus();
          break;

        case 'pong':
          break;
      }
    },
    [addMessage, refetchCosts]
  );

  const { status, sendMessage, sendStop } = useWebSocket({
    onMessage: handleWsMessage,
  });

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      addMessage({ type: 'user', content: text });
      setIsWaiting(true);
      sendMessage(text);
      inputRef.current?.focus();
    },
    [addMessage, sendMessage]
  );

  const handleStop = useCallback(() => {
    sendStop();
    addMessage({ type: 'system', content: 'Stopping...' });
  }, [addMessage, sendStop]);

  return (
    <div className="flex flex-col h-screen bg-white">
      <Header
        status={status}
        debugMode={debugMode}
        onDebugToggle={setDebugMode}
        onCreditsToggle={() => setCreditsOpen((o) => !o)}
        creditsAvailable={costs !== null}
        hasSpend={costs !== null && costs.daily.spent > 0}
        creditsOpen={creditsOpen}
      />
      {creditsOpen && costs && <CreditsPanel costs={costs} />}
      <ChatContainer messages={messages} debugMode={debugMode} isWaiting={isWaiting} />
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isWaiting={isWaiting}
        disabled={status !== 'connected'}
        inputRef={inputRef}
      />
    </div>
  );
}
