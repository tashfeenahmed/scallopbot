// Pure connection-state logic for the chat UI, kept free of React so the
// root vitest suite (node environment) can cover it: web/ has no test runner
// of its own.

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export const MAX_RECONNECT = 10;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30000;

/** Exponential backoff schedule shared by useWebSocket and its tests. */
export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

/** After MAX_RECONNECT failed attempts the socket stops retrying by itself
 *  and the UI must offer a manual retry. */
export function shouldGiveUp(attempt: number): boolean {
  return attempt >= MAX_RECONNECT;
}

export interface ConnectionBanner {
  text: string;
  /** 'busy' = we're still trying; 'dead' = needs the user to act. */
  tone: 'busy' | 'dead';
  /** Offer "Try now" for both, but it only makes a visible difference once
   *  the auto-retries are exhausted; before that it just reconnects sooner. */
  showRetry: boolean;
}

export function connectionBanner(status: ConnectionStatus): ConnectionBanner | null {
  switch (status) {
    case 'connected':
      return null;
    case 'connecting':
      return { text: 'Reconnecting…', tone: 'busy', showRetry: true };
    case 'disconnected':
      return { text: 'Disconnected — messages can’t be sent.', tone: 'dead', showRetry: true };
  }
}

/** The composer sits disabled while offline; say so in the placeholder so the
 *  dead input isn’t a mystery. */
export function composerPlaceholder(status: ConnectionStatus): string {
  return status === 'connected' ? 'Message…' : 'Waiting for connection…';
}
