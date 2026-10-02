import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ScallopDatabase } from '../memory/db.js';
import { SessionManager } from '../agent/session.js';
import {
  buildFtsQuery,
  createSessionSearchSkill,
  ownedUserIds,
  registerSessionSearchTool,
  runSessionSearch,
  SESSION_SEARCH_DESCRIPTION,
} from './session-search.js';
import { loadCompactionState, saveCompactionState } from './compaction-state.js';
import { leanCompact } from './lean-compaction.js';
import { buildReplayMessages } from './replay.js';
import { makeToolSession } from './test-fixtures.js';

let dir: string;
let dbPath: string;
let db: ScallopDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scallop-session-search-'));
  dbPath = path.join(dir, 'memories.db');
  db = new ScallopDatabase(dbPath, { runRetentionMaintenance: false });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(): Promise<{ alice: string; aliceOld: string; bob: string; worker: string }> {
  const sessions = new SessionManager(db);
  const alice = await sessions.createSession({ userId: 'telegram:111', channelId: 'telegram' });
  await sessions.addMessage(alice.id, { role: 'user', content: 'Please deploy the kilkenny landing page to staging' });
  await sessions.addMessage(alice.id, { role: 'assistant', content: [{ type: 'tool_use', id: 'bash:1', name: 'bash', input: { command: 'wrangler pages deploy site --branch staging' } }] });
  await sessions.addMessage(alice.id, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash:1', content: `Deployed to https://staging.kilkenny.pages.dev\n${'log '.repeat(4_000)}TAIL_MARKER_BEYOND_8K` }] });
  await sessions.addMessage(alice.id, { role: 'assistant', content: 'Deployed. The staging URL is https://staging.kilkenny.pages.dev' });
  for (let index = 0; index < 12; index++) {
    await sessions.addMessage(alice.id, { role: 'user', content: `filler question ${index}` });
    await sessions.addMessage(alice.id, { role: 'assistant', content: `filler answer ${index}` });
  }
  const aliceOld = await sessions.createSession({ userId: 'telegram:111', channelId: 'telegram' });
  await sessions.addMessage(aliceOld.id, { role: 'user', content: 'my favourite colour is ultramarine' });
  await sessions.addMessage(aliceOld.id, { role: 'assistant', content: 'Noted: ultramarine.' });

  const bob = await sessions.createSession({ userId: 'telegram:222', channelId: 'telegram' });
  await sessions.addMessage(bob.id, { role: 'user', content: 'bob secret: the kilkenny vault code is 4417' });

  const worker = await sessions.createSession({ userId: 'telegram:111', channelId: 'subagent', isSubAgent: true });
  await sessions.addMessage(worker.id, { role: 'user', content: 'worker scratch about kilkenny internals' });
  return { alice: alice.id, aliceOld: aliceOld.id, bob: bob.id, worker: worker.id };
}

const deps = () => ({ db, canonicalSingleUserIds: [] as string[] });

describe('session_search', () => {
  it('discover finds BM25 hits in the caller\'s sessions and expands the top hit ±5', async () => {
    const ids = await seed();
    const result = runSessionSearch({ query: 'kilkenny staging deploy' }, { userId: 'telegram:111', sessionId: ids.alice }, deps());
    expect(result.success).toBe(true);
    expect(result.output).toContain(`session ${ids.alice} (current session)`);
    expect(result.output).toContain('Top hit expanded');
    expect(result.output).toContain('>> #');
    expect(result.output).toContain('wrangler pages deploy site --branch staging');
    // User scoping: other users and sub-agent transcripts never leak.
    expect(result.output).not.toContain('4417');
    expect(result.output).not.toContain(ids.bob);
    expect(result.output).not.toContain('worker scratch');
  });

  it('indexes tool output truncated to 8k chars', async () => {
    await seed();
    const early = runSessionSearch({ query: 'staging.kilkenny.pages.dev' }, { userId: 'telegram:111' }, deps());
    expect(early.output).toContain('hit(s)');
    const late = runSessionSearch({ query: 'TAIL_MARKER_BEYOND_8K' }, { userId: 'telegram:111' }, deps());
    expect(late.output).toMatch(/^No messages matched/);
  });

  it('read returns a radius window and refuses another user\'s session', async () => {
    const ids = await seed();
    const hit = db.searchSessionMessages({ match: '"ultramarine"', userIds: ['telegram:111'] })[0];
    const read = runSessionSearch({ mode: 'read', session_id: ids.aliceOld, message_id: hit.messageId, radius: 1 }, { userId: 'telegram:111' }, deps());
    expect(read.success).toBe(true);
    expect(read.output).toContain('my favourite colour is ultramarine');
    expect(read.output).toContain('Noted: ultramarine.');
    const denied = runSessionSearch({ mode: 'read', session_id: ids.bob, message_id: 1 }, { userId: 'telegram:111' }, deps());
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('No session');
  });

  it('scroll pages before/after an anchor with a continuation hint', async () => {
    const ids = await seed();
    const rows = db.getSessionMessages(ids.alice);
    const middle = rows[10].id;
    const before = runSessionSearch({ session_id: ids.alice, around_message_id: middle, direction: 'before', limit: 3 }, { userId: 'telegram:111' }, deps());
    expect(before.output).toContain(`#${rows[9].id} `);
    expect(before.output).toContain(`#${rows[7].id} `);
    expect(before.output).not.toContain(`#${middle} `);
    expect(before.output).toContain(`around_message_id: ${rows[7].id}, direction: "before"`);
    const after = runSessionSearch({ mode: 'scroll', session_id: ids.alice, around_message_id: middle, direction: 'after', limit: 2 }, { userId: 'telegram:111' }, deps());
    expect(after.output).toContain(`#${rows[11].id} `);
    expect(after.output).toContain(`#${rows[12].id} `);
  });

  it('browse lists the caller\'s recent sessions or one session\'s tail', async () => {
    const ids = await seed();
    const list = runSessionSearch({}, { userId: 'telegram:111', sessionId: ids.alice }, deps());
    expect(list.output).toContain(`${ids.alice} (current)`);
    expect(list.output).toContain(ids.aliceOld);
    expect(list.output).not.toContain(ids.bob);
    expect(list.output).not.toContain(ids.worker);
    const tail = runSessionSearch({ mode: 'browse', session_id: ids.alice, limit: 2 }, { userId: 'telegram:111' }, deps());
    expect(tail.output).toContain('filler answer 11');
    expect(tail.output).toContain('filler question 11');
    expect(tail.output).not.toContain('filler answer 10');
  });

  it('requires a user identity and maps declared single-owner aliases', () => {
    expect(runSessionSearch({ query: 'x' }, {}, deps()).success).toBe(false);
    expect(ownedUserIds('telegram:111', [])).toEqual(['telegram:111', '111']);
    expect(ownedUserIds('api:default', ['111', 'telegram:111'])).toEqual(expect.arrayContaining(['api:default', 'default', '111', 'telegram:111']));
  });

  it('builds safe FTS queries from arbitrary text', () => {
    expect(buildFtsQuery('src/x.ts "quoted" AND NOT', 'and')).toBe('"src" "ts" "quoted" "AND" "NOT"');
    expect(buildFtsQuery('a', 'or')).toBeNull();
    expect(buildFtsQuery('fix bug', 'phrase')).toBe('"fix bug"');
  });

  it('registers as a read-only native skill with the no-false-negative instruction', () => {
    const registered: unknown[] = [];
    const skill = registerSessionSearchTool({ registerSkill: s => registered.push(s) }, deps());
    expect(registered).toEqual([skill]);
    expect(skill.name).toBe('session_search');
    expect(SESSION_SEARCH_DESCRIPTION).toContain('Never conclude "not found" from conversation history alone — search first.');
    expect(skill.frontmatter.metadata?.openclaw?.safety ?? skill.frontmatter).toBeTruthy();
    expect(typeof createSessionSearchSkill(deps()).handler).toBe('function');
  });

  it('native handler runs with ctx.userId', async () => {
    await seed();
    const skill = createSessionSearchSkill(deps());
    const result = await skill.handler!({ args: { query: 'ultramarine' }, workspace: dir, sessionId: 'x', userId: 'telegram:111' });
    expect(result.output).toContain('ultramarine');
    const other = await skill.handler!({ args: { query: 'ultramarine' }, workspace: dir, sessionId: 'x', userId: 'telegram:222' });
    expect(other.output).toMatch(/^No messages matched/);
  });

  it('forget removes messages from the index and drops the compaction row', async () => {
    const ids = await seed();
    const sessions = new SessionManager(db);
    for (const message of makeToolSession(30, { tools: 2, resultChars: 3_000 })) await sessions.addMessage(ids.alice, message);
    const messages = db.getSessionMessages(ids.alice).map(row => ({ role: row.role, content: row.content, messageKind: row.messageKind }));
    const compacted = (await leanCompact({ messages, windowTokens: 1_000 }))!;
    expect(compacted).not.toBeNull();
    saveCompactionState(db, ids.alice, compacted.state);
    expect(loadCompactionState(db, ids.alice)?.compactionCount).toBe(1);
    db.deleteSession(ids.alice, 'explicit_forget', 'test');
    expect(runSessionSearch({ query: 'wrangler' }, { userId: 'telegram:111' }, deps()).output).toMatch(/^No messages matched/);
    expect(loadCompactionState(db, ids.alice)).toBeNull();
  });

  it('a state computed from stored rows replays identically over the in-memory session', async () => {
    const ids = await seed();
    const sessions = new SessionManager(db);
    for (const message of makeToolSession(30, { tools: 2, resultChars: 3_000 })) await sessions.addMessage(ids.alice, message);
    const rows = db.getSessionMessages(ids.alice).map(row => ({ role: row.role, content: row.content, messageKind: row.messageKind }));
    const compacted = (await leanCompact({ messages: rows, windowTokens: 128_000, now: 5 }))!;
    sessions.clearCache();
    const live = (await sessions.getSession(ids.alice))!.messages;
    expect(buildReplayMessages(live, { compactionState: compacted.state })).toEqual(compacted.messages);
  });

  it('compaction state is updated in place (one row per session)', async () => {
    const ids = await seed();
    const sessions = new SessionManager(db);
    for (const message of makeToolSession(30, { tools: 2, resultChars: 3_000 })) await sessions.addMessage(ids.alice, message);
    const messages = db.getSessionMessages(ids.alice).map(row => ({ role: row.role, content: row.content, messageKind: row.messageKind }));
    const first = (await leanCompact({ messages, windowTokens: 1_000 }))!;
    saveCompactionState(db, ids.alice, first.state);
    saveCompactionState(db, ids.alice, { ...first.state, compactionCount: 2, summaryMessage: 'v2' });
    const row = db.getSessionCompaction(ids.alice)!;
    expect(row.compactionCount).toBe(2);
    expect(row.summaryMessage).toBe('v2');
  });
});

describe('session search migration on an existing database', () => {
  it('backfills rows written before the index existed, in batches', async () => {
    const ids = await seed();
    db.close();
    // Simulate a database from before this migration.
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TRIGGER IF EXISTS session_messages_fts_hot_delete;
      DROP TRIGGER IF EXISTS session_messages_fts_archive_delete;
      DROP TABLE IF EXISTS session_messages_fts;
      DROP TABLE IF EXISTS session_search_index_state;
      DROP TABLE IF EXISTS session_compactions;
    `);
    raw.close();

    db = new ScallopDatabase(dbPath, { runRetentionMaintenance: false });
    expect(db.searchSessionMessages({ match: '"ultramarine"', userIds: ['telegram:111'] })).toHaveLength(0);
    let batches = 0;
    while (db.backfillSessionSearchIndex(5) > 0) batches++;
    expect(batches).toBeGreaterThan(3);
    expect(db.searchSessionMessages({ match: '"ultramarine"', userIds: ['telegram:111'] }).length).toBeGreaterThan(0);
    // New writes are indexed immediately, without backfill.
    const sessions = new SessionManager(db);
    await sessions.addMessage(ids.aliceOld, { role: 'user', content: 'new fact: the boat is called Saoirse' });
    expect(db.searchSessionMessages({ match: '"saoirse"', userIds: ['telegram:111'] })).toHaveLength(1);
    // And the tool path does the lazy backfill itself.
    expect(runSessionSearch({ query: 'kilkenny' }, { userId: 'telegram:111' }, deps()).success).toBe(true);
  });

  it('migrates a legacy database without message_kind or archive rows', () => {
    db.close();
    const legacyPath = path.join(dir, 'legacy.db');
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, metadata TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE session_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('legacy', '{"userId":"telegram:9","channelId":"telegram"}', 0, 0, 1, 1);
      INSERT INTO session_messages (session_id, role, content, created_at) VALUES
        ('legacy', 'user', 'remember the invoice number INV-20931', 1),
        ('legacy', 'assistant', '[{"type":"thinking","thinking":"secret reasoning"},{"type":"tool_use","id":"t","name":"bash","input":{"command":"grep INV"}}]', 2),
        ('legacy', 'user', '[{"type":"tool_result","tool_use_id":"t","content":"INV-20931 paid"}]', 3);
    `);
    raw.close();
    db = new ScallopDatabase(legacyPath, { runRetentionMaintenance: false });
    while (db.backfillSessionSearchIndex(1) > 0) { /* drain */ }
    const hits = db.searchSessionMessages({ match: '"INV"', userIds: ['telegram:9'] });
    expect(hits.map(hit => hit.messageKind).sort()).toEqual(['assistant_protocol', 'human_user', 'tool_result']);
    expect(db.searchSessionMessages({ match: '"reasoning"', userIds: ['telegram:9'] })).toHaveLength(0);
  });
});
