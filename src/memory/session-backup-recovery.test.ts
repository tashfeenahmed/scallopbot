import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ScallopDatabase } from './db.js';
import { recoverSessionFromBackup } from './session-backup-recovery.js';

describe('lossless session backup recovery', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('requires exact confirmation and restores an archived checksum-matched transcript idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-recovery-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'backup.db');
    const targetPath = join(dir, 'target.db');
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, metadata TEXT, input_tokens INTEGER, output_tokens INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE session_summaries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
        summary TEXT NOT NULL, topics TEXT, message_count INTEGER, duration_ms INTEGER,
        embedding TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES (
        'lost-session', '{"userId":"telegram:owner","channelId":"telegram"}',
        10, 4, 1000, 2000
      );
      INSERT INTO session_messages VALUES (41, 'lost-session', 'user', 'literal question', 1100);
      INSERT INTO session_messages VALUES (42, 'lost-session', 'assistant', 'literal answer', 1200);
      INSERT INTO session_summaries VALUES (
        'lost-summary', 'lost-session', 'default', 'A legacy summary that remains recoverable.',
        '["recovery"]', 2, 100, NULL, 1300
      );
    `);
    source.close();
    const emptyTarget = new ScallopDatabase(targetPath);
    emptyTarget.close();
    const unrelatedTargetState = new Database(targetPath);
    unrelatedTargetState.prepare(`
      INSERT INTO llm_traces (ts, purpose, model, provider, prompt, response, parsed_ok)
      VALUES (1, 'test', 'test-model', 'test-provider', 'unrelated', 'unrelated', 1)
    `).run();
    unrelatedTargetState.prepare(`
      INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
      VALUES ('another-user', 1, 'test', 'skip', 'unrelated', NULL)
    `).run();
    unrelatedTargetState.close();

    expect(() => recoverSessionFromBackup({
      targetPath, backupPath: sourcePath, sessionId: 'lost-session', confirmedSessionId: 'wrong',
    })).toThrow(/Exact session ID confirmation/);

    const first = recoverSessionFromBackup({
      targetPath, backupPath: sourcePath, sessionId: 'lost-session',
      confirmedSessionId: 'lost-session', now: 5000,
    });
    expect(first).toMatchObject({
      messagesRecovered: 2, summaryRecovered: true, alreadyPresent: false,
    });
    expect(first.targetChecksum).toBe(first.sourceChecksum);

    const db = new ScallopDatabase(targetPath, { runRetentionMaintenance: false });
    expect(db.getActiveSession('lost-session')).toBeNull();
    expect(db.getSessionMessages('lost-session').map(row => row.messageKind))
      .toEqual(['human_user', 'assistant_final']);
    expect(db.getSessionSummary('lost-session')).toMatchObject({
      schemaValid: false, verifiedAt: null, verifier: 'backup_recovery',
    });
    expect(db.getSessionLifecycleEvents('lost-session')).toEqual([
      expect.objectContaining({ action: 'archived', messageCount: 2 }),
    ]);
    expect(db.raw<{ count: number }>('SELECT COUNT(*) AS count FROM llm_traces')[0]?.count).toBe(1);
    expect(db.raw<{ count: number }>('SELECT COUNT(*) AS count FROM proactive_decisions')[0]?.count)
      .toBe(1);
    db.close();

    expect(recoverSessionFromBackup({
      targetPath, backupPath: sourcePath, sessionId: 'lost-session',
      confirmedSessionId: 'lost-session', now: 6000,
    })).toMatchObject({ alreadyPresent: true, messagesRecovered: 2 });

    const active = new Database(targetPath);
    active.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run('lost-session');
    active.close();
    expect(() => recoverSessionFromBackup({
      targetPath, backupPath: sourcePath, sessionId: 'lost-session',
      confirmedSessionId: 'lost-session', now: 7000,
    })).toThrow(/active session/);

    const tamperedTargetPath = join(dir, 'tampered-target.db');
    const tamperedTarget = new ScallopDatabase(tamperedTargetPath);
    tamperedTarget.close();
    const triggerDb = new Database(tamperedTargetPath);
    triggerDb.exec(`
      CREATE TRIGGER mutate_recovery AFTER INSERT ON session_messages
      BEGIN
        UPDATE session_messages SET content = content || '-mutated' WHERE id = NEW.id;
      END;
    `);
    triggerDb.close();
    expect(() => recoverSessionFromBackup({
      targetPath: tamperedTargetPath,
      backupPath: sourcePath,
      sessionId: 'lost-session',
      confirmedSessionId: 'lost-session',
      now: 8000,
    })).toThrow(/checksum/);
    const rolledBack = new Database(tamperedTargetPath, { readonly: true });
    expect(rolledBack.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?')
      .get('lost-session')).toEqual({ count: 0 });
    expect(rolledBack.prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
      .get('lost-session')).toEqual({ count: 0 });
    expect(rolledBack.prepare('SELECT COUNT(*) AS count FROM session_summaries WHERE session_id = ?')
      .get('lost-session')).toEqual({ count: 0 });
    rolledBack.close();
  });

  it('rejects a hard-linked target before opening either database for recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-recovery-same-file-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'source.db');
    const targetPath = join(dir, 'same-inode.db');
    const source = new Database(sourcePath);
    source.exec('CREATE TABLE placeholder (id INTEGER)');
    source.close();
    linkSync(sourcePath, targetPath);

    expect(() => recoverSessionFromBackup({
      targetPath,
      backupPath: sourcePath,
      sessionId: 'lost-session',
      confirmedSessionId: 'lost-session',
    })).toThrow(/different files/);
  });

  it('applies additive target migrations before restoring into a pre-release database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-recovery-migration-'));
    dirs.push(dir);
    const sourcePath = join(dir, 'backup.db');
    const targetPath = join(dir, 'legacy-target.db');
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, metadata TEXT, input_tokens INTEGER, output_tokens INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE session_summaries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('legacy-lost', NULL, 1, 1, 100, 200);
      INSERT INTO session_messages VALUES (7, 'legacy-lost', 'user', 'restore me', 150);
    `);
    source.close();

    // A valid SQLite file with none of the hardening schema simulates a bot
    // stopped immediately before upgrading to this release.
    new Database(targetPath).close();
    const result = recoverSessionFromBackup({
      targetPath,
      backupPath: sourcePath,
      sessionId: 'legacy-lost',
      confirmedSessionId: 'legacy-lost',
      now: 9000,
    });
    expect(result).toMatchObject({ messagesRecovered: 1, alreadyPresent: false });

    const migrated = new Database(targetPath, { readonly: true });
    expect(migrated.prepare('SELECT archived_at, archive_reason FROM sessions WHERE id = ?')
      .get('legacy-lost')).toEqual({ archived_at: 9000, archive_reason: 'recovered_from_backup' });
    expect(migrated.prepare('SELECT message_kind FROM session_messages WHERE id = 7').get())
      .toEqual({ message_kind: 'human_user' });
    migrated.close();
  });
});
