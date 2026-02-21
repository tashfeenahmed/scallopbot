/**
 * Proactive messaging system
 *
 * Unified scheduler handles both user-set reminders and agent-set triggers.
 * - Nudges (kind='nudge'): Pre-written messages delivered directly
 * - Tasks (kind='task'): Background work via sub-agent, result sent to user
 */

export {
  UnifiedScheduler,
  type UnifiedSchedulerOptions,
  type MessageHandler,
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

export {
  getRecentChatContext,
  type RecentChatContext,
  type RecentChatContextOptions,
} from './chat-context.js';
