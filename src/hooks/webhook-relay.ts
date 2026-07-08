import { registerHook, unregisterHook, type HookEvent, type HookHandler } from './hooks.js';

type FetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type FetchLike = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<FetchResponse>;

export interface WebhookRelayOptions {
  url: string;
  agentId: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface LifecycleWebhookPayload {
  schema_version: 1;
  agent_id: string;
  event: string;
  type: HookEvent['type'];
  action: string;
  session_id: string;
  timestamp: string;
  context: Record<string, unknown>;
}

const LIFECYCLE_HOOK_KEYS = [
  'memory:consolidation_complete',
  'memory:reflection_output',
  'session:affect_change',
] as const;

let activeRelayHandlers: Array<{ eventKey: string; handler: HookHandler }> = [];

export function createWebhookHookHandler(options: WebhookRelayOptions): HookHandler {
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    throw new Error('Webhook event relay requires global fetch support');
  }

  return async (event: HookEvent): Promise<void> => {
    const payload: LifecycleWebhookPayload = {
      schema_version: 1,
      agent_id: options.agentId,
      event: `${event.type}.${event.action}`,
      type: event.type,
      action: event.action,
      session_id: event.sessionId,
      timestamp: event.timestamp.toISOString(),
      context: event.context,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-scallopbot-event': payload.event,
      'x-scallopbot-agent-id': options.agentId,
    };
    if (options.secret) {
      headers.authorization = `Bearer ${options.secret}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let body = '';
        try {
          body = (await response.text()).slice(0, 500);
        } catch {
          // Ignore response body read failures; the status is enough to surface the relay error.
        }
        throw new Error(`Webhook event relay failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export function registerWebhookEventRelay(options: WebhookRelayOptions): number {
  unregisterWebhookEventRelay();

  const handler = createWebhookHookHandler(options);
  activeRelayHandlers = LIFECYCLE_HOOK_KEYS.map((eventKey) => ({ eventKey, handler }));
  for (const entry of activeRelayHandlers) {
    registerHook(entry.eventKey, entry.handler);
  }

  return activeRelayHandlers.length;
}

export function unregisterWebhookEventRelay(): void {
  for (const { eventKey, handler } of activeRelayHandlers) {
    unregisterHook(eventKey, handler);
  }
  activeRelayHandlers = [];
}
