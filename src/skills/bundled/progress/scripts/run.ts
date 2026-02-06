/**
 * Progress Skill Execution Script
 *
 * Shows progress summary for goals.
 */

import * as path from 'path';
import Database from 'better-sqlite3';

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

interface ProgressArgs {
  goal_id?: string;
  verbose?: boolean;
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

// Get all active goals for user
function getActiveGoals(db: Database.Database, userId: string): GoalItem[] {
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE user_id = ? AND category = 'insight' AND is_latest = 1
    ORDER BY prominence DESC, document_date DESC
  `).all(userId) as Record<string, unknown>[];

  return rows
    .map(row => {
      const metadata = row.metadata ? JSON.parse(row.metadata as string) : {};
      if (!metadata.goalType || metadata.goalType !== 'goal' || metadata.status !== 'active') {
        return null;
      }
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
}

// Create progress bar
function progressBar(percent: number, width: number = 16): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

// Format date
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Get goal stats
function getGoalStats(db: Database.Database, goalId: string): {
  totalMilestones: number;
  completedMilestones: number;
  totalTasks: number;
  completedTasks: number;
} {
  const milestones = getChildren(db, goalId).filter(c => c.metadata.goalType === 'milestone');

  let totalTasks = 0;
  let completedTasks = 0;
  let completedMilestones = 0;

  for (const milestone of milestones) {
    if (milestone.metadata.status === 'completed') {
      completedMilestones++;
    }

    const tasks = getChildren(db, milestone.id).filter(c => c.metadata.goalType === 'task');
    totalTasks += tasks.length;
    completedTasks += tasks.filter(t => t.metadata.status === 'completed').length;
  }

  return {
    totalMilestones: milestones.length,
    completedMilestones,
    totalTasks,
    completedTasks,
  };
}

// Format verbose goal tree
function formatVerboseGoal(db: Database.Database, goal: GoalItem): string {
  const lines: string[] = [];
  const progress = goal.metadata.progress ?? 0;

  lines.push(`${goal.content} [${progress}%]`);

  const milestones = getChildren(db, goal.id).filter(c => c.metadata.goalType === 'milestone');
  for (const milestone of milestones) {
    const mStatus = milestone.metadata.status === 'completed' ? '[x]' : '[ ]';
    const mProgress = milestone.metadata.progress ?? 0;
    lines.push(`  ${mStatus} ${milestone.content} (${mProgress}%)`);

    const tasks = getChildren(db, milestone.id).filter(c => c.metadata.goalType === 'task');
    for (const task of tasks) {
      const tStatus = task.metadata.status === 'completed' ? '[x]' : '[ ]';
      lines.push(`      ${tStatus} ${task.content}`);
    }
  }

  return lines.join('\n');
}

// Main
function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;

  let args: ProgressArgs = {};
  if (skillArgsJson) {
    try {
      args = JSON.parse(skillArgsJson);
    } catch {
      // Use empty args
    }
  }

  const userId = process.env.SKILL_USER_ID || 'default';

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

  try {
    // Single goal view
    if (args.goal_id) {
      const goal = getGoal(db, args.goal_id);
      if (!goal) {
        outputResult({
          success: false,
          output: '',
          error: `Goal ${args.goal_id} not found`,
          exitCode: 1,
        });
        return;
      }

      const output = formatVerboseGoal(db, goal);
      outputResult({ success: true, output, exitCode: 0 });
      return;
    }

    // All active goals
    const activeGoals = getActiveGoals(db, userId);

    if (activeGoals.length === 0) {
      outputResult({
        success: true,
        output: 'No active goals. Create one with the goals skill!',
        exitCode: 0,
      });
      return;
    }

    const now = Date.now();
    const lines: string[] = ['GOAL PROGRESS SUMMARY', ''];
    const overdueGoals: GoalItem[] = [];

    for (const goal of activeGoals) {
      const progress = goal.metadata.progress ?? 0;
      const stats = getGoalStats(db, goal.id);
      const isOverdue = goal.metadata.dueDate && goal.metadata.dueDate < now;

      if (isOverdue) {
        overdueGoals.push(goal);
      }

      if (args.verbose) {
        lines.push(formatVerboseGoal(db, goal));
        lines.push('');
      } else {
        let line = `${goal.content} [${progress}%] ${progressBar(progress)}`;
        if (goal.metadata.dueDate) {
          line += ` Due: ${formatDate(goal.metadata.dueDate)}`;
        }
        if (isOverdue) {
          line += ' OVERDUE';
        }
        lines.push(line);
        lines.push(`  ${stats.completedMilestones}/${stats.totalMilestones} milestones | ${stats.completedTasks}/${stats.totalTasks} tasks`);
        lines.push('');
      }
    }

    if (overdueGoals.length > 0) {
      lines.push(`\u26A0\uFE0F ${overdueGoals.length} overdue goal(s)`);
    } else {
      lines.push('No overdue goals.');
    }

    outputResult({
      success: true,
      output: lines.join('\n'),
      exitCode: 0,
    });
  } finally {
    db.close();
  }
}

main();
