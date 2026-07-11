/**
 * Triggers module - unified trigger source abstraction
 *
 * Provides a common interface for channels that can receive
 * triggered messages (reminders, notifications, proactive messages).
 */

export {
  type MessageDeliveryMetadata,
  type MessageDeliveryHandler,
  type MessageDeliveryReceipt,
  type MessageDeliveryResult,
  type MessageDeliverySuppressed,
  type MessageDeliveryValidation,
  type TriggerSource,
  type TriggerSourceRegistry,
  isMessageDeliveryReceipt,
  isMessageDeliverySuppressed,
  messageWasDelivered,
  parseUserIdPrefix,
} from './types.js';
