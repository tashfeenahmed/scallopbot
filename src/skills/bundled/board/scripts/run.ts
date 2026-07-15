/**
 * Board Skill Execution Script
 *
 * Unified kanban task board that replaces reminder and progress skills.
 * Manages board items stored in the scheduled_items table.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { isBoardItemLiveForContext } from '../../../../memory/state-relevance.js';

// ─── Types ────────────────────────────────────────────────────────────

type BoardStatus = 'inbox' | 'backlog' | 'scheduled' | 'in_progress' | 'waiting' | 'done' | 'archived';
type Priority = 'urgent' | 'high' | 'medium' | 'low';
type RecurringType = 'daily' | 'weekly' | 'monthly' | 'weekdays' | 'weekends';

interface RecurringSchedule {
  type: RecurringType;
  hour: number;
  minute: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
}

interface BoardItemResult {
  response: string;
  completedAt: number;
  subAgentRunId?: string;
  iterationsUsed?: number;
  costUsd?: number;
  taskComplete?: boolean;
  notifiedAt?: number | null;
  outcome?: 'succeeded' | 'failed' | 'blocked';
  completionSource?: 'user' | 'worker';
}

interface ScheduledItemRow {
  id: string;
  user_id: string;
  session_id: string | null;
  source: string;
  kind: string;
  type: string;
  message: string;
  context: string | null;
  trigger_at: number;
  recurring: string | null;
  status: string;
  fired_at: number | null;
  source_memory_id: string | null;
  task_config: string | null;
  board_status: string | null;
  priority: string | null;
  labels: string | null;
  result: string | null;
  depends_on: string | null;
  goal_id: string | null;
  worker_id: string | null;
  preferred_worker_id: string | null;
  lease_expires_at: number | null;
  attempt_count: number | null;
  max_attempts: number | null;
  last_error: string | null;
  handed_off_from: string | null;
  created_at: number;
  updated_at: number;
}

interface BoardItem {
  id: string;
  title: string;
  kind: string;
  type: string;
  boardStatus: BoardStatus;
  priority: Priority;
  labels: string[] | null;
  triggerAt: number;
  recurring: RecurringSchedule | null;
  goalId: string | null;
  goalTitle?: string;
  dependsOn: string[] | null;
  result: BoardItemResult | null;
  source: string;
  context: string | null;
  sourceMemoryId: string | null;
  workerId: string | null;
  preferredWorkerId: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  handedOffFrom: string | null;
  createdAt: number;
  updatedAt: number;
}

interface BoardArgs {
  action: 'view' | 'add' | 'move' | 'update' | 'done' | 'archive' | 'detail' | 'snooze';
  scope?: 'current' | 'all';
  column?: BoardStatus;
  priority?: Priority;
  label?: string;
  title?: string;
  kind?: 'nudge' | 'task';
  trigger_time?: string;
  recurring?: RecurringSchedule;
  labels?: string[];
  goal_id?: string;
  task_config?: {
    goal: string;
    tools?: string[];
    evidencePolicy?: 'none' | 'tool_receipts';
    requiredEvidenceTools?: string[];
    stalePolicy?: 'expire' | 'run_once';
    maxLatenessMs?: number;
  };
  item_id?: string;
  status?: BoardStatus;
  result?: string;
  time?: string;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

// ─── DB Helpers ───────────────────────────────────────────────────────

function getDbPath(): string {
  const possiblePaths = [
    // MEMORY_DB_PATH decouples the DB from the workspace — honor it first.
    process.env.MEMORY_DB_PATH || null,
    process.env.SKILL_WORKSPACE ? path.join(process.env.SKILL_WORKSPACE, 'memories.db') : null,
    path.join(process.cwd(), 'memories.db'),
    path.join(process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot'), 'memories.db'),
  ];
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  const dataDir = process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot');
  return path.join(dataDir, 'memories.db');
}

function openDb(): Database.Database {
  return new Database(getDbPath());
}

const USER_TIMEZONE = process.env.SKILL_USER_TIMEZONE || 'UTC';
const USER_ID = process.env.SKILL_STATE_USER_ID || process.env.SKILL_USER_ID || 'default';
const SESSION_ID = process.env.SKILL_SESSION_ID || null;

interface OwnedItemLookup {
  row?: ScheduledItemRow;
  error?: string;
}

/**
 * Resolve a full or abbreviated board ID without crossing the state owner's
 * boundary. Abbreviations must identify exactly one owned row; SQLite's
 * arbitrary first match is not safe for mutations.
 */
function findOwnedItem(db: Database.Database, itemId: string): OwnedItemLookup {
  const rows = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE user_id = ?
      AND (id = ? OR substr(id, 1, length(?)) = ?)
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
    LIMIT 2
  `).all(USER_ID, itemId, itemId, itemId, itemId) as ScheduledItemRow[];

  if (rows.length === 0) return { error: `Item not found: ${itemId}` };
  if (rows[0].id === itemId) return { row: rows[0] };
  if (rows.length > 1) return { error: `Item ID is ambiguous: ${itemId}` };
  return { row: rows[0] };
}

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// ─── Computed Board Status ────────────────────────────────────────────
// NOTE: Duplicated from src/board/types.ts:computeBoardStatus().
// This skill runs as a standalone subprocess and cannot import TS modules.
// Keep both copies in sync.

function computeBoardStatus(row: ScheduledItemRow): BoardStatus {
  if (row.board_status) return row.board_status as BoardStatus;
  switch (row.status) {
    case 'pending':    return row.trigger_at > 0 ? 'scheduled' : 'inbox';
    case 'processing': return 'in_progress';
    case 'blocked':    return 'waiting';
    case 'fired':
    case 'acted':      return 'done';
    case 'dismissed':
    case 'expired':
    case 'failed':     return 'archived';
    default:           return 'inbox';
  }
}

function rowToBoardItem(row: ScheduledItemRow, goalTitle?: string): BoardItem {
  return {
    id: row.id,
    title: row.message,
    kind: row.kind || 'nudge',
    type: row.type,
    boardStatus: computeBoardStatus(row),
    priority: (row.priority as Priority) || 'medium',
    labels: row.labels ? JSON.parse(row.labels) : null,
    triggerAt: row.trigger_at,
    recurring: row.recurring ? JSON.parse(row.recurring) : null,
    goalId: row.goal_id,
    goalTitle,
    dependsOn: row.depends_on ? JSON.parse(row.depends_on) : null,
    result: row.result ? JSON.parse(row.result) : null,
    source: row.source,
    context: row.context,
    sourceMemoryId: row.source_memory_id,
    workerId: row.worker_id ?? null,
    preferredWorkerId: row.preferred_worker_id ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    attemptCount: row.attempt_count ?? 0,
    maxAttempts: row.max_attempts ?? 3,
    lastError: row.last_error ?? null,
    handedOffFrom: row.handed_off_from ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Time Parsing (from reminder skill) ──────────────────────────────

function parseTime(input: string): { hour: number; minute: number } | null {
  const lower = input.toLowerCase().trim();
  const time24Match = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (time24Match) {
    const hour = parseInt(time24Match[1], 10);
    const minute = parseInt(time24Match[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
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

/**
 * Convert a wall-clock time in USER_TIMEZONE to a UTC Date, independent of
 * the Node process's system timezone. Uses Intl.DateTimeFormat.formatToParts
 * to compute the offset by rendering an approximate UTC value in the target
 * TZ and diffing.
 */
function tzToUtc(y: number, m: number, d: number, h: number, min: number): Date {
  const approxUtcMs = Date.UTC(y, m, d, h, min);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: USER_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(approxUtcMs));
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value || '0', 10);
  const tzAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = tzAsUtcMs - approxUtcMs;
  return new Date(approxUtcMs - offsetMs);
}

function getUserNowParts() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: USER_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';
  const dayNames: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(getPart('year'), 10),
    month: parseInt(getPart('month'), 10) - 1,
    day: parseInt(getPart('day'), 10),
    hour: parseInt(getPart('hour'), 10),
    minute: parseInt(getPart('minute'), 10),
    dayOfWeek: dayNames[getPart('weekday')] ?? now.getDay(),
    now,
  };
}

function getNextOccurrence(schedule: RecurringSchedule): Date {
  const userNow = getUserNowParts();
  let { year, month, day } = userNow;
  // Use UTC math so date advancement doesn't depend on the Node process's system TZ
  const advance = () => {
    const ms = Date.UTC(year, month, day + 1);
    const d = new Date(ms);
    day = d.getUTCDate(); month = d.getUTCMonth(); year = d.getUTCFullYear();
  };
  const getDow = () => new Date(Date.UTC(year, month, day)).getUTCDay();
  const todayTarget = tzToUtc(year, month, day, schedule.hour, schedule.minute);

  switch (schedule.type) {
    case 'daily':
      if (todayTarget <= userNow.now) advance();
      break;
    case 'weekly':
      if (schedule.dayOfWeek !== undefined) {
        let daysUntil = schedule.dayOfWeek - userNow.dayOfWeek;
        if (daysUntil < 0 || (daysUntil === 0 && todayTarget <= userNow.now)) daysUntil += 7;
        for (let i = 0; i < daysUntil; i++) advance();
      }
      break;
    case 'monthly': {
      const desired = schedule.dayOfMonth ?? userNow.day;
      const setMonthday = () => {
        const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        day = Math.min(desired, last);
      };
      setMonthday();
      if (tzToUtc(year, month, day, schedule.hour, schedule.minute) <= userNow.now) {
        const next = new Date(Date.UTC(year, month + 1, 1));
        year = next.getUTCFullYear(); month = next.getUTCMonth();
        setMonthday();
      }
      break;
    }
    case 'weekdays':
      if (todayTarget <= userNow.now || getDow() === 0 || getDow() === 6) advance();
      while (getDow() === 0 || getDow() === 6) advance();
      break;
    case 'weekends':
      if (todayTarget <= userNow.now || (getDow() !== 0 && getDow() !== 6)) advance();
      while (getDow() !== 0 && getDow() !== 6) advance();
      break;
  }
  return tzToUtc(year, month, day, schedule.hour, schedule.minute);
}

/** Map day name (full or short) to day-of-week index (0=Sun..6=Sat) */
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

/**
 * Detect recurring patterns inside a natural-language time string.
 * Returns a RecurringSchedule if the input matches one of:
 *   "every day at 8am" / "daily at 9:30am"
 *   "every Monday at 10am"
 *   "weekdays at 9am" / "every weekday at 9am"
 *   "weekends at 10am"
 * Returns null otherwise (caller should fall back to one-off parsing).
 */
function parseRecurringString(input: string): RecurringSchedule | null {
  const lower = input.toLowerCase().trim();

  const dailyMatch = lower.match(/^(?:every\s*day|daily)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i);
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1]);
    if (time) return { type: 'daily', hour: time.hour, minute: time.minute };
  }

  const weeklyMatch = lower.match(/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i);
  if (weeklyMatch) {
    const dayOfWeek = parseDayOfWeek(weeklyMatch[1]);
    const time = parseTime(weeklyMatch[2]);
    if (dayOfWeek !== null && time) {
      return { type: 'weekly', hour: time.hour, minute: time.minute, dayOfWeek };
    }
  }

  const monthlyMatch = lower.match(/^(?:monthly|every\s+month)(?:\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i);
  if (monthlyMatch) {
    const dayOfMonth = monthlyMatch[1] ? parseInt(monthlyMatch[1], 10) : getUserNowParts().day;
    const time = parseTime(monthlyMatch[2]);
    if (dayOfMonth >= 1 && dayOfMonth <= 31 && time) {
      return { type: 'monthly', hour: time.hour, minute: time.minute, dayOfMonth };
    }
  }

  const weekdaysMatch = lower.match(/^(?:every\s+)?weekdays?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i);
  if (weekdaysMatch) {
    const time = parseTime(weekdaysMatch[1]);
    if (time) return { type: 'weekdays', hour: time.hour, minute: time.minute };
  }

  const weekendsMatch = lower.match(/^(?:every\s+)?weekends?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i);
  if (weekendsMatch) {
    const time = parseTime(weekendsMatch[1]);
    if (time) return { type: 'weekends', hour: time.hour, minute: time.minute };
  }

  return null;
}

/** Resolve a wall-clock {hour,minute} in user TZ to a UTC Date, dayShift days from today. */
function targetFromUserTime(time: { hour: number; minute: number }, dayShift: number, advanceIfPast: boolean): Date {
  const userNow = getUserNowParts();
  const baseUtc = Date.UTC(userNow.year, userNow.month, userNow.day + dayShift);
  const base = new Date(baseUtc);
  let target = tzToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), time.hour, time.minute);
  if (advanceIfPast && target <= userNow.now) {
    const next = new Date(baseUtc + 24 * 60 * 60 * 1000);
    target = tzToUtc(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), time.hour, time.minute);
  }
  return target;
}

/** Default times for relative-day-period phrases ("tonight" → 9pm). All in user TZ. */
const PERIOD_TIMES: Record<string, { hour: number; minute: number }> = {
  morning: { hour: 9, minute: 0 },
  noon: { hour: 12, minute: 0 },
  afternoon: { hour: 15, minute: 0 },
  evening: { hour: 19, minute: 0 },
  night: { hour: 22, minute: 0 },
  tonight: { hour: 21, minute: 0 },
  midnight: { hour: 0, minute: 0 },
};

function parseTriggerTime(input: string): { triggerAt: number; description: string } | null {
  // Strip a "today" prefix so "today 8pm" / "today at 8pm" fall through to the bare-time branch.
  const lower = input.toLowerCase().trim().replace(/^today\s+/, '');

  // ISO 8601 timestamp (with or without timezone). Anchor on the leading digits so
  // we don't accidentally match plain "8" as ISO. Accepts e.g. 2026-04-25T22:00:00Z,
  // 2026-04-25 22:00, 2026-04-25T22:00.
  const isoMatch = lower.match(/^\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?$/i);
  if (isoMatch) {
    const t = new Date(input.trim());
    if (!isNaN(t.getTime())) {
      return { triggerAt: t.getTime(), description: formatDateTime(t) };
    }
  }

  // Named time-of-day phrases: "tonight", "this evening", "this morning",
  // "tomorrow morning", "tomorrow night", etc.
  const periodMatch = lower.match(/^(?:(this|tomorrow)\s+)?(morning|noon|afternoon|evening|night|midnight|tonight)$/);
  if (periodMatch) {
    const dayWord = periodMatch[1];
    const period = periodMatch[2];
    const time = PERIOD_TIMES[period];
    if (time) {
      // "tonight" implicitly means today; "tomorrow night" means +1 day.
      const dayShift = dayWord === 'tomorrow' ? 1 : 0;
      // If "this <period>" or bare "tonight" and the implied time has already passed,
      // do NOT auto-advance — assume the user means today still (e.g. running late).
      // Only "morning" advances when past, since "this morning" tomorrow makes no sense.
      const advance = dayShift === 0 && period === 'morning';
      const target = targetFromUserTime(time, dayShift, advance);
      return { triggerAt: target.getTime(), description: formatDateTime(target) };
    }
  }

  // "at 10am", "at 3:30pm", bare "8pm"
  const atTimeMatch = lower.match(/^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (atTimeMatch) {
    const time = parseTime(atTimeMatch[1]);
    if (time) {
      const target = targetFromUserTime(time, 0, true);
      return { triggerAt: target.getTime(), description: formatDateTime(target) };
    }
  }

  // "tomorrow at 10am", "tomorrow 9am", or suffix "10am tomorrow"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  const tomorrowSuffixMatch = lower.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s+tomorrow$/);
  const tomorrowTime = tomorrowMatch ? parseTime(tomorrowMatch[1]) : (tomorrowSuffixMatch ? parseTime(tomorrowSuffixMatch[1]) : null);
  if (tomorrowTime) {
    const target = targetFromUserTime(tomorrowTime, 1, false);
    return { triggerAt: target.getTime(), description: formatDateTime(target) };
  }

  // "in X minutes/hours/days"
  const inMatch = lower.match(/^in\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?)$/);
  if (inMatch) {
    const value = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    let ms: number;
    if (unit.startsWith('d')) ms = value * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('h')) ms = value * 60 * 60 * 1000;
    else ms = value * 60 * 1000;
    const target = new Date(Date.now() + ms);
    return { triggerAt: target.getTime(), description: formatDateTime(target) };
  }

  // Direct "X minutes/hours"
  const directMatch = lower.match(/^(\d+)\s*(min(?:ute)?s?|hours?|hrs?)$/);
  if (directMatch) {
    const value = parseInt(directMatch[1], 10);
    const unit = directMatch[2];
    const ms = unit.startsWith('h') ? value * 60 * 60 * 1000 : value * 60 * 1000;
    const target = new Date(Date.now() + ms);
    return { triggerAt: target.getTime(), description: formatDateTime(target) };
  }

  return null;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: USER_TIMEZONE,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function formatRecurringDescription(recurring: RecurringSchedule): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const timeFormatted = `${recurring.hour % 12 || 12}:${recurring.minute.toString().padStart(2, '0')} ${recurring.hour >= 12 ? 'PM' : 'AM'}`;
  switch (recurring.type) {
    case 'daily': return `every day at ${timeFormatted}`;
    case 'weekly': return `every ${dayNames[recurring.dayOfWeek!]} at ${timeFormatted}`;
    case 'monthly': return `monthly on day ${recurring.dayOfMonth} at ${timeFormatted}`;
    case 'weekdays': return `weekdays at ${timeFormatted}`;
    case 'weekends': return `weekends at ${timeFormatted}`;
  }
}

// ─── Goal Lookup ─────────────────────────────────────────────────────

function getGoalTitle(db: Database.Database, goalId: string): string | undefined {
  const row = db.prepare('SELECT content FROM memories WHERE id = ? AND user_id = ?')
    .get(goalId, USER_ID) as { content: string } | undefined;
  if (row?.content) return row.content;
  const durable = db.prepare(`
    SELECT title FROM goal_registry
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(goalId, USER_ID) as { title: string } | undefined;
  return durable?.title;
}

// ─── Board Actions ───────────────────────────────────────────────────

const ACTIVE_COLUMNS: BoardStatus[] = ['inbox', 'backlog', 'scheduled', 'in_progress', 'waiting'];

function viewBoard(args: BoardArgs): SkillResult {
  const db = openDb();

  const rows = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE user_id = ? AND status NOT IN ('expired')
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 2 END,
      trigger_at ASC
  `).all(USER_ID) as ScheduledItemRow[];

  // Collect goal titles
  const goalIds = new Set(rows.filter(r => r.goal_id).map(r => r.goal_id!));
  const goalTitles = new Map<string, string>();
  for (const gid of goalIds) {
    const title = getGoalTitle(db, gid);
    if (title) goalTitles.set(gid, title);
  }

  let items = rows.map(r => rowToBoardItem(r, r.goal_id ? goalTitles.get(r.goal_id) : undefined));

  const allScope = args.scope === 'all' || Boolean(args.column);
  const preservedCount = allScope
    ? 0
    : items.filter(item => ACTIVE_COLUMNS.includes(item.boardStatus)
      && !isBoardItemLiveForContext(item)).length;
  if (!allScope) {
    items = items.filter(item => isBoardItemLiveForContext(item));
  }

  // Apply filters
  if (args.column) items = items.filter(i => i.boardStatus === args.column);
  if (args.priority) items = items.filter(i => i.priority === args.priority);
  if (args.label) items = items.filter(i => i.labels?.includes(args.label!) ?? false);

  // Group by column
  const columns: Record<string, BoardItem[]> = {};
  for (const col of ['inbox', 'backlog', 'scheduled', 'in_progress', 'waiting', 'done', 'archived']) {
    columns[col] = [];
  }
  for (const item of items) {
    columns[item.boardStatus]?.push(item);
  }

  // Format output
  let output = allScope ? '📋 FULL BOARD\n' : '📋 CURRENT BOARD\n';

  // Urgent items first
  const urgentItems = ACTIVE_COLUMNS.flatMap(col => columns[col]).filter(i => i.priority === 'urgent');
  if (urgentItems.length > 0) {
    output += '\n🔴 URGENT\n';
    for (const item of urgentItems) output += formatItemLine(item);
  }

  const icons: Record<string, string> = {
    in_progress: '▸', scheduled: '📅', waiting: '⏸', inbox: '📥', backlog: '📋',
  };

  for (const col of ACTIVE_COLUMNS) {
    const colItems = columns[col].filter(i => i.priority !== 'urgent');
    if (colItems.length === 0) continue;
    const onlyNudges = colItems.every(item => item.kind === 'nudge');
    const label = col === 'scheduled' && onlyNudges
      ? 'SCHEDULED REMINDERS (not current work priorities)'
      : col.replace('_', ' ').toUpperCase();
    output += `\n${icons[col] || '▸'} ${label} (${columns[col].length})\n`;
    for (const item of colItems) output += formatItemLine(item);
  }

  // Done column (limited)
  if (columns.done.length > 0 && !args.column) {
    output += `\n✅ DONE (${columns.done.length})\n`;
    for (const item of columns.done.slice(0, 5)) output += formatItemLine(item);
    if (columns.done.length > 5) output += `  ...and ${columns.done.length - 5} more\n`;
  }

  // Summary
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const doneThisWeek = columns.done.filter(i => i.updatedAt > weekAgo).length;
  const parts: string[] = [];
  if (columns.backlog.length > 0) parts.push(`${columns.backlog.length} in backlog`);
  if (doneThisWeek > 0) parts.push(`${doneThisWeek} done this week`);
  if (parts.length > 0) output += `\n${parts.join(' · ')}`;
  if (preservedCount > 0) {
    output += `\n\n${preservedCount} older, blocked, completed, backlog, or agent-suggested item(s) are preserved outside the current view. Use scope="all" to inspect them; do not report them as current user priorities.`;
  }

  db.close();
  return { success: true, output, exitCode: 0 };
}

function addItem(args: BoardArgs): SkillResult {
  if (!args.title) {
    return { success: false, output: '', error: 'Missing required parameter: title', exitCode: 1 };
  }

  const db = openDb();
  const id = nanoid();
  const now = Date.now();
  const kind = args.kind || 'nudge';
  let triggerAt = 0;
  let recurring: RecurringSchedule | null = null;
  let boardStatus: BoardStatus;
  let scheduleDesc = '';

  // Parse trigger time
  if (args.recurring && typeof args.recurring === 'object' && args.recurring.type) {
    recurring = args.recurring;
    triggerAt = getNextOccurrence(recurring).getTime();
    scheduleDesc = formatRecurringDescription(recurring);
    boardStatus = 'scheduled';
  } else if (args.trigger_time) {
    // Defense in depth: detect recurring patterns the LLM packed into trigger_time
    // ("every day at 8am", "every Monday at 9am", "weekdays at 9am", etc.)
    const inferredRecurring = parseRecurringString(args.trigger_time);
    if (inferredRecurring) {
      recurring = inferredRecurring;
      triggerAt = getNextOccurrence(recurring).getTime();
      scheduleDesc = formatRecurringDescription(recurring);
      boardStatus = 'scheduled';
    } else {
      const parsed = parseTriggerTime(args.trigger_time);
      if (!parsed) {
        db.close();
        return {
          success: false,
          output: '',
          error: `Could not parse time: "${args.trigger_time}". Accepted formats: "8pm" / "at 10am" / "3:30pm" / "today 8pm" / "tonight" / "this evening" / "tomorrow 9am" / "10am tomorrow" / "in 30 min" / "in 2 hours" / "in 3 days" / ISO "2026-04-25T22:00". For recurring use the recurring object instead, e.g. {"type":"daily","hour":8,"minute":0}.`,
          exitCode: 1,
        };
      }
      triggerAt = parsed.triggerAt;
      scheduleDesc = parsed.description;
      boardStatus = 'scheduled';
    }
  } else {
    boardStatus = 'backlog';
  }

  // Guard against obviously-wrong far-future triggers (often from an LLM that
  // misparsed a date or persisted an error-response as a scheduled task).
  const MAX_FUTURE_MS = 180 * 24 * 60 * 60 * 1000;
  if (triggerAt > 0 && triggerAt > Date.now() + MAX_FUTURE_MS) {
    db.close();
    return { success: false, output: '', error: `trigger_time is more than 180 days in the future (${new Date(triggerAt).toISOString()}). If that's intentional, file a board item with kind='task' and no trigger_time.`, exitCode: 1 };
  }

  const priority = args.priority || 'medium';
  const type = kind === 'task' ? 'event_prep' : 'reminder';

  if (args.goal_id && !getGoalTitle(db, args.goal_id)) {
    db.close();
    return {
      success: false,
      output: '',
      error: `Goal not found for this user: ${args.goal_id}`,
      exitCode: 1,
    };
  }

  // Recurring items live forever, so a concrete date baked into the title goes
  // stale immediately ("Daily Report - March 8, 2026" still firing in June).
  // Strip trailing date suffixes from recurring titles.
  let title = args.title;
  if (recurring) {
    title = title
      .replace(/\s*[-–—:,]?\s*\(?\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\)?\s*$/i, '')
      .replace(/\s*[-–—:,]?\s*\(?\d{4}-\d{2}-\d{2}\)?\s*$/, '')
      .trim() || args.title;
  }

  db.prepare(`
    INSERT INTO scheduled_items (
      id, user_id, session_id, source, kind, type, message, context,
      trigger_at, recurring, status, source_memory_id, fired_at,
      task_config, board_status, priority, labels, depends_on, goal_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, USER_ID, SESSION_ID, 'user', kind, type, title, null,
    triggerAt,
    recurring ? JSON.stringify(recurring) : null,
    'pending', null, null,
    args.task_config ? JSON.stringify(args.task_config) : null,
    boardStatus, priority,
    args.labels ? JSON.stringify(args.labels) : null,
    null,
    args.goal_id || null,
    now, now
  );

  let output = `Added to ${boardStatus}: "${args.title}"`;
  output += `\nID: ${id.substring(0, 6)} · Priority: ${priority} · Kind: ${kind}`;
  if (scheduleDesc) output += `\nScheduled: ${scheduleDesc}`;
  if (recurring) output += ' 🔁';
  if (args.labels?.length) output += `\nLabels: ${args.labels.join(', ')}`;
  if (args.goal_id) {
    const goalTitle = getGoalTitle(db, args.goal_id);
    if (goalTitle) output += `\nGoal: ${goalTitle}`;
  }

  db.close();
  return { success: true, output, exitCode: 0 };
}

function moveItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }
  const targetStatus = args.status || args.column;
  if (!targetStatus) {
    return { success: false, output: '', error: 'Missing required parameter: status (target column)', exitCode: 1 };
  }
  if (targetStatus === 'done') return markDone({ ...args, action: 'done' });

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  // Map to underlying status
  let underlyingStatus = row.status;
  if (targetStatus === 'archived') underlyingStatus = 'dismissed';
  else if (targetStatus === 'in_progress') underlyingStatus = 'processing';
  else underlyingStatus = 'pending';

  db.prepare('UPDATE scheduled_items SET board_status = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(targetStatus, underlyingStatus, Date.now(), row.id, USER_ID);

  const from = computeBoardStatus(row);
  db.close();
  return { success: true, output: `Moved "${row.message}" from ${from} → ${targetStatus}`, exitCode: 0 };
}

function updateItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  const changes: string[] = [];

  if (args.title) {
    sets.push('message = ?'); params.push(args.title);
    // This title came through a model-invoked tool call. Updating an item that
    // previously held trusted literal text must revoke that bypass.
    sets.push("message_provenance = 'generated'");
    changes.push(`title → "${args.title}"`);
  }
  if (args.priority) {
    sets.push('priority = ?'); params.push(args.priority);
    changes.push(`priority → ${args.priority}`);
  }
  if (args.labels) {
    sets.push('labels = ?'); params.push(JSON.stringify(args.labels));
    changes.push(`labels → ${args.labels.join(', ')}`);
  }
  if (args.kind) {
    sets.push('kind = ?'); params.push(args.kind);
    changes.push(`kind → ${args.kind}`);
  }
  if (args.trigger_time) {
    // If user passed a recurring phrase ("every day at 9am"), rewrite the full
    // recurring schedule. This replaces any existing recurring rule.
    const inferredRecurring = parseRecurringString(args.trigger_time);
    if (inferredRecurring) {
      sets.push('recurring = ?'); params.push(JSON.stringify(inferredRecurring));
      sets.push('trigger_at = ?'); params.push(getNextOccurrence(inferredRecurring).getTime());
      sets.push('board_status = ?'); params.push('scheduled');
      sets.push('status = ?'); params.push('pending');
      changes.push(`recurring → ${formatRecurringDescription(inferredRecurring)}`);
    } else {
      const parsed = parseTriggerTime(args.trigger_time);
      if (parsed) {
        sets.push('trigger_at = ?'); params.push(parsed.triggerAt);
        sets.push('board_status = ?'); params.push('scheduled');
        sets.push('status = ?'); params.push('pending');
        changes.push(`scheduled → ${parsed.description}`);
        // If item currently has a recurring rule and the new trigger_time is a
        // plain time like "9am", realign recurring.hour/minute so future
        // occurrences use the new time too (otherwise the next recurrence
        // would snap back to the old schedule).
        if (row.recurring) {
          try {
            const existing = JSON.parse(row.recurring) as RecurringSchedule;
            const plainTimeMatch = args.trigger_time.trim().toLowerCase().match(/^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
            if (plainTimeMatch) {
              const t = parseTime(plainTimeMatch[1]);
              if (t) {
                const updated: RecurringSchedule = { ...existing, hour: t.hour, minute: t.minute };
                sets.push('recurring = ?'); params.push(JSON.stringify(updated));
                changes.push(`recurring realigned to ${formatRecurringDescription(updated)}`);
              }
            }
          } catch {
            // Malformed existing recurring JSON — leave it alone
          }
        }
      }
    }
  }

  params.push(row.id, USER_ID);
  db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

  db.close();
  return { success: true, output: `Updated "${row.message}": ${changes.join(', ') || 'no changes'}`, exitCode: 0 };
}

function markDone(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  const now = Date.now();
  const updates: string[] = ['board_status = ?', 'status = ?', 'fired_at = ?', 'updated_at = ?'];
  const params: unknown[] = ['done', 'fired', now, now];

  const result: BoardItemResult = {
    response: args.result ?? 'Marked complete by the user.',
    completedAt: now,
    taskComplete: true,
    outcome: 'succeeded',
    completionSource: 'user',
  };
  updates.push('result = ?');
  params.push(JSON.stringify(result));

  params.push(row.id, USER_ID);
  db.prepare(`UPDATE scheduled_items SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

  db.close();
  return { success: true, output: `Marked done: "${row.message}"${args.result ? ' with note' : ''}`, exitCode: 0 };
}

function archiveItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  db.prepare('UPDATE scheduled_items SET board_status = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run('archived', 'dismissed', Date.now(), row.id, USER_ID);

  db.close();
  return { success: true, output: `Archived: "${row.message}"`, exitCode: 0 };
}

function showDetail(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  const item = rowToBoardItem(row, row.goal_id ? getGoalTitle(db, row.goal_id) : undefined);
  const status = item.boardStatus.replace('_', ' ').toUpperCase();

  let output = `📌 ${item.title}\n`;
  output += `Status: ${status} · Priority: ${item.priority} · Kind: ${item.kind}\n`;
  output += `ID: ${item.id}\n`;

  if (item.triggerAt > 0) {
    output += `Scheduled: ${new Date(item.triggerAt).toLocaleString('en-US', { timeZone: USER_TIMEZONE })}\n`;
  }
  if (item.recurring) output += `Recurring: ${formatRecurringDescription(item.recurring)}\n`;
  if (item.goalTitle) output += `Goal: ${item.goalTitle}\n`;
  if (item.labels?.length) output += `Labels: ${item.labels.join(', ')}\n`;
  if (item.dependsOn?.length) output += `Depends on: ${item.dependsOn.join(', ')}\n`;
  if (item.workerId) output += `Worker: ${item.workerId}\n`;
  if (item.preferredWorkerId) output += `Preferred worker: ${item.preferredWorkerId}\n`;
  if (item.kind === 'task') output += `Attempts: ${item.attemptCount}/${item.maxAttempts}\n`;
  if (item.leaseExpiresAt) output += `Lease expires: ${new Date(item.leaseExpiresAt).toISOString()}\n`;
  if (item.handedOffFrom) output += `Handed off from: ${item.handedOffFrom}\n`;
  if (item.lastError) output += `Last error: ${item.lastError}\n`;
  if (item.context) output += `Context: ${item.context}\n`;
  if (item.result) {
    output += `\n--- Result ---\n${item.result.response}\n`;
    output += `Completed: ${new Date(item.result.completedAt).toLocaleString('en-US', { timeZone: USER_TIMEZONE })}\n`;
    if (item.result.iterationsUsed) output += `Iterations: ${item.result.iterationsUsed}\n`;
    if (item.result.costUsd !== undefined) output += `Cost: $${item.result.costUsd.toFixed(6)}\n`;
  }
  output += `\nCreated: ${new Date(item.createdAt).toLocaleString('en-US', { timeZone: USER_TIMEZONE })}`;
  output += ` · Source: ${item.source}`;

  db.close();
  return { success: true, output, exitCode: 0 };
}

function snoozeItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }
  const timeStr = args.time || args.trigger_time;
  if (!timeStr) {
    return { success: false, output: '', error: 'Missing required parameter: time', exitCode: 1 };
  }

  const db = openDb();
  const lookup = findOwnedItem(db, args.item_id);
  const row = lookup.row;
  if (!row) {
    db.close();
    return { success: false, output: '', error: lookup.error, exitCode: 1 };
  }

  const parsed = parseTriggerTime(timeStr);
  if (!parsed) {
    db.close();
    return { success: false, output: '', error: `Could not parse time: "${timeStr}"`, exitCode: 1 };
  }

  db.prepare('UPDATE scheduled_items SET trigger_at = ?, board_status = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(parsed.triggerAt, 'scheduled', 'pending', Date.now(), row.id, USER_ID);

  db.close();
  return { success: true, output: `Snoozed "${row.message}" → ${parsed.description}`, exitCode: 0 };
}

// ─── Display Helper ──────────────────────────────────────────────────

function formatItemLine(item: BoardItem): string {
  const id = item.id.substring(0, 6);
  const kindIcon = item.kind === 'task' ? '⚡' : '💬';
  const source = item.source === 'agent' ? '🤖 ' : '';
  const goal = item.goalTitle ? ` · 🎯 ${item.goalTitle.substring(0, 25)}` : '';
  const recurring = item.recurring ? ' 🔁' : '';

  let timeStr = '';
  if (item.triggerAt > 0) {
    const d = new Date(item.triggerAt);
    const diffMs = item.triggerAt - Date.now();
    if (diffMs < 0) {
      timeStr = ' · overdue';
    } else if (diffMs < 24 * 60 * 60 * 1000) {
      timeStr = ` · today ${d.toLocaleTimeString('en-US', { timeZone: USER_TIMEZONE, hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffMs < 48 * 60 * 60 * 1000) {
      timeStr = ` · tomorrow ${d.toLocaleTimeString('en-US', { timeZone: USER_TIMEZONE, hour: '2-digit', minute: '2-digit' })}`;
    } else {
      timeStr = ` · ${d.toLocaleDateString('en-US', { timeZone: USER_TIMEZONE, month: 'short', day: 'numeric' })}`;
    }
  }

  let status = '';
  if (item.boardStatus === 'in_progress') status = ' · running...';
  if (item.boardStatus === 'waiting') status = ' · blocked';

  return `  [${id}] ${source}${item.title} ${kindIcon}${item.kind}${timeStr}${goal}${recurring}${status}\n`;
}

// ─── Main ────────────────────────────────────────────────────────────

function main(): void {
  const rawArgs = process.env.SKILL_ARGS;
  if (!rawArgs) {
    outputResult({ success: false, output: '', error: 'No SKILL_ARGS provided', exitCode: 1 });
    return;
  }

  let args: BoardArgs;
  try {
    args = JSON.parse(rawArgs);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.action) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: action', exitCode: 1 });
    return;
  }

  let result: SkillResult;
  switch (args.action) {
    case 'view':    result = viewBoard(args); break;
    case 'add':     result = addItem(args); break;
    case 'move':    result = moveItem(args); break;
    case 'update':  result = updateItem(args); break;
    case 'done':    result = markDone(args); break;
    case 'archive': result = archiveItem(args); break;
    case 'detail':  result = showDetail(args); break;
    case 'snooze':  result = snoozeItem(args); break;
    default:
      result = { success: false, output: '', error: `Unknown action: ${args.action}. Use: view, add, move, update, done, archive, detail, snooze`, exitCode: 1 };
  }

  outputResult(result);
}

main();
