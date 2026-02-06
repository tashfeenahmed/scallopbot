#!/usr/bin/env npx tsx
/**
 * Migration Script: Unify Triggers and Reminders
 *
 * This script migrates existing data to the new scheduled_items table:
 * 1. Migrates proactive_triggers (agent-set) to scheduled_items with source='agent'
 * 2. Migrates reminders.json (user-set) to scheduled_items with source='user'
 *
 * Run: npx tsx scripts/migrate-to-unified-scheduler.ts
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { nanoid } from 'nanoid';

// Get database path
function getDbPath(): string {
  const dataDir = process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot');
  return path.join(dataDir, 'memories.db');
}

// Get reminders file path
function getRemindersPath(): string {
  const dataDir = process.env.SCALLOPBOT_DATA_DIR || path.join(os.homedir(), '.scallopbot');
  return path.join(dataDir, 'reminders.json');
}

interface ProactiveTrigger {
  id: string;
  user_id: string;
  type: string;
  description: string;
  context: string;
  trigger_at: number;
  status: string;
  fired_at: number | null;
  source_memory_id: string | null;
  created_at: number;
}

interface FileReminder {
  id: string;
  message: string;
  triggerAt: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  recurring?: {
    type: 'daily' | 'weekly' | 'weekdays' | 'weekends';
    time: { hour: number; minute: number };
    dayOfWeek?: number;
  };
}

async function migrate() {
  const dbPath = getDbPath();
  const remindersPath = getRemindersPath();

  console.log('Migration: Unify Triggers and Reminders');
  console.log('========================================');
  console.log(`Database: ${dbPath}`);
  console.log(`Reminders file: ${remindersPath}`);
  console.log('');

  // Open database
  const db = new Database(dbPath);

  // Ensure the scheduled_items table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT,
      trigger_at INTEGER NOT NULL,
      recurring TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      fired_at INTEGER,
      source_memory_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_items_user_status ON scheduled_items(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_items_trigger_at ON scheduled_items(trigger_at);
  `);

  console.log('1. Migrating proactive_triggers to scheduled_items...');

  // Check if proactive_triggers table exists
  const tableCheck = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_triggers'
  `).get() as { name: string } | undefined;

  let triggersMigrated = 0;
  let triggersSkipped = 0;

  if (tableCheck) {
    // Get all pending triggers
    const triggers = db.prepare(`
      SELECT * FROM proactive_triggers WHERE status = 'pending'
    `).all() as ProactiveTrigger[];

    console.log(`   Found ${triggers.length} pending triggers`);

    for (const trigger of triggers) {
      // Check if already migrated
      const existing = db.prepare(`
        SELECT id FROM scheduled_items WHERE id = ?
      `).get(trigger.id) as { id: string } | undefined;

      if (existing) {
        triggersSkipped++;
        continue;
      }

      // Insert into scheduled_items
      db.prepare(`
        INSERT INTO scheduled_items (
          id, user_id, session_id, source, type, message, context,
          trigger_at, recurring, status, fired_at, source_memory_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trigger.id,
        trigger.user_id,
        null, // session_id not in old schema
        'agent',
        trigger.type,
        trigger.description, // description becomes message
        trigger.context,
        trigger.trigger_at,
        null, // no recurring in old triggers
        trigger.status,
        trigger.fired_at,
        trigger.source_memory_id,
        trigger.created_at,
        Date.now()
      );

      triggersMigrated++;
    }

    console.log(`   Migrated: ${triggersMigrated}, Skipped (already exists): ${triggersSkipped}`);
  } else {
    console.log('   No proactive_triggers table found, skipping...');
  }

  console.log('');
  console.log('2. Migrating reminders.json to scheduled_items...');

  let remindersMigrated = 0;
  let remindersSkipped = 0;

  if (fs.existsSync(remindersPath)) {
    try {
      const data = fs.readFileSync(remindersPath, 'utf-8');
      const reminders = JSON.parse(data) as FileReminder[];

      console.log(`   Found ${reminders.length} reminders in file`);

      for (const reminder of reminders) {
        // Check if already migrated (use a prefix to avoid ID collision)
        const migratedId = `rem_${reminder.id}`;
        const existing = db.prepare(`
          SELECT id FROM scheduled_items WHERE id = ? OR id = ?
        `).get(migratedId, reminder.id) as { id: string } | undefined;

        if (existing) {
          remindersSkipped++;
          continue;
        }

        // Convert recurring schedule to new format
        let recurring: string | null = null;
        if (reminder.recurring) {
          recurring = JSON.stringify({
            type: reminder.recurring.type,
            hour: reminder.recurring.time.hour,
            minute: reminder.recurring.time.minute,
            dayOfWeek: reminder.recurring.dayOfWeek,
          });
        }

        // Insert into scheduled_items
        db.prepare(`
          INSERT INTO scheduled_items (
            id, user_id, session_id, source, type, message, context,
            trigger_at, recurring, status, fired_at, source_memory_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reminder.id,
          reminder.userId,
          reminder.sessionId,
          'user',
          'reminder',
          reminder.message,
          null, // no context in old reminders
          new Date(reminder.triggerAt).getTime(),
          recurring,
          'pending',
          null,
          null,
          new Date(reminder.createdAt).getTime(),
          Date.now()
        );

        remindersMigrated++;
      }

      console.log(`   Migrated: ${remindersMigrated}, Skipped (already exists): ${remindersSkipped}`);

      // Backup and remove the old file
      if (remindersMigrated > 0) {
        const backupPath = remindersPath + '.backup.' + Date.now();
        fs.renameSync(remindersPath, backupPath);
        console.log(`   Backed up reminders.json to: ${backupPath}`);
      }
    } catch (err) {
      console.error(`   Error reading reminders file: ${(err as Error).message}`);
    }
  } else {
    console.log('   No reminders.json file found, skipping...');
  }

  // Show final stats
  console.log('');
  console.log('Migration complete!');
  console.log('==================');

  const stats = db.prepare(`
    SELECT
      source,
      status,
      COUNT(*) as count
    FROM scheduled_items
    GROUP BY source, status
  `).all() as { source: string; status: string; count: number }[];

  console.log('');
  console.log('Scheduled items in database:');
  for (const stat of stats) {
    console.log(`   ${stat.source} / ${stat.status}: ${stat.count}`);
  }

  db.close();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
