import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket, type WsMessage } from './hooks/useWebSocket';
import { useCosts } from './hooks/useCosts';
import { useAuth } from './hooks/useAuth';
import Sidebar from './components/Sidebar';
import CreditsPanel from './components/CreditsPanel';
import ChatContainer from './components/ChatContainer';
import ChatInput from './components/ChatInput';
import SetupScreen from './components/SetupScreen';
import LoginScreen from './components/LoginScreen';

const MemoryMap = lazy(() => import('./components/memory-map/MemoryMap'));

export type ViewMode = 'chat' | 'memory-map' | 'costs';

function pathToView(pathname: string): ViewMode {
  if (pathname === '/memory') return 'memory-map';
  if (pathname === '/costs') return 'costs';
  return 'chat';
}

function viewToPath(view: ViewMode): string {
  if (view === 'memory-map') return '/memory';
  if (view === 'costs') return '/costs';
  return '/';
}

export interface ChatMessage {
  id: number;
  type: 'user' | 'assistant' | 'system' | 'error' | 'debug' | 'memory' | 'file';
  content: string;
  isMarkdown?: boolean;
  // DB message ID for cursor pagination
  _dbId?: number;
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

/** Content block from DB */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

/** Parse a DB message into ChatMessage(s) — may return 0, 1, or multiple */
function dbMessageToChatMessages(
  dbMsg: { id: number; role: string; content: string },
  counter: () => number,
): ChatMessage[] {
  const { role, content } = dbMsg;
  const results: ChatMessage[] = [];

  // Try parsing as ContentBlock array
  let blocks: ContentBlock[] | null = null;
  if (content.startsWith('[')) {
    try { blocks = JSON.parse(content); } catch { /* not JSON */ }
  }

  if (!blocks) {
    // Plain text message
    if (role === 'user') {
      results.push({ id: counter(), type: 'user', content, _dbId: dbMsg.id });
    } else if (role === 'assistant') {
      results.push({ id: counter(), type: 'assistant', content, isMarkdown: true, _dbId: dbMsg.id });
    }
    return results;
  }

  // ContentBlock array — separate text from tool/thinking
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      const type = role === 'user' ? 'user' : 'assistant';
      results.push({
        id: counter(),
        type,
        content: block.text,
        isMarkdown: role === 'assistant',
        _dbId: dbMsg.id,
      });
    } else if (block.type === 'thinking' && block.thinking) {
      results.push({
        id: counter(),
        type: 'debug',
        content: block.thinking,
        debugType: 'thinking',
        label: 'thinking',
        _dbId: dbMsg.id,
      });
    } else if (block.type === 'tool_use' && block.name) {
      const inputStr = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
      results.push({
        id: counter(),
        type: 'debug',
        content: inputStr,
        debugType: 'tool-start',
        label: `tool:${block.name}`,
        _dbId: dbMsg.id,
      });
    } else if (block.type === 'tool_result') {
      const output = typeof block.content === 'string' ? block.content.slice(0, 300) : '';
      results.push({
        id: counter(),
        type: 'debug',
        content: output,
        debugType: block.is_error ? 'tool-error' : 'tool-complete',
        label: `tool:result`,
        _dbId: dbMsg.id,
      });
    }
    // Skip other block types (tool_result with no content, etc.)
  }

  return results;
}

let messageIdCounter = 0;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>(() => pathToView(window.location.pathname));
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('darkMode');
    return stored ? stored === 'true' : true;
  });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const { costs, refetch: refetchCosts } = useCosts();
  const { authState, error: authError, setup, login, logout } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync view changes to browser URL
  const handleViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view);
    const path = viewToPath(view);
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  }, []);

  // Listen for browser back/forward
  useEffect(() => {
    const onPopState = () => {
      setCurrentView(pathToView(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: ++messageIdCounter }]);
  }, []);

  const handleWsMessage = useCallback(
    (data: WsMessage) => {
      switch (data.type) {
        case 'response':
          setIsWaiting(false);
          // Empty sessionId from /new command — clear history
          if (data.sessionId === '') {
            setMessages([]);
            setHasMore(false);
            setHistoryLoaded(false);
          }
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
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + data.content },
                ];
              }
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

  const { status, sendMessage, sendStop, sessionId } = useWebSocket({
    onMessage: handleWsMessage,
    enabled: authState === 'authenticated',
  });

  // Load chat history when connected (unified across all channels)
  useEffect(() => {
    if (status !== 'connected' || historyLoaded) return;

    const loadHistory = async () => {
      try {
        const res = await fetch('/api/messages?limit=50');
        if (!res.ok) {
          setHistoryLoaded(true);
          return;
        }
        const { messages: dbMessages, hasMore: more } = await res.json();

        if (dbMessages && dbMessages.length > 0) {
          const counter = () => ++messageIdCounter;
          const chatMessages: ChatMessage[] = dbMessages
            .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
            .flatMap((m: { id: number; role: string; content: string }) =>
              dbMessageToChatMessages(m, counter)
            );

          setMessages(chatMessages);
          setHasMore(more);

          // Scroll to bottom after history loads
          requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          });
        }
      } catch (err) {
        console.error('Failed to load chat history:', err);
      }
      setHistoryLoaded(true);
    };

    loadHistory();
  }, [status, historyLoaded]);

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;

    // Find oldest _dbId in current messages
    const oldestDbId = messages.reduce<number | undefined>((min, m) => {
      if (m._dbId === undefined) return min;
      return min === undefined ? m._dbId : Math.min(min, m._dbId);
    }, undefined);

    if (oldestDbId === undefined) return;

    setIsLoadingMore(true);

    // Save scroll position before prepending
    const el = containerRef.current;
    const prevScrollHeight = el?.scrollHeight || 0;

    try {
      const res = await fetch(`/api/messages?limit=50&before=${oldestDbId}`);
      if (!res.ok) {
        setIsLoadingMore(false);
        return;
      }
      const { messages: dbMessages, hasMore: more } = await res.json();

      if (dbMessages && dbMessages.length > 0) {
        const counter = () => ++messageIdCounter;
        const olderMessages: ChatMessage[] = dbMessages
          .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
          .flatMap((m: { id: number; role: string; content: string }) =>
            dbMessageToChatMessages(m, counter)
          );

        setMessages((prev) => [...olderMessages, ...prev]);
        setHasMore(more);

        // Restore scroll position after prepend
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = el.scrollHeight - prevScrollHeight;
          }
        });
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error('Failed to load more messages:', err);
    }

    setIsLoadingMore(false);
  }, [isLoadingMore, hasMore, messages]);

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

  // Auth gating
  if (authState === 'loading') {
    return (
      <div className={darkMode ? 'dark' : ''}>
        <div className="flex items-center justify-center min-h-screen bg-white dark:bg-gray-950">
          <div className="w-8 h-8 border-2 border-gray-400 dark:border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (authState === 'needs-setup') {
    return <SetupScreen onSetup={setup} error={authError} darkMode={darkMode} />;
  }

  if (authState === 'needs-login') {
    return <LoginScreen onLogin={login} error={authError} darkMode={darkMode} />;
  }

  return (
    <div className={`${darkMode ? 'dark' : ''}`}>
      <div className="flex h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <Sidebar
          status={status}
          currentView={currentView}
          onViewChange={handleViewChange}
          darkMode={darkMode}
          onDarkModeToggle={() => setDarkMode((d) => !d)}
          debugMode={debugMode}
          onDebugToggle={setDebugMode}
          costsAvailable={costs !== null}
          hasSpend={costs !== null && costs.daily.spent > 0}
          onLogout={logout}
        />
        <div className="flex flex-col flex-1 min-w-0">
          {currentView === 'costs' ? (
            costs ? (
              <CreditsPanel costs={costs} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
                <p>No cost data available</p>
              </div>
            )
          ) : currentView === 'chat' ? (
            <>
              <ChatContainer
                ref={containerRef}
                messages={messages}
                debugMode={debugMode}
                isWaiting={isWaiting}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                hasMore={hasMore}
              />
              <ChatInput
                onSend={handleSend}
                onStop={handleStop}
                isWaiting={isWaiting}
                disabled={status !== 'connected'}
                inputRef={inputRef}
              />
            </>
          ) : (
            <Suspense fallback={
              <div className="flex-1 flex items-center justify-center bg-gray-100 dark:bg-gray-950 text-gray-500 dark:text-gray-400">
                <div className="w-8 h-8 border-2 border-gray-400 dark:border-blue-400 border-t-transparent rounded-full animate-spin" />
              </div>
            }>
              <MemoryMap darkMode={darkMode} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
