/**
 * Hooks / Event System
 *
 * Provides an extensibility mechanism for lifecycle events in the agent.
 * Tool calls, messages, agent events, memory operations, and session
 * events can be intercepted or observed via registered handlers.
 *
 * Key pattern: "tool" matches all tool events, "tool:before_call" matches specific action.
 * Handlers run sequentially. Errors are caught and logged (never crash the agent).
 */

export type HookEventType = 'agent' | 'tool' | 'message' | 'session' | 'memory';

export interface HookEvent {
  type: HookEventType;
  action: string;           // e.g., 'start', 'complete', 'error', 'before_call', 'after_call'
  sessionId: string;
  context: Record<string, unknown>;
  timestamp: Date;
}

export type HookHandler = (event: HookEvent) => Promise<void>;

/** Internal handler registry */
const handlers = new Map<string, HookHandler[]>();

/** Optional error logger — set via setHookLogger */
let hookLogger: ((msg: string, error: unknown) => void) | null = null;

/**
 * Set a logger for hook errors. If not set, errors are silently caught.
 */
export function setHookLogger(logger: (msg: string, error: unknown) => void): void {
  hookLogger = logger;
}

/**
 * Register a handler for an event key.
 *
 * @param eventKey - "tool" for all tool events, or "tool:before_call" for specific action
 * @param handler - Async handler function
 */
export function registerHook(eventKey: string, handler: HookHandler): void {
  const existing = handlers.get(eventKey) || [];
  existing.push(handler);
  handlers.set(eventKey, existing);
}

/**
 * Unregister a previously registered handler.
 */
export function unregisterHook(eventKey: string, handler: HookHandler): void {
  const existing = handlers.get(eventKey);
  if (!existing) return;

  const idx = existing.indexOf(handler);
  if (idx >= 0) {
    existing.splice(idx, 1);
    if (existing.length === 0) {
      handlers.delete(eventKey);
    }
  }
}

/**
 * Trigger all handlers matching the event.
 *
 * Runs type-level handlers first (e.g., "tool"), then specific handlers
 * (e.g., "tool:before_call"). Sequential execution, errors caught.
 */
export async function triggerHook(event: HookEvent): Promise<void> {
  // Type-level handlers (e.g., "tool")
  const typeHandlers = handlers.get(event.type) || [];
  for (const handler of typeHandlers) {
    try {
      await handler(event);
    } catch (error) {
      if (hookLogger) {
        hookLogger(`Hook handler error for "${event.type}"`, error);
      }
    }
  }

  // Specific action handlers (e.g., "tool:before_call")
  const specificKey = `${event.type}:${event.action}`;
  const specificHandlers = handlers.get(specificKey) || [];
  for (const handler of specificHandlers) {
    try {
      await handler(event);
    } catch (error) {
      if (hookLogger) {
        hookLogger(`Hook handler error for "${specificKey}"`, error);
      }
    }
  }
}

/**
 * Clear all registered hooks. Useful for testing or reset.
 */
export function clearHooks(): void {
  handlers.clear();
}

/**
 * Get the number of registered handlers (for debugging/testing).
 */
export function getHookCount(): number {
  let count = 0;
  for (const list of handlers.values()) {
    count += list.length;
  }
  return count;
}
