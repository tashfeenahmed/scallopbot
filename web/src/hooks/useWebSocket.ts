import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

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
  items?: { type: string; content: string; subject?: string }[];
}

interface UseWebSocketOptions {
  onMessage: (data: WsMessage) => void;
}

export function useWebSocket({ onMessage }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const MAX_RECONNECT = 10;
  const BASE_DELAY = 1000;
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
          const data = JSON.parse(event.data);
          onMessageRef.current(data);
        } catch {
          console.error('Failed to parse message');
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setStatus('disconnected');

        if (reconnectAttemptsRef.current < MAX_RECONNECT) {
          const delay = Math.min(
            BASE_DELAY * Math.pow(2, reconnectAttemptsRef.current),
            30000
          );
          reconnectAttemptsRef.current++;
          onMessageRef.current({
            type: 'system',
            content: `Reconnecting in ${Math.round(delay / 1000)}s...`,
          });
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          onMessageRef.current({
            type: 'error',
            error: 'Connection lost. Please refresh the page.',
          });
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

  const sendStop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, []);

  useEffect(() => {
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
  }, [connect]);

  return { status, sendMessage, sendStop };
}
