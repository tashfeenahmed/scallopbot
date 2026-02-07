#!/usr/bin/env npx tsx
/**
 * Triggers Skill - Manage proactive triggers
 *
 * Lists and cancels proactive triggers (automatic follow-ups extracted from conversations).
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

interface TriggerEntry {
  id: string;
  user_id: string;
  session_id: string | null;
  source: string;
  type: string;
  message: string;
  context: string | null;
  trigger_at: number;
  recurring: string | null;
  status: string;
  source_memory_id: string | null;
  created_at: number;
  updated_at: number;
  fired_at: number | null;
}

interface SkillInput {
  action: 'list' | 'cancel' | 'cancel_all';
  trigger_id?: string;
}

function findDatabasePath(): string {
  // Check common locations
  const possiblePaths = [
    path.join(process.cwd(), 'memories.db'),
    path.join(process.env.HOME || '', '.scallopbot', 'memories.db'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error('Could not find memories.db');
}

function formatTriggerTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (date.toDateString() === now.toDateString()) {
    return `today at ${timeStr}`;
  } else if (date.toDateString() === tomorrow.toDateString()) {
    return `tomorrow at ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return `${dateStr} at ${timeStr}`;
  }
}

function listTriggers(db: Database.Database): string {
  const stmt = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE status = 'pending'
    ORDER BY trigger_at ASC
  `);

  const triggers = stmt.all() as TriggerEntry[];

  if (triggers.length === 0) {
    return 'No pending scheduled items.\n\nScheduled items are created when you set reminders or mention events, commitments, or goals in conversation.';
  }

  const lines = ['**Pending scheduled items:**\n'];

  for (const trigger of triggers) {
    const timeStr = formatTriggerTime(trigger.trigger_at);
    const shortId = trigger.id.substring(0, 8);
    const sourceTag = trigger.source === 'user' ? 'reminder' : trigger.type;
    lines.push(`- [${shortId}] **${trigger.message}** (${sourceTag})`);
    lines.push(`  Triggers: ${timeStr}`);
  }

  lines.push(`\n*To cancel an item, use: cancel with trigger_id*`);

  return lines.join('\n');
}

function cancelTrigger(db: Database.Database, triggerId: string): string {
  // Support partial ID matching
  const stmt = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE id LIKE ? AND status = 'pending'
    LIMIT 1
  `);

  const trigger = stmt.get(`${triggerId}%`) as TriggerEntry | undefined;

  if (!trigger) {
    return `No pending trigger found matching ID "${triggerId}".`;
  }

  const deleteStmt = db.prepare('DELETE FROM scheduled_items WHERE id = ?');
  const result = deleteStmt.run(trigger.id);

  if (result.changes > 0) {
    return `Cancelled: "${trigger.message}"`;
  } else {
    return `Failed to cancel trigger "${triggerId}".`;
  }
}

function cancelAllTriggers(db: Database.Database): string {
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM scheduled_items WHERE status = 'pending'`);
  const { count } = countStmt.get() as { count: number };

  if (count === 0) {
    return 'No pending items to cancel.';
  }

  const deleteStmt = db.prepare(`DELETE FROM scheduled_items WHERE status = 'pending'`);
  const result = deleteStmt.run();

  return `Cancelled ${result.changes} pending item(s).`;
}

async function main() {
  try {
    const argsEnv = process.env.SKILL_ARGS;
    if (!argsEnv) {
      console.log(JSON.stringify({
        success: false,
        output: 'No arguments provided. Use action: list, cancel, or cancel_all',
        exitCode: 1,
      }));
      process.exit(1);
    }

    const args: SkillInput = JSON.parse(argsEnv);
    const dbPath = findDatabasePath();
    const db = new Database(dbPath);

    let output: string;

    switch (args.action) {
      case 'list':
        output = listTriggers(db);
        break;

      case 'cancel':
        if (!args.trigger_id) {
          output = 'Please provide a trigger_id to cancel. Use action: list to see trigger IDs.';
        } else {
          output = cancelTrigger(db, args.trigger_id);
        }
        break;

      case 'cancel_all':
        output = cancelAllTriggers(db);
        break;

      default:
        output = `Unknown action: ${args.action}. Use: list, cancel, or cancel_all`;
    }

    db.close();

    console.log(JSON.stringify({
      success: true,
      output,
      exitCode: 0,
    }));

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      output: `Error: ${(error as Error).message}`,
      exitCode: 1,
    }));
    process.exit(1);
  }
}

main();
