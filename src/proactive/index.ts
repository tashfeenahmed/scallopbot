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
