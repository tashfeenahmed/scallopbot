/**
 * Proactive messaging system
 *
 * Unified scheduler handles both user-set reminders and agent-set triggers.
 * - User reminders (source='user'): Direct message delivery
 * - Agent triggers (source='agent'): LLM-generated contextual messages
 */

export {
  UnifiedScheduler,
  type UnifiedSchedulerOptions,
  type MessageHandler,
  type AgentProcessHandler,
} from './scheduler.js';

export {
  isInQuietHours,
  computeDeliveryTime,
  type TimingContext,
  type DeliveryTiming,
} from './timing-model.js';

export {
  detectProactiveEngagement,
  DEFAULT_ENGAGEMENT_WINDOW_MS,
} from './feedback.js';

export {
  formatProactiveForTelegram,
  formatProactiveForWebSocket,
  formatProactiveMessage,
  type ProactiveFormatInput,
  type ProactiveWebSocketOutput,
} from './proactive-format.js';
