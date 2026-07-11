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
  kind: string;
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

// Stateful bundled skills use the canonical storage identity while preserving
// SKILL_USER_ID for channel-specific communication and integrations.
const USER_ID = process.env.SKILL_STATE_USER_ID || process.env.SKILL_USER_ID || 'default';

function findDatabasePath(): string {
  // Check common locations
  const possiblePaths = [
    // MEMORY_DB_PATH decouples the DB from the workspace — honor it first.
    process.env.MEMORY_DB_PATH || '',
    path.join(process.cwd(), 'memories.db'),
    path.join(process.env.HOME || '', '.scallopbot', 'memories.db'),
  ].filter(Boolean);

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

function listTriggers(db: Database.Database, userId: string): string {
  const stmt = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE user_id = ? AND source = 'agent' AND status = 'pending'
    ORDER BY trigger_at ASC
  `);

  const triggers = stmt.all(userId) as TriggerEntry[];

  if (triggers.length === 0) {
    return 'No pending automatic triggers.\n\nAutomatic triggers are created when you mention events, commitments, or goals in conversation.';
  }

  const lines = ['**Pending automatic triggers:**\n'];

  for (const trigger of triggers) {
    const timeStr = formatTriggerTime(trigger.trigger_at);
    const shortId = trigger.id.substring(0, 8);
    const sourceTag = trigger.source === 'user' ? 'reminder' : trigger.type;
    const kindTag = (trigger.kind === 'task') ? ' [task]' : (trigger.kind === 'nudge' ? ' [nudge]' : '');
    lines.push(`- [${shortId}] **${trigger.message}** (${sourceTag}${kindTag})`);
    lines.push(`  Triggers: ${timeStr}`);
  }

  lines.push(`\n*To cancel an item, use: cancel with trigger_id*`);

  return lines.join('\n');
}

function cancelTrigger(db: Database.Database, userId: string, triggerId: string): string {
  // Support partial IDs only when they identify one owned automatic trigger.
  const stmt = db.prepare(`
    SELECT * FROM scheduled_items
    WHERE user_id = ? AND source = 'agent' AND status = 'pending'
      AND (id = ? OR substr(id, 1, length(?)) = ?)
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
    LIMIT 2
  `);

  const matches = stmt.all(userId, triggerId, triggerId, triggerId, triggerId) as TriggerEntry[];
  const trigger = matches[0];

  if (!trigger) {
    return `No pending trigger found matching ID "${triggerId}".`;
  }
  if (trigger.id !== triggerId && matches.length > 1) {
    return `Trigger ID "${triggerId}" is ambiguous. Use a longer ID from the list.`;
  }

  const dismissStmt = db.prepare(`
    UPDATE scheduled_items
    SET status = 'dismissed', board_status = 'archived', updated_at = ?
    WHERE id = ? AND user_id = ? AND source = 'agent' AND status = 'pending'
  `);
  const result = dismissStmt.run(Date.now(), trigger.id, userId);

  if (result.changes > 0) {
    return `Cancelled: "${trigger.message}"`;
  } else {
    return `Failed to cancel trigger "${triggerId}".`;
  }
}

function cancelAllTriggers(db: Database.Database, userId: string): string {
  const dismissStmt = db.prepare(`
    UPDATE scheduled_items
    SET status = 'dismissed', board_status = 'archived', updated_at = ?
    WHERE user_id = ? AND source = 'agent' AND status = 'pending'
  `);
  const result = dismissStmt.run(Date.now(), userId);

  return result.changes === 0
    ? 'No pending automatic triggers to cancel.'
    : `Cancelled ${result.changes} pending automatic trigger(s).`;
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
        output = listTriggers(db, USER_ID);
        break;

      case 'cancel':
        if (!args.trigger_id) {
          output = 'Please provide a trigger_id to cancel. Use action: list to see trigger IDs.';
        } else {
          output = cancelTrigger(db, USER_ID, args.trigger_id);
        }
        break;

      case 'cancel_all':
        output = cancelAllTriggers(db, USER_ID);
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
