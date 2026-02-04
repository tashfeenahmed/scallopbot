/**
 * Reminder Skill Execution Script
 *
 * Manages reminders stored in a JSON file.
 * The gateway monitors this file and triggers reminders at the right time.
 */

import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import * as os from 'os';

// Types
interface Reminder {
  id: string;
  message: string;
  triggerAt: string; // ISO date string
  userId: string;
  sessionId: string;
  createdAt: string;
  recurring?: RecurringSchedule;
}

interface RecurringSchedule {
  type: 'daily' | 'weekly' | 'weekdays' | 'weekends';
  time: { hour: number; minute: number };
  dayOfWeek?: number;
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

// Get reminders file path
function getRemindersPath(): string {
  const dataDir = process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot');
  return path.join(dataDir, 'reminders.json');
}

// Load reminders from file
function loadReminders(): Reminder[] {
  const filePath = getRemindersPath();
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return [];
}

// Save reminders to file
function saveReminders(reminders: Reminder[]): void {
  const filePath = getRemindersPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(reminders, null, 2));
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
  target.setHours(schedule.time.hour, schedule.time.minute, 0, 0);

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
      return { schedule: { type: 'daily', time }, message: dailyMatch[2]?.trim() };
    }
  }

  // "every Monday at 10am"
  const weeklyMatch = lower.match(/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weeklyMatch) {
    const dayOfWeek = parseDayOfWeek(weeklyMatch[1]);
    const time = parseTime(weeklyMatch[2]);
    if (dayOfWeek !== null && time) {
      return { schedule: { type: 'weekly', time, dayOfWeek }, message: weeklyMatch[3]?.trim() };
    }
  }

  // "weekdays at 9am"
  const weekdaysMatch = lower.match(/^(?:every\s+)?weekdays?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weekdaysMatch) {
    const time = parseTime(weekdaysMatch[1]);
    if (time) {
      return { schedule: { type: 'weekdays', time }, message: weekdaysMatch[2]?.trim() };
    }
  }

  // "weekends at 10am"
  const weekendsMatch = lower.match(/^(?:every\s+)?weekends?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})(?:\s+(?:to\s+)?(.+))?$/i);
  if (weekendsMatch) {
    const time = parseTime(weekendsMatch[1]);
    if (time) {
      return { schedule: { type: 'weekends', time }, message: weekendsMatch[2]?.trim() };
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

  const now = new Date();
  let triggerAt: Date;
  let recurring: RecurringSchedule | undefined;
  let scheduleDescription: string;

  // Try parsing as recurring
  const recurringResult = parseRecurring(args.time);
  if (recurringResult) {
    recurring = recurringResult.schedule;
    triggerAt = getNextOccurrence(recurring);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const timeFormatted = `${recurring.time.hour % 12 || 12}:${recurring.time.minute.toString().padStart(2, '0')} ${recurring.time.hour >= 12 ? 'PM' : 'AM'}`;

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
      triggerAt = absoluteTime;
      scheduleDescription = triggerAt.toLocaleString('en-US', {
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
      triggerAt = new Date(now.getTime() + delayMinutes * 60 * 1000);
      scheduleDescription = `in ${delayMinutes} minute${delayMinutes === 1 ? '' : 's'}`;
    }
  }

  const reminder: Reminder = {
    id: nanoid(8),
    message: args.message,
    triggerAt: triggerAt.toISOString(),
    userId: process.env.SKILL_USER_ID || 'unknown',
    sessionId: process.env.SKILL_SESSION_ID || 'unknown',
    createdAt: now.toISOString(),
    recurring,
  };

  // Save to file
  const reminders = loadReminders();
  reminders.push(reminder);
  saveReminders(reminders);

  const nextTriggerStr = triggerAt.toLocaleString('en-US', {
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
    output: `Reminder set${recurringNote}! I'll remind you "${args.message}" ${scheduleDescription}. Next trigger: ${nextTriggerStr}. ID: ${reminder.id}`,
    exitCode: 0,
  };
}

// List reminders
function listReminders(): SkillResult {
  const reminders = loadReminders();
  const now = Date.now();

  // Filter out past non-recurring reminders
  const activeReminders = reminders.filter(r => {
    const triggerTime = new Date(r.triggerAt).getTime();
    return triggerTime > now || r.recurring;
  });

  if (activeReminders.length === 0) {
    return {
      success: true,
      output: 'No active reminders.',
      exitCode: 0,
    };
  }

  const lines = activeReminders.map(r => {
    const triggerAt = new Date(r.triggerAt);
    const timeStr = triggerAt.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const minsLeft = Math.round((triggerAt.getTime() - now) / 60000);
    const recurringLabel = r.recurring ? ' [recurring]' : '';
    return `- [${r.id}]${recurringLabel} "${r.message}" at ${timeStr} (${minsLeft > 0 ? minsLeft + ' min left' : 'due'})`;
  });

  return {
    success: true,
    output: `Active reminders:\n${lines.join('\n')}`,
    exitCode: 0,
  };
}

// Cancel a reminder
function cancelReminder(args: ReminderArgs): SkillResult {
  if (!args.reminder_id) {
    return {
      success: false,
      output: '',
      error: 'Missing required parameter: reminder_id',
      exitCode: 1,
    };
  }

  const reminders = loadReminders();
  const index = reminders.findIndex(r => r.id === args.reminder_id);

  if (index === -1) {
    return {
      success: false,
      output: '',
      error: `Reminder ${args.reminder_id} not found. Use action "list" to see active reminders.`,
      exitCode: 1,
    };
  }

  reminders.splice(index, 1);
  saveReminders(reminders);

  return {
    success: true,
    output: `Reminder ${args.reminder_id} cancelled.`,
    exitCode: 0,
  };
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
