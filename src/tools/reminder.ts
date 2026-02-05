/**
 * Reminder Types
 *
 * The ReminderTool has been removed — replaced by the reminder skill.
 * These types are kept for the gateway's file-based reminder monitor.
 */

export interface Reminder {
  id: string;
  message: string;
  triggerAt: Date;
  userId: string;
  sessionId: string;
  createdAt: Date;
  recurring?: RecurringSchedule;
}

export interface RecurringSchedule {
  type: 'daily' | 'weekly' | 'weekdays' | 'weekends';
  time: { hour: number; minute: number };
  dayOfWeek?: number; // 0=Sunday, 1=Monday, etc. (for weekly)
}

export type ReminderCallback = (reminder: Reminder) => Promise<void>;
