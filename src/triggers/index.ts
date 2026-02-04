/**
 * Triggers module - unified trigger source abstraction
 *
 * Provides a common interface for channels that can receive
 * triggered messages (reminders, notifications, proactive messages).
 */

export {
  type TriggerSource,
  type TriggerSourceRegistry,
  parseUserIdPrefix,
} from './types.js';
