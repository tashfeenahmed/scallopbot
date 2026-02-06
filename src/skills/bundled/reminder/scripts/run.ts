/**
 * Reminder Skill Execution Script
 *
 * Manages reminders stored in SQLite (scheduled_items table).
 * The unified scheduler handles triggering at the right time.
 */

import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

// Types matching db.ts
type RecurringType = 'daily' | 'weekly' | 'weekdays' | 'weekends';

interface RecurringSchedule {
  type: RecurringType;
  hour: number;
  minute: number;
  dayOfWeek?: number;
}

interface ScheduledItem {
  id: string;
  userId: string;
  sessionId: string | null;
  source: 'user' | 'agent';
  type: string;
  message: string;
  context: string | null;
  triggerAt: number;
  recurring: RecurringSchedule | null;
  status: string;
  firedAt: number | null;
  sourceMemoryId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReminderArgs {
  action: 'set' | 'list' | 'cancel';
  time?: string;
  message?: string;
  reminder_id?: string;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

// Get database path
function getDbPath(): string {
  const dataDir = process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot');
  return path.join(dataDir, 'memories.db');
}

// Open database connection
function openDb(): Database.Database {
  const dbPath = getDbPath();
  return new Database(dbPath);
}

// Convert DB row to ScheduledItem
function rowToItem(row: Record<string, unknown>): ScheduledItem {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sessionId: row.session_id as string | null,
    source: row.source as 'user' | 'agent',
    type: row.type as string,
    message: row.message as string,
    context: row.context as string | null,
    triggerAt: row.trigger_at as number,
    recurring: row.recurring ? JSON.parse(row.recurring as string) : null,
    status: row.status as string,
    firedAt: row.fired_at as number | null,
    sourceMemoryId: row.source_memory_id as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

// Output result and exit
function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// Parse time string like "10am", "3:30pm", "14:00"
function parseTime(input: string): { hour: number; minute: number } | null {
  const lower = input.toLowerCase().trim();

  // 24-hour format
  const time24Match = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (time24Match) {
    const hour = parseInt(time24Match[1], 10);
    const minute = parseInt(time24Match[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  // 12-hour format
  const time12Match = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (time12Match) {
    let hour = parseInt(time12Match[1], 10);
    const minute = time12Match[2] ? parseInt(time12Match[2], 10) : 0;
    const period = time12Match[3];

    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (period === 'pm' && hour !== 12) hour += 12;
      if (period === 'am' && hour === 12) hour = 0;
      return { hour, minute };
    }
  }

  return null;
}

// Parse day of week
function parseDayOfWeek(input: string): number | null {
  const days: Record<string, number> = {
    'sunday': 0, 'sun': 0,
    'monday': 1, 'mon': 1,
    'tuesday': 2, 'tue': 2, 'tues': 2,
    'wednesday': 3, 'wed': 3,
    'thursday': 4, 'thu': 4, 'thur': 4, 'thurs': 4,
    'friday': 5, 'fri': 5,
    'saturday': 6, 'sat': 6,
  };
  return days[input.toLowerCase().trim()] ?? null;
}

// Calculate next occurrence for recurring schedule
function getNextOccurrence(schedule: RecurringSchedule): Date {
  const now = new Date();
  const target = new Date();
  target.setHours(schedule.hour, schedule.minute, 0, 0);

  switch (schedule.type) {
    case 'daily':
      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }
      break;

    case 'weekly':
      if (schedule.dayOfWeek !== undefined) {
        const currentDay = now.getDay();
        let daysUntil = schedule.dayOfWeek - currentDay;
        if (daysUntil < 0 || (daysUntil === 0 && target <= now)) {
          daysUntil += 7;
        }
        target.setDate(target.getDate() + daysUntil);
      }
      break;

    case 'weekdays':
      while (target <= now || target.getDay() === 0 || target.getDay() === 6) {
        target.setDate(target.getDate() + 1);
      }
      break;

    case 'weekends':
      while (target <= now || (target.getDay() !== 0 && target.getDay() !== 6)) {
        target.setDate(target.getDate() + 1);
      }
      break;
  }

  return target;
}

// Parse recurring schedule
function parseRecurring(input: string): { schedule: RecurringSchedule; message?: string } | null {
  const lower = input.toLowerCase().trim();

  // "every day at 10am", "daily at 9:30am"
  const dailyMatch = lower.match(/^(?:every\s*day|daily)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1]);
    if (time) {
      return { schedule: { type: 'daily', hour: time.hour, minute: time.minute }, message: dailyMatch[2]?.trim() };
    }
  }

  // "every Monday at 10am"
  const weeklyMatch = lower.match(/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weeklyMatch) {
    const dayOfWeek = parseDayOfWeek(weeklyMatch[1]);
    const time = parseTime(weeklyMatch[2]);
    if (dayOfWeek !== null && time) {
      return { schedule: { type: 'weekly', hour: time.hour, minute: time.minute, dayOfWeek }, message: weeklyMatch[3]?.trim() };
    }
  }

  // "weekdays at 9am"
  const weekdaysMatch = lower.match(/^(?:every\s+)?weekdays?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weekdaysMatch) {
    const time = parseTime(weekdaysMatch[1]);
    if (time) {
      return { schedule: { type: 'weekdays', hour: time.hour, minute: time.minute }, message: weekdaysMatch[2]?.trim() };
    }
  }

  // "weekends at 10am"
  const weekendsMatch = lower.match(/^(?:every\s+)?weekends?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weekendsMatch) {
    const time = parseTime(weekendsMatch[1]);
    if (time) {
      return { schedule: { type: 'weekends', hour: time.hour, minute: time.minute }, message: weekendsMatch[2]?.trim() };
    }
  }

  return null;
}

// Parse absolute time
function parseAbsoluteTime(input: string): Date | null {
  const lower = input.toLowerCase().trim();

  // "at 10am", "at 3:30pm"
  const atTimeMatch = lower.match(/^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (atTimeMatch) {
    const time = parseTime(atTimeMatch[1]);
    if (time) {
      const now = new Date();
      const target = new Date();
      target.setHours(time.hour, time.minute, 0, 0);
      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }
      return target;
    }
  }

  // "tomorrow at 10am"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (tomorrowMatch) {
    const time = parseTime(tomorrowMatch[1]);
    if (time) {
      const target = new Date();
      target.setDate(target.getDate() + 1);
      target.setHours(time.hour, time.minute, 0, 0);
      return target;
    }
  }

  return null;
}

// Parse delay (intervals)
function parseDelay(input: string): number | null {
  const lower = input.toLowerCase().trim();

  // "in X minutes/hours"
  const inMatch = lower.match(/^in\s+(\d+)\s*(min(?:ute)?s?|hours?|hr)$/);
  if (inMatch) {
    const value = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (unit.startsWith('h')) {
      return value * 60;
    }
    return value;
  }

  // Direct "X minutes"
  const minutesMatch = lower.match(/^(\d+)\s*(?:min(?:ute)?s?)$/);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10);
  }

  // "X hours"
  const hoursMatch = lower.match(/^(\d+)\s*(?:hour|hr)s?$/);
  if (hoursMatch) {
    return parseInt(hoursMatch[1], 10) * 60;
  }

  return null;
}

// Set a reminder
function setReminder(args: ReminderArgs): SkillResult {
  if (!args.time) {
    return {
      success: false,
      output: '',
      error: 'Missing required parameter: time',
      exitCode: 1,
    };
  }

  if (!args.message) {
    return {
      success: false,
      output: '',
      error: 'Missing required parameter: message',
      exitCode: 1,
    };
  }

  const now = Date.now();
  let triggerAt: number;
  let recurring: RecurringSchedule | null = null;
  let scheduleDescription: string;

  // Try parsing as recurring
  const recurringResult = parseRecurring(args.time);
  if (recurringResult) {
    recurring = recurringResult.schedule;
    triggerAt = getNextOccurrence(recurring).getTime();

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const timeFormatted = `${recurring.hour % 12 || 12}:${recurring.minute.toString().padStart(2, '0')} ${recurring.hour >= 12 ? 'PM' : 'AM'}`;

    switch (recurring.type) {
      case 'daily':
        scheduleDescription = `every day at ${timeFormatted}`;
        break;
      case 'weekly':
        scheduleDescription = `every ${dayNames[recurring.dayOfWeek!]} at ${timeFormatted}`;
        break;
      case 'weekdays':
        scheduleDescription = `weekdays at ${timeFormatted}`;
        break;
      case 'weekends':
        scheduleDescription = `weekends at ${timeFormatted}`;
        break;
    }
  } else {
    // Try absolute time
    const absoluteTime = parseAbsoluteTime(args.time);
    if (absoluteTime) {
      triggerAt = absoluteTime.getTime();
      scheduleDescription = absoluteTime.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } else {
      // Try delay
      const delayMinutes = parseDelay(args.time);
      if (delayMinutes === null || delayMinutes <= 0) {
        return {
          success: false,
          output: '',
          error: `Could not parse time: "${args.time}". Try: "5 minutes", "at 10am", "tomorrow at 9am", "every day at 10am"`,
          exitCode: 1,
        };
      }
      triggerAt = now + delayMinutes * 60 * 1000;
      scheduleDescription = `in ${delayMinutes} minute${delayMinutes === 1 ? '' : 's'}`;
    }
  }

  const id = nanoid(8);
  const userId = process.env.SKILL_USER_ID || 'unknown';
  const sessionId = process.env.SKILL_SESSION_ID || null;

  // Save to SQLite
  const db = openDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, type, message, context,
        trigger_at, recurring, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userId,
      sessionId,
      'user',
      'reminder',
      args.message,
      null,
      triggerAt,
      recurring ? JSON.stringify(recurring) : null,
      'pending',
      now,
      now
    );
  } finally {
    db.close();
  }

  const nextTriggerStr = new Date(triggerAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const recurringNote = recurring ? ' (recurring)' : '';

  return {
    success: true,
    output: `Reminder set${recurringNote}! I'll remind you "${args.message}" ${scheduleDescription}. Next trigger: ${nextTriggerStr}. ID: ${id}`,
    exitCode: 0,
  };
}

// List reminders (shows both user reminders AND agent triggers)
function listReminders(): SkillResult {
  const userId = process.env.SKILL_USER_ID || 'unknown';
  const now = Date.now();

  const db = openDb();
  let items: ScheduledItem[];
  try {
    const stmt = db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND status = 'pending'
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    items = rows.map(rowToItem);
  } finally {
    db.close();
  }

  if (items.length === 0) {
    return {
      success: true,
      output: 'No active reminders or scheduled items.',
      exitCode: 0,
    };
  }

  const lines = items.map(item => {
    const triggerAt = new Date(item.triggerAt);
    const timeStr = triggerAt.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const minsLeft = Math.round((item.triggerAt - now) / 60000);

    // Labels for source and type
    const sourceLabel = item.source === 'agent' ? '[auto]' : '';
    const recurringLabel = item.recurring ? ' [recurring]' : '';
    const typeLabel = item.type !== 'reminder' ? ` (${item.type})` : '';

    return `- [${item.id}]${sourceLabel}${recurringLabel}${typeLabel} "${item.message}" at ${timeStr} (${minsLeft > 0 ? minsLeft + ' min left' : 'due'})`;
  });

  return {
    success: true,
    output: `Scheduled items:\n${lines.join('\n')}`,
    exitCode: 0,
  };
}

// Cancel a reminder (works for both user and agent items)
function cancelReminder(args: ReminderArgs): SkillResult {
  if (!args.reminder_id) {
    return {
      success: false,
      output: '',
      error: 'Missing required parameter: reminder_id',
      exitCode: 1,
    };
  }

  const userId = process.env.SKILL_USER_ID || 'unknown';

  const db = openDb();
  try {
    // First check if it exists and belongs to this user
    const checkStmt = db.prepare(`
      SELECT id, source, type FROM scheduled_items
      WHERE id = ? AND user_id = ? AND status = 'pending'
    `);
    const item = checkStmt.get(args.reminder_id, userId) as { id: string; source: string; type: string } | undefined;

    if (!item) {
      return {
        success: false,
        output: '',
        error: `Item ${args.reminder_id} not found. Use action "list" to see active items.`,
        exitCode: 1,
      };
    }

    // Mark as dismissed
    const updateStmt = db.prepare(`
      UPDATE scheduled_items
      SET status = 'dismissed', updated_at = ?
      WHERE id = ?
    `);
    updateStmt.run(Date.now(), args.reminder_id);

    const typeLabel = item.source === 'agent' ? `auto-scheduled ${item.type}` : 'reminder';
    return {
      success: true,
      output: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} ${args.reminder_id} cancelled.`,
      exitCode: 0,
    };
  } finally {
    db.close();
  }
}

// Main
function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
    return;
  }

  let args: ReminderArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  if (!args.action) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: action (set, list, or cancel)',
      exitCode: 1,
    });
    return;
  }

  let result: SkillResult;
  switch (args.action) {
    case 'set':
      result = setReminder(args);
      break;
    case 'list':
      result = listReminders();
      break;
    case 'cancel':
      result = cancelReminder(args);
      break;
    default:
      result = {
        success: false,
        output: '',
        error: `Unknown action: ${args.action}. Use 'set', 'list', or 'cancel'.`,
        exitCode: 1,
      };
  }

  outputResult(result);
}

main();
