import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectionBanner,
  reconnectDelay,
  shouldGiveUp,
  type ConnectionStatus,
} from './connection';

export type { ConnectionStatus };
export { connectionBanner };

export interface WsMessage {
  type: string;
  content?: string;
  error?: string;
  sessionId?: string;
  path?: string;
  caption?: string;
  skill?: string;
  input?: string;
  output?: string;
  result?: string;
  message?: string;
  count?: number;
  action?: string;
  category?: string;
  urgency?: 'low' | 'medium' | 'high';
  source?: 'inner_thoughts' | 'gap_scanner' | 'task_result';
  items?: { type: string; content: string; subject?: string }[];
}

interface UseWebSocketOptions {
  onMessage: (data: WsMessage) => void;
  enabled?: boolean;
}

const SESSION_KEY = 'smartbot_sessionId';

export function useWebSocket({ onMessage, enabled = true }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const HEARTBEAT_INTERVAL = 30000;

  const getWebSocketUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');

    try {
      const ws = new WebSocket(getWebSocketUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setStatus('connected');
        onMessageRef.current({ type: 'system', content: 'Connected to Scallopbot' });
      };

      ws.onmessage = (event) => {
        try {
          const data: WsMessage = JSON.parse(event.data);

          // Track sessionId from server responses
          if (data.type === 'response' && data.sessionId !== undefined) {
            if (data.sessionId) {
              localStorage.setItem(SESSION_KEY, data.sessionId);
              setSessionId(data.sessionId);
            } else {
              // Empty string signals session reset (/new command)
              localStorage.removeItem(SESSION_KEY);
              setSessionId(null);
            }
          }

          onMessageRef.current(data);
        } catch {
          console.error('Failed to parse message');
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setStatus('disconnected');

        if (shouldGiveUp(reconnectAttemptsRef.current)) {
          // Backoff budget spent. Keep status 'disconnected' so the banner's
          // "Try now" button stays available — previously the only escape was
          // a full page refresh.
          onMessageRef.current({
            type: 'error',
            error: 'Connection lost. Hit "Try now" above the message box to reconnect.',
          });
        } else {
          const delay = reconnectDelay(reconnectAttemptsRef.current);
          reconnectAttemptsRef.current++;
          onMessageRef.current({
            type: 'system',
            content: `Reconnecting in ${Math.round(delay / 1000)}s...`,
          });
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch {
      setStatus('disconnected');
    }
  }, [getWebSocketUrl]);

  const sendMessage = useCallback((message: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat', message }));
      return true;
    }
    return false;
  }, []);

  /** Manual retry from the offline banner: resets the backoff budget and
   *  reconnects immediately (also works after the auto-retries gave up). */
  const retry = useCallback(() => {
    clearTimeout(reconnectTimerRef.current);
    reconnectAttemptsRef.current = 0;
    // A socket still CONNECTING would otherwise be orphaned: its later onclose
    // nulls wsRef, flips status and schedules another reconnect on top of the
    // fresh socket. Detach it before starting over.
    const stale = wsRef.current;
    if (stale && stale.readyState !== WebSocket.OPEN) {
      stale.onclose = null;
      stale.onopen = null;
      stale.onmessage = null;
      stale.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  const sendStop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Not authenticated yet — don't connect
      clearTimeout(reconnectTimerRef.current);
      clearInterval(heartbeatRef.current);
      wsRef.current?.close();
      return;
    }

    connect();

    heartbeatRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL);

    return () => {
      clearTimeout(reconnectTimerRef.current);
      clearInterval(heartbeatRef.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  return { status, sendMessage, sendStop, retry, sessionId };
}
