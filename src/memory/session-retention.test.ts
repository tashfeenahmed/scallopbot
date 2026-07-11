import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScallopDatabase } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const paths: string[] = [];

function tempDbPath(): string {
  const dbPath = path.join(os.tmpdir(), `scallop-session-retention-${Date.now()}-${Math.random()}.db`);
  paths.push(dbPath);
  return dbPath;
}

afterEach(() => {
  for (const dbPath of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
});

describe('lossless session retention', () => {
  it('prunes only archived sessions with a verified summary and preserves that summary', () => {
    const db = new ScallopDatabase(tempDbPath());
    const summarizedId = 'summarized-session';
    const unsummarizedId = 'unsummarized-session';

    db.createSession(summarizedId, { userId: 'telegram:user1', channelId: 'telegram' });
    db.addSessionMessage(summarizedId, 'user', 'A completed conversation');
    db.addSessionMessage(summarizedId, 'assistant', 'The durable outcome is recorded.');
    db.addSessionSummary({
      sessionId: summarizedId,
      userId: 'telegram:user1',
      summary: 'The conversation reached a durable outcome.',
      topics: ['outcome'],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    }, {
      verifier: 'session_summarizer',
      verificationVersion: 1,
    });

    db.createSession(unsummarizedId, { userId: 'telegram:user1', channelId: 'telegram' });
    db.addSessionMessage(unsummarizedId, 'user', 'Do not lose this unsummarized conversation');

    const old = Date.now() - 45 * DAY_MS;
    db.raw('UPDATE sessions SET updated_at = ? WHERE id IN (?, ?) RETURNING id', [
      old,
      summarizedId,
      unsummarizedId,
    ]);
    db.archiveSession(summarizedId, 'new_conversation', 'user_command');
    db.archiveSession(unsummarizedId, 'new_conversation', 'user_command');

    expect(db.pruneOldSessions(30)).toBe(1);

    expect(db.getSessionMessages(summarizedId)).toEqual([]);
    expect(db.getArchivedSessionMessages(summarizedId).map(message => message.content)).toEqual([
      'A completed conversation',
      'The durable outcome is recorded.',
    ]);
    expect(db.getArchivedSessionMessages(summarizedId).map(message => message.messageKind)).toEqual([
      'human_user',
      'assistant_final',
    ]);
    expect(db.getSessionSummary(summarizedId)?.summary).toBe('The conversation reached a durable outcome.');
    expect(db.getSession(summarizedId)?.transcriptDeletedAt).not.toBeNull();
    expect(db.getSessionLifecycleEvents(summarizedId).map(event => event.action)).toEqual([
      'archived',
      'transcript_pruned',
    ]);

    expect(db.getSessionMessages(unsummarizedId).map(message => message.content)).toEqual([
      'Do not lose this unsummarized conversation',
    ]);
    expect(db.getArchivedSessionMessages(unsummarizedId)).toEqual([]);
    expect(db.getSession(unsummarizedId)?.transcriptDeletedAt).toBeNull();
    expect(db.getSessionLifecycleEvents(unsummarizedId).map(event => event.action)).toEqual(['archived']);
    db.close();
  });

  it('never prunes an active session even when it is old and summarized', () => {
    const db = new ScallopDatabase(tempDbPath());
    db.createSession('current-session', { userId: 'api:user1', channelId: 'api' });
    db.addSessionMessage('current-session', 'user', 'Still the current conversation');
    db.addSessionSummary({
      sessionId: 'current-session',
      userId: 'api:user1',
      summary: 'An interim summary exists.',
      topics: [],
      messageCount: 1,
      durationMs: 0,
      embedding: null,
    });
    db.raw('UPDATE sessions SET updated_at = ? WHERE id = ? RETURNING id', [
      Date.now() - 45 * DAY_MS,
      'current-session',
    ]);

    expect(db.pruneOldSessions(30)).toBe(0);
    expect(db.getSessionMessages('current-session')).toHaveLength(1);
    expect(db.findSessionByUserId('api:user1')?.id).toBe('current-session');
    db.close();
  });

  it('never lets an unverified interim or malformed summary authorize pruning', () => {
    const db = new ScallopDatabase(tempDbPath());
    for (const sessionId of ['interim-summary', 'malformed-summary', 'tampered-summary']) {
      db.createSession(sessionId, { userId: 'api:user1', channelId: 'api' });
      db.addSessionMessage(sessionId, 'user', 'Please retain this conversation.');
      db.addSessionMessage(sessionId, 'assistant', 'I will retain it safely.');
      db.raw('UPDATE sessions SET updated_at = ? WHERE id = ? RETURNING id', [
        Date.now() - 45 * DAY_MS,
        sessionId,
      ]);
      db.archiveSession(sessionId, 'closed', 'test');
    }

    const interim = db.addSessionSummary({
      sessionId: 'interim-summary',
      userId: 'api:user1',
      summary: 'This looks structurally valid but has no verification receipt.',
      topics: ['retention'],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    });
    const malformed = db.addSessionSummary({
      sessionId: 'malformed-summary',
      userId: 'api:user1',
      summary: 'This summary has an invalid empty topic schema.',
      topics: [],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    }, {
      verifier: 'session_summarizer',
      verificationVersion: 1,
    });
    const tampered = db.addSessionSummary({
      sessionId: 'tampered-summary',
      userId: 'api:user1',
      summary: 'This summary is valid at the time its receipt is issued.',
      topics: ['retention'],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    }, {
      verifier: 'session_summarizer',
      verificationVersion: 1,
    });
    expect(tampered.schemaValid).toBe(true);
    db.raw('UPDATE session_summaries SET summary = ? WHERE id = ? RETURNING id', ['x', tampered.id]);

    expect(interim.schemaValid).toBe(false);
    expect(interim.verifiedAt).toBeNull();
    expect(malformed.schemaValid).toBe(false);
    expect(db.getSessionSummaryVerificationEvents(interim.id)).toMatchObject([
      { outcome: 'rejected', reason: 'verification_not_requested' },
    ]);
    expect(db.getSessionSummaryVerificationEvents(malformed.id)).toMatchObject([
      { outcome: 'rejected', reason: 'topics_schema_invalid' },
    ]);

    expect(db.pruneOldSessions(30)).toBe(0);
    expect(db.getSessionMessages('interim-summary')).toHaveLength(2);
    expect(db.getSessionMessages('malformed-summary')).toHaveLength(2);
    expect(db.getSessionMessages('tampered-summary')).toHaveLength(2);
    expect(db.getSessionSummary('tampered-summary')).toMatchObject({
      schemaValid: false,
      verifiedAt: null,
    });
    expect(db.getSessionSummaryVerificationEvents(tampered.id).at(-1)).toMatchObject({
      outcome: 'rejected',
      verifier: 'retention_revalidation',
      reason: 'summary_text_out_of_bounds',
    });
    db.close();
  });

  it('does not promote a newly written unverified summary during a later restart', () => {
    const dbPath = tempDbPath();
    let db = new ScallopDatabase(dbPath);
    db.createSession('post-migration-interim', { userId: 'api:user1', channelId: 'api' });
    db.addSessionMessage('post-migration-interim', 'user', 'Keep the original transcript.');
    db.addSessionMessage('post-migration-interim', 'assistant', 'The transcript will be retained.');
    db.addSessionSummary({
      sessionId: 'post-migration-interim',
      userId: 'api:user1',
      summary: 'A valid-looking but deliberately unverified interim summary.',
      topics: ['retention'],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    });
    db.raw('UPDATE sessions SET updated_at = ? WHERE id = ? RETURNING id', [
      Date.now() - 45 * DAY_MS,
      'post-migration-interim',
    ]);
    db.archiveSession('post-migration-interim', 'closed', 'test');
    db.close();

    db = new ScallopDatabase(dbPath);
    expect(db.getSessionSummary('post-migration-interim')).toMatchObject({
      schemaValid: false,
      verifiedAt: null,
    });
    expect(db.pruneOldSessions(30)).toBe(0);
    expect(db.getSessionMessages('post-migration-interim')).toHaveLength(2);
    db.close();
  });

  it('migrates a legacy database additively without changing existing history', () => {
    const dbPath = tempDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        metadata TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE session_message_archive (
        original_message_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        archive_reason TEXT NOT NULL
      );
    `);
    const now = Date.now();
    legacy.prepare(`
      INSERT INTO sessions (id, metadata, input_tokens, output_tokens, created_at, updated_at)
      VALUES (?, ?, 0, 0, ?, ?)
    `).run('legacy-session', JSON.stringify({ userId: 'telegram:legacy' }), now, now);
    legacy.prepare(`
      INSERT INTO sessions (id, metadata, input_tokens, output_tokens, created_at, updated_at)
      VALUES (?, ?, 0, 0, ?, ?)
    `).run('legacy-malformed-metadata', '{not-json', now, now);
    legacy.prepare(`
      INSERT INTO sessions (id, metadata, input_tokens, output_tokens, created_at, updated_at)
      VALUES (?, ?, 0, 0, ?, ?)
    `).run('legacy-worker', JSON.stringify({ userId: 'default', isSubAgent: true }), now, now);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'user', 'Legacy history remains intact', ?)
    `).run('legacy-session', now);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'assistant', ?, ?)
    `).run('legacy-session', JSON.stringify([
      { type: 'text', text: 'internal plan' },
      { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
    ]), now + 1);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'user', ?, ?)
    `).run('legacy-session', JSON.stringify([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'private result' },
    ]), now + 2);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'assistant', 'Legacy final answer', ?)
    `).run('legacy-session', now + 3);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'assistant', 'Private worker response', ?)
    `).run('legacy-worker', now);
    legacy.prepare(`
      INSERT INTO session_message_archive (
        original_message_id, session_id, role, content, created_at, archived_at, archive_reason
      ) VALUES (999, ?, 'assistant', 'Cold legacy final', ?, ?, 'legacy')
    `).run('legacy-session', now + 4, now + 5);
    legacy.close();

    const migrated = new ScallopDatabase(dbPath);
    expect(migrated.getSession('legacy-session')).toMatchObject({
      archivedAt: null,
      transcriptDeletedAt: null,
    });
    expect(migrated.getSessionMessages('legacy-session').map(message => message.messageKind)).toEqual([
      'human_user',
      'assistant_protocol',
      'tool_result',
      'assistant_final',
    ]);
    expect(migrated.getSessionMessages('legacy-worker').map(message => message.messageKind))
      .toEqual(['worker_internal']);
    expect(migrated.getArchivedSessionMessages('legacy-session').map(message => message.messageKind))
      .toEqual(['assistant_final']);
    expect(migrated.findSessionByUserId('telegram:legacy')?.id).toBe('legacy-session');
    expect(migrated.findSessionByUserId('missing')).toBeNull();
    migrated.close();
  });

  it('decouples legacy summaries from session deletion without changing their data', () => {
    const dbPath = tempDbPath();
    const legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        metadata TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        summary TEXT NOT NULL,
        topics TEXT,
        message_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        embedding TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    const now = Date.now();
    legacy.prepare(`
      INSERT INTO sessions (id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run('legacy-summary-session', JSON.stringify({ userId: 'default' }), now, now);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'user', 'Please preserve this outcome', ?)
    `).run('legacy-summary-session', now);
    legacy.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, 'assistant', 'The outcome was preserved.', ?)
    `).run('legacy-summary-session', now + 1);
    legacy.prepare(`
      INSERT INTO session_summaries
        (id, session_id, user_id, summary, topics, message_count, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-summary',
      'legacy-summary-session',
      'default',
      'This summary must outlive its source session.',
      JSON.stringify(['durability']),
      2,
      1_000,
      now,
    );
    legacy.close();

    const migrated = new ScallopDatabase(dbPath);
    expect(migrated.raw('PRAGMA foreign_key_list(session_summaries)')).toEqual([]);
    expect(migrated.getSessionSummary('legacy-summary-session')).toMatchObject({
      id: 'legacy-summary',
      summary: 'This summary must outlive its source session.',
      topics: ['durability'],
      schemaValid: true,
      verifier: 'legacy_structural_audit',
    });
    expect(migrated.getSessionSummaryVerificationEvents('legacy-summary')).toMatchObject([
      { outcome: 'verified', reason: 'legacy_structure_and_transcript_match' },
    ]);

    migrated.raw('DELETE FROM sessions WHERE id = ? RETURNING id', ['legacy-summary-session']);
    expect(migrated.getSessionSummary('legacy-summary-session')?.id).toBe('legacy-summary');
    migrated.close();
  });
});
