/**
 * Postmortem over a production memories.db (the Hermes `postmortem/` idea).
 *
 *   npm run postmortem -- pi-data/tashbot/memories.db [--json]
 *
 * The database is never opened in place: it (and any -wal file) is copied to
 * a temp dir and the copy is opened read-only. Works across schema versions —
 * newer tables/columns (message_kind, session_message_archive, llm_traces,
 * cost_usage.purpose) are used when present.
 *
 * Reports: canned refusals, BLOCKED / SAFETY_ tool errors, repeated identical
 * read_file calls within a session, write_file whole-file rewrites,
 * "[System: ...]" nudges, LLM calls per user turn and mean tokens.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const CANNED_REFUSAL_RE = /I could not produce a safe/i;
const TYPED_ERROR_RE = /\[TOOL_ERROR code=([A-Z_]+)\]/;
const BLOCKED_RE = /\bBLOCKED\b|SAFETY_[A-Z_]+|already succeeded during the current turn|is not permitted in this session/;
const INTERNAL_USER_RE = /^\s*\[(?:System|Sub-agent|Scheduled|Reminder|Trigger)\b/i;

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface MessageRow {
  session_id: string;
  role: string;
  content: string;
  created_at: number;
  message_kind?: string | null;
}

interface CostRow {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  timestamp: number;
  purpose?: string | null;
}

export interface PostmortemReport {
  database: string;
  span: { from: string | null; to: string | null };
  sessions: number;
  messages: number;
  userTurns: number;
  assistantReplies: number;
  cannedRefusals: { count: number; share: number; samples: string[] };
  toolCalls: number;
  toolErrors: number;
  toolErrorRate: number;
  blockedToolResults: { count: number; byCode: Record<string, number> };
  typedToolErrors: Record<string, number>;
  repeatedReads: { sessions: number; excessCalls: number; worst: Array<{ session: string; path: string; times: number }> };
  writeFileRewrites: { count: number; sameFileRewrites: number; afterRead: number; samples: Array<{ session: string; path: string }> };
  systemNudges: number;
  toolCallsByName: Record<string, number>;
  llm: {
    costRows: number;
    foregroundRows: number;
    backgroundRows: number;
    callsPerUserTurn: number | null;
    allCallsPerUserTurn: number | null;
    meanInputTokensPerCall: number;
    meanOutputTokensPerCall: number;
    meanInputTokensPerTurn: number | null;
    byPurpose: Record<string, number>;
    backgroundBySession: Record<string, number>;
  };
  traces: { rows: number; byPurpose: Record<string, { calls: number; medianLatencyMs: number | null }> } | null;
}

function parseBlocks(content: string): Block[] | null {
  if (!content.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as Block[]) : null;
  } catch {
    return null;
  }
}

function textOf(content: string, blocks: Block[] | null): string {
  if (!blocks) return content;
  return blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const bump = (record: Record<string, number>, key: string, by = 1) => {
  record[key] = (record[key] ?? 0) + by;
};

/** Copy the database (and WAL) to a temp dir so the original is never touched. */
export function snapshotDatabase(source: string): { file: string; cleanup: () => void } {
  if (!existsSync(source)) throw new Error(`no database at ${source}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scallop-postmortem-'));
  const file = path.join(dir, 'memories.db');
  copyFileSync(source, file);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, file + suffix);
  }
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function analyse(source: string): PostmortemReport {
  const snapshot = snapshotDatabase(source);
  // Not readonly: SQLite needs to replay a copied WAL. The copy is thrown away.
  const db = new Database(snapshot.file, { fileMustExist: true });
  try {
    return analyseOpen(db, source);
  } finally {
    db.close();
    snapshot.cleanup();
  }
}

function analyseOpen(db: Database.Database, label: string): PostmortemReport {
  const messageTables = ['session_messages', 'session_message_archive'].filter(t => tableExists(db, t));
  const rows: MessageRow[] = [];
  for (const table of messageTables) {
    const kind = columns(db, table).has('message_kind') ? 'message_kind' : 'NULL AS message_kind';
    rows.push(...db.prepare(`SELECT session_id, role, content, created_at, ${kind} FROM ${table}`).all() as MessageRow[]);
  }
  rows.sort((a, b) => a.created_at - b.created_at);

  const userTurnsBySession = new Map<string, number[]>();
  const cannedSamples: string[] = [];
  let canned = 0;
  let assistantReplies = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let systemNudges = 0;
  const blockedByCode: Record<string, number> = {};
  let blocked = 0;
  const typedToolErrors: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const readCounts = new Map<string, Map<string, number>>();
  const readPaths = new Map<string, Set<string>>();
  const writePaths = new Map<string, Set<string>>();
  let writeRewrites = 0;
  let sameFileRewrites = 0;
  let writeAfterRead = 0;
  const rewriteSamples: Array<{ session: string; path: string }> = [];

  for (const row of rows) {
    const blocks = parseBlocks(row.content);
    const text = textOf(row.content, blocks);
    const hasToolResult = blocks?.some(b => b.type === 'tool_result') ?? false;
    const hasToolUse = blocks?.some(b => b.type === 'tool_use') ?? false;

    if (row.role === 'user') {
      const human = row.message_kind
        ? row.message_kind === 'human_user'
        : !hasToolResult && !INTERNAL_USER_RE.test(text);
      if (human && text.trim()) {
        const turns = userTurnsBySession.get(row.session_id) ?? [];
        turns.push(row.created_at);
        userTurnsBySession.set(row.session_id, turns);
      }
      if (/^\s*\[System:/.test(text)) systemNudges++;
    }

    if (row.role === 'assistant' && !hasToolUse && text.trim()) {
      assistantReplies++;
      if (CANNED_REFUSAL_RE.test(text)) {
        canned++;
        if (cannedSamples.length < 5) cannedSamples.push(text.slice(0, 200));
      }
    }

    for (const block of blocks ?? []) {
      if (block.type === 'tool_use' && block.name) {
        toolCalls++;
        bump(toolCallsByName, block.name);
        const target = typeof block.input?.path === 'string' ? block.input.path : undefined;
        if (block.name === 'read_file') {
          const key = JSON.stringify(block.input ?? {});
          const perSession = readCounts.get(row.session_id) ?? new Map<string, number>();
          perSession.set(key, (perSession.get(key) ?? 0) + 1);
          readCounts.set(row.session_id, perSession);
          if (target) {
            const reads = readPaths.get(row.session_id) ?? new Set<string>();
            reads.add(target);
            readPaths.set(row.session_id, reads);
          }
        }
        if (block.name === 'write_file' && target && block.input?.append !== true) {
          const writes = writePaths.get(row.session_id) ?? new Set<string>();
          const wasWritten = writes.has(target);
          const wasRead = readPaths.get(row.session_id)?.has(target) ?? false;
          if (wasWritten || wasRead) {
            writeRewrites++;
            if (wasWritten) sameFileRewrites++;
            if (wasRead) writeAfterRead++;
            if (rewriteSamples.length < 10) rewriteSamples.push({ session: row.session_id, path: target });
          }
          writes.add(target);
          writePaths.set(row.session_id, writes);
        }
      }
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const isError = block.is_error === true || /^Error:/.test(content) || content.startsWith('[TOOL_ERROR');
        if (isError) toolErrors++;
        const typed = TYPED_ERROR_RE.exec(content)?.[1];
        if (typed) bump(typedToolErrors, typed);
        if (BLOCKED_RE.test(content)) {
          blocked++;
          bump(blockedByCode, typed ?? (/already succeeded/.test(content) ? 'DUPLICATE_MUTATION' : 'BLOCKED'));
        }
      }
    }
  }

  const worst: Array<{ session: string; path: string; times: number }> = [];
  let repeatSessions = 0;
  let excessReads = 0;
  for (const [session, counts] of readCounts) {
    let sessionHasRepeat = false;
    for (const [key, times] of counts) {
      if (times < 2) continue;
      sessionHasRepeat = true;
      excessReads += times - 1;
      const parsed = JSON.parse(key) as { path?: string };
      worst.push({ session, path: parsed.path ?? key, times });
    }
    if (sessionHasRepeat) repeatSessions++;
  }
  worst.sort((a, b) => b.times - a.times);

  // LLM calls: cost_usage rows in a real session are attributed to the latest
  // human turn at or before them; rows under synthetic ids are background work.
  const costRows: CostRow[] = tableExists(db, 'cost_usage')
    ? db.prepare(`SELECT session_id, input_tokens, output_tokens, timestamp${columns(db, 'cost_usage').has('purpose') ? ', purpose' : ''} FROM cost_usage`).all() as CostRow[]
    : [];
  const knownSessions = new Set(
    tableExists(db, 'sessions') ? (db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>).map(r => r.id) : [],
  );
  for (const session of userTurnsBySession.keys()) knownSessions.add(session);
  const userTurns = [...userTurnsBySession.values()].reduce((sum, turns) => sum + turns.length, 0);
  let foreground = 0;
  let foregroundInput = 0;
  const backgroundBySession: Record<string, number> = {};
  const byPurpose: Record<string, number> = {};
  for (const row of costRows) {
    bump(byPurpose, row.purpose ?? 'untagged');
    const turns = userTurnsBySession.get(row.session_id);
    if (knownSessions.has(row.session_id) && turns?.some(t => t <= row.timestamp)) {
      foreground++;
      foregroundInput += row.input_tokens;
    } else {
      bump(backgroundBySession, knownSessions.has(row.session_id) ? '(session, before first turn)' : row.session_id);
    }
  }
  const totalInput = costRows.reduce((sum, r) => sum + r.input_tokens, 0);
  const totalOutput = costRows.reduce((sum, r) => sum + r.output_tokens, 0);

  let traces: PostmortemReport['traces'] = null;
  if (tableExists(db, 'llm_traces')) {
    const traceRows = db.prepare('SELECT purpose, latency_ms FROM llm_traces').all() as Array<{ purpose: string; latency_ms: number | null }>;
    const grouped = new Map<string, number[]>();
    for (const row of traceRows) {
      const list = grouped.get(row.purpose) ?? [];
      if (row.latency_ms !== null) list.push(row.latency_ms);
      grouped.set(row.purpose, list);
    }
    traces = {
      rows: traceRows.length,
      byPurpose: Object.fromEntries([...grouped].map(([purpose, latencies]) => [
        purpose,
        { calls: traceRows.filter(r => r.purpose === purpose).length, medianLatencyMs: median(latencies) },
      ])),
    };
  }

  return {
    database: label,
    span: {
      from: rows.length ? new Date(rows[0]!.created_at).toISOString() : null,
      to: rows.length ? new Date(rows[rows.length - 1]!.created_at).toISOString() : null,
    },
    sessions: new Set(rows.map(r => r.session_id)).size,
    messages: rows.length,
    userTurns,
    assistantReplies,
    cannedRefusals: { count: canned, share: assistantReplies ? canned / assistantReplies : 0, samples: cannedSamples },
    toolCalls,
    toolErrors,
    toolErrorRate: toolCalls ? toolErrors / toolCalls : 0,
    blockedToolResults: { count: blocked, byCode: blockedByCode },
    typedToolErrors,
    repeatedReads: { sessions: repeatSessions, excessCalls: excessReads, worst: worst.slice(0, 10) },
    writeFileRewrites: { count: writeRewrites, sameFileRewrites, afterRead: writeAfterRead, samples: rewriteSamples },
    systemNudges,
    toolCallsByName,
    llm: {
      costRows: costRows.length,
      foregroundRows: foreground,
      backgroundRows: costRows.length - foreground,
      callsPerUserTurn: userTurns ? foreground / userTurns : null,
      allCallsPerUserTurn: userTurns ? costRows.length / userTurns : null,
      meanInputTokensPerCall: costRows.length ? totalInput / costRows.length : 0,
      meanOutputTokensPerCall: costRows.length ? totalOutput / costRows.length : 0,
      meanInputTokensPerTurn: userTurns ? foregroundInput / userTurns : null,
      byPurpose,
      backgroundBySession,
    },
    traces,
  };
}

const fixed = (value: number | null, digits = 2) => (value === null ? 'n/a' : value.toFixed(digits));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const top = (record: Record<string, number>, n = 8) =>
  Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ') || '-';

export function formatReport(report: PostmortemReport): string {
  const lines = [
    `== Postmortem · ${report.database} ==`,
    `span                 ${report.span.from ?? '?'} → ${report.span.to ?? '?'}`,
    `sessions / messages  ${report.sessions} / ${report.messages}   user turns ${report.userTurns}   replies ${report.assistantReplies}`,
    `canned refusals      ${report.cannedRefusals.count} (${pct(report.cannedRefusals.share)} of replies)`,
    `tool calls           ${report.toolCalls}   errors ${report.toolErrors} (${pct(report.toolErrorRate)})`,
    `gate-blocked results ${report.blockedToolResults.count}   ${top(report.blockedToolResults.byCode)}`,
    `typed tool errors    ${top(report.typedToolErrors)}`,
    `repeated read_file   ${report.repeatedReads.excessCalls} wasted calls in ${report.repeatedReads.sessions} sessions`,
    `write_file rewrites  ${report.writeFileRewrites.count} (same file again ${report.writeFileRewrites.sameFileRewrites}, after reading it ${report.writeFileRewrites.afterRead})`,
    `[System:] nudges     ${report.systemNudges}`,
    `LLM calls / turn     ${fixed(report.llm.callsPerUserTurn)} foreground, ${fixed(report.llm.allCallsPerUserTurn)} incl. background (${report.llm.backgroundRows} background rows)`,
    `tokens               ${Math.round(report.llm.meanInputTokensPerCall)} in / ${Math.round(report.llm.meanOutputTokensPerCall)} out per call; ${fixed(report.llm.meanInputTokensPerTurn, 0)} in per user turn`,
    `calls by purpose     ${top(report.llm.byPurpose)}`,
    `background sessions  ${top(report.llm.backgroundBySession)}`,
    `top tools            ${top(report.toolCallsByName, 12)}`,
  ];
  if (report.traces) {
    lines.push(`llm_traces           ${report.traces.rows} rows; ${Object.entries(report.traces.byPurpose)
      .map(([purpose, s]) => `${purpose}=${s.calls} (p50 ${s.medianLatencyMs === null ? 'n/a' : `${Math.round(s.medianLatencyMs)}ms`})`).join(', ')}`);
  }
  if (report.repeatedReads.worst.length) {
    lines.push('worst re-reads:');
    for (const w of report.repeatedReads.worst.slice(0, 5)) lines.push(`  ${w.times}× ${w.path} (session ${w.session})`);
  }
  if (report.cannedRefusals.samples.length) {
    lines.push('canned refusal samples:');
    for (const sample of report.cannedRefusals.samples) lines.push(`  ${JSON.stringify(sample)}`);
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find(arg => !arg.startsWith('--'));
  if (!file) {
    console.error('Usage: npm run postmortem -- <path to memories.db> [--json]');
    process.exit(1);
  }
  const report = analyse(path.resolve(file));
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
