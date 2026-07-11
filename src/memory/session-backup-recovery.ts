import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ScallopDatabase } from './db.js';
import { inferSessionMessageKind } from './session-message-kinds.js';

interface BackupSessionRow {
  id: string;
  metadata: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
  updated_at: number;
}

interface BackupMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface SessionRecoveryResult {
  sessionId: string;
  messagesRecovered: number;
  summaryRecovered: boolean;
  sourceChecksum: string;
  targetChecksum: string;
  alreadyPresent: boolean;
}

function messageChecksum(messages: BackupMessageRow[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(JSON.stringify([
      message.id, message.session_id, message.role, message.content, message.created_at,
    ]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function assertDifferentFiles(targetPath: string, backupPath: string): void {
  const targetRealPath = realpathSync(targetPath);
  const backupRealPath = realpathSync(backupPath);
  const targetStat = statSync(targetRealPath);
  const backupStat = statSync(backupRealPath);
  if (targetRealPath === backupRealPath
    || (targetStat.dev === backupStat.dev && targetStat.ino === backupStat.ino)) {
    throw new Error('Target and backup databases must be different files');
  }
}

function requireColumns(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  label: string,
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => column.name),
  );
  const missing = columns.filter(column => !existing.has(column));
  if (missing.length > 0) {
    throw new Error(`${label} database is not recovery-compatible: ${table} missing ${missing.join(', ')}`);
  }
}

const SUMMARY_COMPARE_COLUMNS = [
  'id', 'session_id', 'user_id', 'summary', 'topics', 'message_count',
  'duration_ms', 'embedding', 'created_at',
] as const;

function summariesMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const normalized = (row: Record<string, unknown>, column: typeof SUMMARY_COMPARE_COLUMNS[number]) => {
    if (column === 'user_id') return row[column] ?? 'default';
    if (column === 'message_count' || column === 'duration_ms') return row[column] ?? 0;
    return row[column] ?? null;
  };
  return SUMMARY_COMPARE_COLUMNS.every(column => normalized(left, column) === normalized(right, column));
}

/**
 * Recover exactly one archived conversation from a SQLite backup. This is
 * deliberately opt-in, idempotent, content-silent, and checksum-verified.
 * It never makes the recovered session resumable and never marks a legacy
 * summary verified; the normal summarizer must regenerate/verify it first.
 */
export function recoverSessionFromBackup(input: {
  targetPath: string;
  backupPath: string;
  sessionId: string;
  confirmedSessionId: string;
  now?: number;
}): SessionRecoveryResult {
  if (!input.sessionId || input.confirmedSessionId !== input.sessionId) {
    throw new Error('Exact session ID confirmation is required for recovery');
  }
  assertDifferentFiles(input.targetPath, input.backupPath);

  // Recovery is also an operational entry point: production may still be on
  // the previous schema when the bot is stopped for restore. Apply the normal
  // additive migrations before requiring or writing any target columns.
  const migratedTarget = new ScallopDatabase(input.targetPath, {
    runRetentionMaintenance: false,
  });
  migratedTarget.close();

  const source = new Database(input.backupPath, { readonly: true, fileMustExist: true });
  const target = new Database(input.targetPath, { fileMustExist: true });
  target.pragma('foreign_keys = ON');
  try {
    requireColumns(
      source,
      'sessions',
      ['id', 'metadata', 'input_tokens', 'output_tokens', 'created_at', 'updated_at'],
      'Backup',
    );
    requireColumns(
      source,
      'session_messages',
      ['id', 'session_id', 'role', 'content', 'created_at'],
      'Backup',
    );
    requireColumns(
      source,
      'session_summaries',
      ['id', 'session_id', 'summary', 'created_at'],
      'Backup',
    );
    requireColumns(
      target,
      'sessions',
      ['id', 'archived_at', 'archive_reason', 'transcript_deleted_at'],
      'Target',
    );
    requireColumns(
      target,
      'session_messages',
      ['id', 'session_id', 'role', 'content', 'message_kind', 'created_at'],
      'Target',
    );
    requireColumns(
      target,
      'session_summaries',
      ['verified_at', 'verifier', 'verification_version', 'schema_valid'],
      'Target',
    );
    requireColumns(
      target,
      'session_summary_verification_events',
      ['summary_id', 'session_id', 'outcome', 'verifier', 'reason', 'checked_at'],
      'Target',
    );
    requireColumns(
      target,
      'session_lifecycle_events',
      ['session_id', 'action', 'reason', 'actor', 'message_count', 'created_at'],
      'Target',
    );
    const sourceSession = source.prepare('SELECT * FROM sessions WHERE id = ?')
      .get(input.sessionId) as BackupSessionRow | undefined;
    if (!sourceSession) throw new Error('Confirmed session does not exist in the backup');
    const sourceMessages = source.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM session_messages WHERE session_id = ? ORDER BY id
    `).all(input.sessionId) as BackupMessageRow[];
    if (sourceMessages.length === 0) throw new Error('Backup session has no messages to recover');
    const sourceChecksum = messageChecksum(sourceMessages);

    const sourceSummaries = source.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at, id',
    ).all(input.sessionId) as Record<string, unknown>[];
    const targetSummaries = target.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at, id',
    ).all(input.sessionId) as Record<string, unknown>[];
    for (const sourceSummary of sourceSummaries) {
      const collision = target.prepare('SELECT * FROM session_summaries WHERE id = ?')
        .get(sourceSummary.id) as Record<string, unknown> | undefined;
      if (collision && collision.session_id !== input.sessionId) {
        throw new Error('Backup summary ID collides with a different target session');
      }
    }
    const summariesAlreadyPresent = sourceSummaries.length === targetSummaries.length
      && sourceSummaries.every(sourceSummary => {
        const targetSummary = targetSummaries.find(row => row.id === sourceSummary.id);
        return !!targetSummary && summariesMatch(sourceSummary, targetSummary);
      });
    if ((targetSummaries.length > 0 || sourceSummaries.length === 0) && !summariesAlreadyPresent) {
      throw new Error('Target contains missing, extra, or different summary data for this session');
    }

    const existing = target.prepare(`
      SELECT archived_at, archive_reason, transcript_deleted_at
      FROM sessions WHERE id = ?
    `).get(input.sessionId) as {
      archived_at: number | null;
      archive_reason: string | null;
      transcript_deleted_at: number | null;
    } | undefined;
    if (existing) {
      const targetMessages = target.prepare(`
        SELECT id, session_id, role, content, created_at
        FROM session_messages WHERE session_id = ? ORDER BY id
      `).all(input.sessionId) as BackupMessageRow[];
      const targetChecksum = messageChecksum(targetMessages);
      if (targetMessages.length === sourceMessages.length && targetChecksum === sourceChecksum) {
        if (existing.transcript_deleted_at != null) {
          throw new Error('Refusing to treat an explicitly forgotten or pruned tombstone as recovered');
        }
        if (existing.archived_at == null) {
          throw new Error('Refusing to treat an active session as an idempotent archived recovery');
        }
        if (!summariesAlreadyPresent) {
          throw new Error('Recovered transcript exists but its backup summary set is incomplete');
        }
        return {
          sessionId: input.sessionId,
          messagesRecovered: sourceMessages.length,
          summaryRecovered: sourceSummaries.length > 0,
          sourceChecksum,
          targetChecksum,
          alreadyPresent: true,
        };
      }
      throw new Error(existing.transcript_deleted_at != null
        ? 'Refusing to overwrite an explicitly forgotten or pruned session tombstone'
        : 'Target already contains a different or partial session with this ID');
    }

    const recoveredAt = input.now ?? Date.now();
    const metadata = parseMetadata(sourceSession.metadata);
    const recover = target.transaction(() => {
      target.prepare(`
        INSERT INTO sessions (
          id, metadata, input_tokens, output_tokens, created_at, updated_at,
          archived_at, archive_reason, transcript_deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'recovered_from_backup', NULL)
      `).run(
        sourceSession.id,
        sourceSession.metadata,
        sourceSession.input_tokens,
        sourceSession.output_tokens,
        sourceSession.created_at,
        sourceSession.updated_at,
        recoveredAt,
      );

      const insertMessage = target.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, message_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const message of sourceMessages) {
        insertMessage.run(
          message.id,
          message.session_id,
          message.role,
          message.content,
          inferSessionMessageKind(message.role, message.content, metadata),
          message.created_at,
        );
      }

      const summaryRecovered = sourceSummaries.length > 0;
      if (!summariesAlreadyPresent) {
        const insertSummary = target.prepare(`
          INSERT INTO session_summaries (
            id, session_id, user_id, summary, topics, message_count, duration_ms,
            embedding, created_at, verified_at, verifier, verification_version, schema_valid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'backup_recovery', 1, 0)
        `);
        const insertVerification = target.prepare(`
          INSERT INTO session_summary_verification_events (
            summary_id, session_id, outcome, verifier, verification_version, reason, checked_at
          ) VALUES (?, ?, 'rejected', 'backup_recovery', 1, 'pending_regeneration', ?)
        `);
        for (const sourceSummary of sourceSummaries) {
          insertSummary.run(
            sourceSummary.id,
            sourceSummary.session_id,
            sourceSummary.user_id ?? 'default',
            sourceSummary.summary,
            sourceSummary.topics,
            sourceSummary.message_count ?? 0,
            sourceSummary.duration_ms ?? 0,
            sourceSummary.embedding ?? null,
            sourceSummary.created_at,
          );
          insertVerification.run(sourceSummary.id, input.sessionId, recoveredAt);
        }
      }

      const userId = typeof metadata?.userId === 'string' ? metadata.userId : null;
      target.prepare(`
        INSERT INTO session_lifecycle_events (
          session_id, user_id, action, reason, actor, message_count, created_at
        ) VALUES (?, ?, 'archived', 'recovered_from_backup', 'recovery_utility', ?, ?)
      `).run(input.sessionId, userId, sourceMessages.length, recoveredAt);
      const targetMessages = target.prepare(`
        SELECT id, session_id, role, content, created_at
        FROM session_messages WHERE session_id = ? ORDER BY id
      `).all(input.sessionId) as BackupMessageRow[];
      const targetChecksum = messageChecksum(targetMessages);
      if (targetMessages.length !== sourceMessages.length || targetChecksum !== sourceChecksum) {
        throw new Error('Recovery verification failed: target transcript checksum does not match backup');
      }
      return { summaryRecovered, targetChecksum };
    });
    const { summaryRecovered, targetChecksum } = recover.immediate();
    return {
      sessionId: input.sessionId,
      messagesRecovered: sourceMessages.length,
      summaryRecovered,
      sourceChecksum,
      targetChecksum,
      alreadyPresent: false,
    };
  } finally {
    target.close();
    source.close();
  }
}
