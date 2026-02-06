/**
 * Goals Skill Execution Script
 *
 * Manages hierarchical goals stored in SQLite database.
 */

import * as path from 'path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

// Types
interface GoalMetadata {
  goalType: 'goal' | 'milestone' | 'task';
  status: 'backlog' | 'active' | 'completed';
  parentId?: string;
  dueDate?: number;
  completedAt?: number;
  progress?: number;
  checkinFrequency?: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  lastCheckin?: number;
  tags?: string[];
}

interface GoalItem {
  id: string;
  userId: string;
  content: string;
  metadata: GoalMetadata;
  createdAt: number;
  updatedAt: number;
}

interface GoalArgs {
  action: 'create' | 'list' | 'show' | 'activate' | 'complete' | 'reopen' | 'update' | 'delete';
  type?: 'goal' | 'milestone' | 'task';
  title?: string;
  parent_id?: string;
  id?: string;
  status?: 'backlog' | 'active' | 'completed';
  due?: string;
  checkin?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'none';
  tags?: string[];
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

// Database path
function getDbPath(): string {
  const workspace = process.env.SKILL_WORKSPACE || process.cwd();
  return path.join(workspace, 'memories.db');
}

// Parse due date string
function parseDueDate(dateStr: string): number | null {
  const lower = dateStr.toLowerCase().trim();
  const now = new Date();

  // Relative dates
  if (lower === 'today') {
    return now.setHours(23, 59, 59, 999);
  }
  if (lower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.setHours(23, 59, 59, 999);
  }
  if (lower === 'next week') {
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return nextWeek.setHours(23, 59, 59, 999);
  }
  if (lower === 'next month') {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return nextMonth.setHours(23, 59, 59, 999);
  }

  // "in X days"
  const inDaysMatch = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    const future = new Date(now);
    future.setDate(future.getDate() + days);
    return future.setHours(23, 59, 59, 999);
  }

  // "in X weeks"
  const inWeeksMatch = lower.match(/^in\s+(\d+)\s+weeks?$/);
  if (inWeeksMatch) {
    const weeks = parseInt(inWeeksMatch[1], 10);
    const future = new Date(now);
    future.setDate(future.getDate() + weeks * 7);
    return future.setHours(23, 59, 59, 999);
  }

  // "in X months"
  const inMonthsMatch = lower.match(/^in\s+(\d+)\s+months?$/);
  if (inMonthsMatch) {
    const months = parseInt(inMonthsMatch[1], 10);
    const future = new Date(now);
    future.setMonth(future.getMonth() + months);
    return future.setHours(23, 59, 59, 999);
  }

  // ISO date format
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}

// Output result and exit
function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// Get goal by ID
function getGoal(db: Database.Database, id: string): GoalItem | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const metadata = row.metadata ? JSON.parse(row.metadata as string) : {};
  if (!metadata.goalType) return null;

  return {
    id: row.id as string,
    userId: row.user_id as string,
    content: row.content as string,
    metadata,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

// Get children of a goal
function getChildren(db: Database.Database, parentId: string): GoalItem[] {
  const relations = db.prepare(
    'SELECT source_id FROM memory_relations WHERE target_id = ? AND relation_type = ?'
  ).all(parentId, 'EXTENDS') as Array<{ source_id: string }>;

  const children: GoalItem[] = [];
  for (const rel of relations) {
    const child = getGoal(db, rel.source_id);
    if (child) {
      children.push(child);
    }
  }
  return children;
}

// Calculate progress
function calculateProgress(db: Database.Database, id: string): number {
  const item = getGoal(db, id);
  if (!item) return 0;

  if (item.metadata.status === 'completed') return 100;

  const children = getChildren(db, id);
  if (children.length === 0) {
    // No children and not completed (already checked above), so 0%
    return 0;
  }

  const completedCount = children.filter(c => c.metadata.status === 'completed').length;
  return Math.round((completedCount / children.length) * 100);
}

// Update progress for item and parents
function updateProgress(db: Database.Database, id: string): void {
  const item = getGoal(db, id);
  if (!item) return;

  const progress = calculateProgress(db, id);
  const newMetadata = { ...item.metadata, progress };

  db.prepare('UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(newMetadata), Date.now(), id);
}

// Schedule check-in
function scheduleCheckin(db: Database.Database, goal: GoalItem): void {
  if (!goal.metadata.checkinFrequency) {
    return;
  }

  const description = `Goal check-in: ${goal.content}`;

  // Check for existing trigger
  const existing = db.prepare(`
    SELECT COUNT(*) as count FROM proactive_triggers
    WHERE user_id = ? AND status = 'pending' AND description = ?
  `).get(goal.userId, description) as { count: number };

  if (existing.count > 0) return;

  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  let triggerAt: number;

  switch (goal.metadata.checkinFrequency) {
    case 'daily':
      triggerAt = now + MS_PER_DAY;
      break;
    case 'weekly':
      triggerAt = now + 7 * MS_PER_DAY;
      break;
    case 'biweekly':
      triggerAt = now + 14 * MS_PER_DAY;
      break;
    case 'monthly':
      triggerAt = now + 30 * MS_PER_DAY;
      break;
    default:
      triggerAt = now + 7 * MS_PER_DAY;
  }

  db.prepare(`
    INSERT INTO proactive_triggers (id, user_id, type, description, context, trigger_at, status, source_memory_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    goal.userId,
    'goal_checkin',
    description,
    JSON.stringify({ goalId: goal.id, goalTitle: goal.content, progress: goal.metadata.progress ?? 0 }),
    triggerAt,
    'pending',
    goal.id,
    now,
    now
  );
}

// Format goal for display
function formatGoal(goal: GoalItem, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const status = goal.metadata.status === 'completed' ? '[x]' : '[ ]';
  let line = `${prefix}${status} ${goal.content} (${goal.id})`;

  if (goal.metadata.progress !== undefined && goal.metadata.goalType !== 'task') {
    line += ` - ${goal.metadata.progress}%`;
  }
  if (goal.metadata.dueDate) {
    const date = new Date(goal.metadata.dueDate).toLocaleDateString();
    const isOverdue = goal.metadata.dueDate < Date.now() && goal.metadata.status !== 'completed';
    line += ` | Due: ${date}${isOverdue ? ' (OVERDUE)' : ''}`;
  }
  if (goal.metadata.tags && goal.metadata.tags.length > 0) {
    line += ` [${goal.metadata.tags.join(', ')}]`;
  }

  return line;
}

// Format goal tree
function formatGoalTree(db: Database.Database, goalId: string): string {
  const goal = getGoal(db, goalId);
  if (!goal) return 'Goal not found';

  const lines: string[] = [formatGoal(goal, 0)];

  const milestones = getChildren(db, goalId).filter(c => c.metadata.goalType === 'milestone');
  for (const milestone of milestones) {
    lines.push(formatGoal(milestone, 1));

    const tasks = getChildren(db, milestone.id).filter(c => c.metadata.goalType === 'task');
    for (const task of tasks) {
      lines.push(formatGoal(task, 2));
    }
  }

  return lines.join('\n');
}

// Actions

function createItem(db: Database.Database, args: GoalArgs): SkillResult {
  const userId = process.env.SKILL_USER_ID || 'default';

  if (!args.type) {
    return { success: false, output: '', error: 'Missing required parameter: type', exitCode: 1 };
  }
  if (!args.title) {
    return { success: false, output: '', error: 'Missing required parameter: title', exitCode: 1 };
  }

  // For milestones and tasks, require parent_id
  if ((args.type === 'milestone' || args.type === 'task') && !args.parent_id) {
    return { success: false, output: '', error: `Missing required parameter: parent_id for ${args.type}`, exitCode: 1 };
  }

  // Validate parent exists and is correct type
  if (args.parent_id) {
    const parent = getGoal(db, args.parent_id);
    if (!parent) {
      return { success: false, output: '', error: `Parent ${args.parent_id} not found`, exitCode: 1 };
    }
    if (args.type === 'milestone' && parent.metadata.goalType !== 'goal') {
      return { success: false, output: '', error: 'Milestones can only be added to goals', exitCode: 1 };
    }
    if (args.type === 'task' && parent.metadata.goalType !== 'milestone') {
      return { success: false, output: '', error: 'Tasks can only be added to milestones', exitCode: 1 };
    }
  }

  const now = Date.now();
  const id = nanoid();
  const dueDate = args.due ? parseDueDate(args.due) : null;

  const metadata: GoalMetadata = {
    goalType: args.type,
    status: (args.status as 'backlog' | 'active' | 'completed') || 'backlog',
    parentId: args.parent_id,
    dueDate: dueDate ?? undefined,
    progress: args.type === 'task' ? undefined : 0,
    checkinFrequency: args.type === 'goal' && args.checkin && args.checkin !== 'none' ? args.checkin : undefined,
    tags: args.tags,
  };

  const importance = args.type === 'goal' ? 8 : args.type === 'milestone' ? 7 : 6;

  db.prepare(`
    INSERT INTO memories (id, user_id, content, category, memory_type, importance, confidence, is_latest,
      document_date, event_date, prominence, access_count, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, args.title, 'insight', 'regular', importance, 1.0, 1,
    now, dueDate, 1.0, 0, JSON.stringify(metadata), now, now
  );

  // Create parent relation
  if (args.parent_id) {
    db.prepare(`
      INSERT INTO memory_relations (id, source_id, target_id, relation_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(nanoid(), id, args.parent_id, 'EXTENDS', 1.0, now);

    // Update parent progress
    updateProgress(db, args.parent_id);

    // If milestone, also update goal progress
    const parent = getGoal(db, args.parent_id);
    if (parent?.metadata.parentId) {
      updateProgress(db, parent.metadata.parentId);
    }
  }

  // Schedule check-in for new active goals
  if (args.type === 'goal' && metadata.status === 'active' && metadata.checkinFrequency) {
    const goal = getGoal(db, id)!;
    scheduleCheckin(db, goal);
  }

  const typeLabel = args.type.charAt(0).toUpperCase() + args.type.slice(1);
  return {
    success: true,
    output: `${typeLabel} created: "${args.title}" (ID: ${id})`,
    exitCode: 0,
  };
}

function listItems(db: Database.Database, args: GoalArgs): SkillResult {
  const userId = process.env.SKILL_USER_ID || 'default';

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE user_id = ? AND category = 'insight' AND is_latest = 1
    ORDER BY prominence DESC, document_date DESC
  `).all(userId) as Record<string, unknown>[];

  let items = rows
    .map(row => {
      const metadata = row.metadata ? JSON.parse(row.metadata as string) : {};
      if (!metadata.goalType) return null;
      return {
        id: row.id as string,
        userId: row.user_id as string,
        content: row.content as string,
        metadata,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      } as GoalItem;
    })
    .filter((item): item is GoalItem => item !== null);

  // Apply filters
  if (args.type) {
    items = items.filter(i => i.metadata.goalType === args.type);
  }
  if (args.status) {
    items = items.filter(i => i.metadata.status === args.status);
  } else {
    // By default, exclude completed
    items = items.filter(i => i.metadata.status !== 'completed');
  }

  if (items.length === 0) {
    return {
      success: true,
      output: 'No items found matching the criteria.',
      exitCode: 0,
    };
  }

  const lines = items.map(item => formatGoal(item, 0));
  return {
    success: true,
    output: lines.join('\n'),
    exitCode: 0,
  };
}

function showItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  if (item.metadata.goalType === 'goal') {
    const tree = formatGoalTree(db, args.id);
    return { success: true, output: tree, exitCode: 0 };
  }

  return { success: true, output: formatGoal(item, 0), exitCode: 0 };
}

function activateItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  const newMetadata = { ...item.metadata, status: 'active' as const };
  db.prepare('UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(newMetadata), Date.now(), args.id);

  // Schedule check-in for goals
  if (item.metadata.goalType === 'goal' && item.metadata.checkinFrequency) {
    const updatedGoal = getGoal(db, args.id)!;
    scheduleCheckin(db, updatedGoal);
  }

  return {
    success: true,
    output: `Activated: "${item.content}"`,
    exitCode: 0,
  };
}

function completeItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  const now = Date.now();
  const newMetadata = { ...item.metadata, status: 'completed' as const, completedAt: now };
  db.prepare('UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(newMetadata), now, args.id);

  // Update parent progress
  if (item.metadata.parentId) {
    updateProgress(db, item.metadata.parentId);

    const parent = getGoal(db, item.metadata.parentId);
    if (parent?.metadata.parentId) {
      updateProgress(db, parent.metadata.parentId);
    }
  }

  return {
    success: true,
    output: `Completed: "${item.content}"`,
    exitCode: 0,
  };
}

function reopenItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  const newMetadata = { ...item.metadata, status: 'active' as const, completedAt: undefined };
  db.prepare('UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(newMetadata), Date.now(), args.id);

  // Update parent progress
  if (item.metadata.parentId) {
    updateProgress(db, item.metadata.parentId);

    const parent = getGoal(db, item.metadata.parentId);
    if (parent?.metadata.parentId) {
      updateProgress(db, parent.metadata.parentId);
    }
  }

  return {
    success: true,
    output: `Reopened: "${item.content}"`,
    exitCode: 0,
  };
}

function updateItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  const now = Date.now();
  const updates: string[] = [];

  let content = item.content;
  if (args.title) {
    content = args.title;
    updates.push(`title: "${args.title}"`);
  }

  const newMetadata = { ...item.metadata };
  if (args.status) {
    newMetadata.status = args.status;
    if (args.status === 'completed') {
      newMetadata.completedAt = now;
    }
    updates.push(`status: ${args.status}`);
  }
  if (args.due) {
    const dueDate = parseDueDate(args.due);
    if (dueDate) {
      newMetadata.dueDate = dueDate;
      updates.push(`due: ${new Date(dueDate).toLocaleDateString()}`);
    }
  }
  if (args.checkin !== undefined) {
    if (args.checkin === 'none') {
      delete newMetadata.checkinFrequency;
    } else {
      newMetadata.checkinFrequency = args.checkin;
    }
    updates.push(`check-in: ${args.checkin}`);
  }
  if (args.tags) {
    newMetadata.tags = args.tags;
    updates.push(`tags: [${args.tags.join(', ')}]`);
  }

  db.prepare('UPDATE memories SET content = ?, metadata = ?, updated_at = ? WHERE id = ?')
    .run(content, JSON.stringify(newMetadata), now, args.id);

  return {
    success: true,
    output: `Updated "${item.content}": ${updates.join(', ')}`,
    exitCode: 0,
  };
}

function deleteItem(db: Database.Database, args: GoalArgs): SkillResult {
  if (!args.id) {
    return { success: false, output: '', error: 'Missing required parameter: id', exitCode: 1 };
  }

  const item = getGoal(db, args.id);
  if (!item) {
    return { success: false, output: '', error: `Item ${args.id} not found`, exitCode: 1 };
  }

  // Delete children first
  const children = getChildren(db, args.id);
  for (const child of children) {
    deleteItem(db, { action: 'delete', id: child.id });
  }

  // Delete relations
  db.prepare('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(args.id, args.id);

  // Delete the item
  db.prepare('DELETE FROM memories WHERE id = ?').run(args.id);

  // Update parent progress
  if (item.metadata.parentId) {
    updateProgress(db, item.metadata.parentId);

    const parent = getGoal(db, item.metadata.parentId);
    if (parent?.metadata.parentId) {
      updateProgress(db, parent.metadata.parentId);
    }
  }

  return {
    success: true,
    output: `Deleted: "${item.content}" and ${children.length} child item(s)`,
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

  let args: GoalArgs;
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
      error: 'Missing required parameter: action',
      exitCode: 1,
    });
    return;
  }

  // Open database
  const dbPath = getDbPath();
  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to open database: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  let result: SkillResult;
  try {
    switch (args.action) {
      case 'create':
        result = createItem(db, args);
        break;
      case 'list':
        result = listItems(db, args);
        break;
      case 'show':
        result = showItem(db, args);
        break;
      case 'activate':
        result = activateItem(db, args);
        break;
      case 'complete':
        result = completeItem(db, args);
        break;
      case 'reopen':
        result = reopenItem(db, args);
        break;
      case 'update':
        result = updateItem(db, args);
        break;
      case 'delete':
        result = deleteItem(db, args);
        break;
      default:
        result = {
          success: false,
          output: '',
          error: `Unknown action: ${args.action}`,
          exitCode: 1,
        };
    }
  } finally {
    db.close();
  }

  outputResult(result);
}

main();
