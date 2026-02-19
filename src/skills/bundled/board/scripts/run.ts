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

// ─── Types ────────────────────────────────────────────────────────────

type BoardStatus = 'inbox' | 'backlog' | 'scheduled' | 'in_progress' | 'waiting' | 'done' | 'archived';
type Priority = 'urgent' | 'high' | 'medium' | 'low';
type RecurringType = 'daily' | 'weekly' | 'weekdays' | 'weekends';

interface RecurringSchedule {
  type: RecurringType;
  hour: number;
  minute: number;
  dayOfWeek?: number;
}

interface BoardItemResult {
  response: string;
  completedAt: number;
  subAgentRunId?: string;
  iterationsUsed?: number;
  notifiedAt?: number | null;
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
  createdAt: number;
  updatedAt: number;
}

interface BoardArgs {
  action: 'view' | 'add' | 'move' | 'update' | 'done' | 'archive' | 'detail' | 'snooze';
  column?: BoardStatus;
  priority?: Priority;
  label?: string;
  title?: string;
  kind?: 'nudge' | 'task';
  trigger_time?: string;
  recurring?: RecurringSchedule;
  labels?: string[];
  goal_id?: string;
  task_config?: { goal: string; tools?: string[] };
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
const USER_ID = process.env.SKILL_USER_ID || 'default';

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
    case 'fired':
    case 'acted':      return 'done';
    case 'dismissed':
    case 'expired':    return 'archived';
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

function tzToUtc(y: number, m: number, d: number, h: number, min: number): Date {
  const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
  const utcDate = new Date(dateStr + 'Z');
  const localStr = utcDate.toLocaleString('en-US', { timeZone: USER_TIMEZONE });
  const localDate = new Date(localStr);
  const offsetMs = localDate.getTime() - utcDate.getTime();
  return new Date(new Date(dateStr + 'Z').getTime() - offsetMs);
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
  const advance = () => {
    const d = new Date(year, month, day + 1);
    day = d.getDate(); month = d.getMonth(); year = d.getFullYear();
  };
  const getDow = () => new Date(year, month, day).getDay();
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

function parseTriggerTime(input: string): { triggerAt: number; description: string } | null {
  const lower = input.toLowerCase().trim();

  // "at 10am", "at 3:30pm"
  const atTimeMatch = lower.match(/^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (atTimeMatch) {
    const time = parseTime(atTimeMatch[1]);
    if (time) {
      const userNow = getUserNowParts();
      let target = tzToUtc(userNow.year, userNow.month, userNow.day, time.hour, time.minute);
      if (target <= userNow.now) {
        const d = new Date(userNow.year, userNow.month, userNow.day + 1);
        target = tzToUtc(d.getFullYear(), d.getMonth(), d.getDate(), time.hour, time.minute);
      }
      return { triggerAt: target.getTime(), description: formatDateTime(target) };
    }
  }

  // "tomorrow at 10am", "tomorrow 9am"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (tomorrowMatch) {
    const time = parseTime(tomorrowMatch[1]);
    if (time) {
      const userNow = getUserNowParts();
      const d = new Date(userNow.year, userNow.month, userNow.day + 1);
      const target = tzToUtc(d.getFullYear(), d.getMonth(), d.getDate(), time.hour, time.minute);
      return { triggerAt: target.getTime(), description: formatDateTime(target) };
    }
  }

  // "in X minutes/hours"
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
    case 'weekdays': return `weekdays at ${timeFormatted}`;
    case 'weekends': return `weekends at ${timeFormatted}`;
  }
}

// ─── Goal Lookup ─────────────────────────────────────────────────────

function getGoalTitle(db: Database.Database, goalId: string): string | undefined {
  const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(goalId) as { content: string } | undefined;
  return row?.content;
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
  let output = '📋 YOUR BOARD\n';

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
    const label = col.replace('_', ' ').toUpperCase();
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
    const parsed = parseTriggerTime(args.trigger_time);
    if (!parsed) {
      db.close();
      return { success: false, output: '', error: `Could not parse time: "${args.trigger_time}". Try: "in 30 min", "at 10am", "tomorrow 9am"`, exitCode: 1 };
    }
    triggerAt = parsed.triggerAt;
    scheduleDesc = parsed.description;
    boardStatus = 'scheduled';
  } else {
    boardStatus = 'backlog';
  }

  const priority = args.priority || 'medium';
  const type = kind === 'task' ? 'event_prep' : 'reminder';

  db.prepare(`
    INSERT INTO scheduled_items (
      id, user_id, session_id, source, kind, type, message, context,
      trigger_at, recurring, status, source_memory_id, fired_at,
      task_config, board_status, priority, labels, depends_on, goal_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, USER_ID, null, 'user', kind, type, args.title, null,
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

  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
  }

  // Map to underlying status
  let underlyingStatus = row.status;
  if (targetStatus === 'done') underlyingStatus = 'fired';
  else if (targetStatus === 'archived') underlyingStatus = 'dismissed';
  else if (targetStatus === 'in_progress') underlyingStatus = 'processing';
  else underlyingStatus = 'pending';

  db.prepare('UPDATE scheduled_items SET board_status = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(targetStatus, underlyingStatus, Date.now(), row.id);

  const from = computeBoardStatus(row);
  db.close();
  return { success: true, output: `Moved "${row.message}" from ${from} → ${targetStatus}`, exitCode: 0 };
}

function updateItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  const changes: string[] = [];

  if (args.title) {
    sets.push('message = ?'); params.push(args.title);
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
    const parsed = parseTriggerTime(args.trigger_time);
    if (parsed) {
      sets.push('trigger_at = ?'); params.push(parsed.triggerAt);
      sets.push('board_status = ?'); params.push('scheduled');
      changes.push(`scheduled → ${parsed.description}`);
    }
  }

  params.push(row.id);
  db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  db.close();
  return { success: true, output: `Updated "${row.message}": ${changes.join(', ') || 'no changes'}`, exitCode: 0 };
}

function markDone(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
  }

  const now = Date.now();
  const updates: string[] = ['board_status = ?', 'status = ?', 'fired_at = ?', 'updated_at = ?'];
  const params: unknown[] = ['done', 'fired', now, now];

  if (args.result) {
    const result: BoardItemResult = { response: args.result, completedAt: now };
    updates.push('result = ?');
    params.push(JSON.stringify(result));
  }

  params.push(row.id);
  db.prepare(`UPDATE scheduled_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  db.close();
  return { success: true, output: `Marked done: "${row.message}"${args.result ? ' with note' : ''}`, exitCode: 0 };
}

function archiveItem(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
  }

  db.prepare('UPDATE scheduled_items SET board_status = ?, status = ?, updated_at = ? WHERE id = ?')
    .run('archived', 'dismissed', Date.now(), row.id);

  db.close();
  return { success: true, output: `Archived: "${row.message}"`, exitCode: 0 };
}

function showDetail(args: BoardArgs): SkillResult {
  if (!args.item_id) {
    return { success: false, output: '', error: 'Missing required parameter: item_id', exitCode: 1 };
  }

  const db = openDb();
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
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
  if (item.context) output += `Context: ${item.context}\n`;
  if (item.result) {
    output += `\n--- Result ---\n${item.result.response}\n`;
    output += `Completed: ${new Date(item.result.completedAt).toLocaleString('en-US', { timeZone: USER_TIMEZONE })}\n`;
    if (item.result.iterationsUsed) output += `Iterations: ${item.result.iterationsUsed}\n`;
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
  const row = db.prepare('SELECT * FROM scheduled_items WHERE id = ? OR id LIKE ?')
    .get(args.item_id, `${args.item_id}%`) as ScheduledItemRow | undefined;
  if (!row) {
    db.close();
    return { success: false, output: '', error: `Item not found: ${args.item_id}`, exitCode: 1 };
  }

  const parsed = parseTriggerTime(timeStr);
  if (!parsed) {
    db.close();
    return { success: false, output: '', error: `Could not parse time: "${timeStr}"`, exitCode: 1 };
  }

  db.prepare('UPDATE scheduled_items SET trigger_at = ?, board_status = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(parsed.triggerAt, 'scheduled', 'pending', Date.now(), row.id);

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
