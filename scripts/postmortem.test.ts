import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScallopDatabase } from '../src/memory/db.js';
import { analyse, formatReport } from './postmortem.js';

describe('postmortem', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'postmortem-test-'));
    dbPath = path.join(dir, 'memories.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mines refusals, gate blocks, re-reads, rewrites and calls per turn', () => {
    const db = new ScallopDatabase(dbPath);
    db.createSession('s1', { userId: 'telegram:1', channelId: 'telegram' });
    const add = (role: 'user' | 'assistant', content: unknown) =>
      db.addSessionMessage('s1', role, typeof content === 'string' ? content : JSON.stringify(content));
    const read = { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'a.ts' } };

    add('user', 'clean up dist and fix the tests');
    add('assistant', [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'rm -rf dist' } }]);
    add('user', [{ type: 'tool_result', tool_use_id: 'b1', content: '[TOOL_ERROR code=SAFETY_LOCAL_INTENT_REQUIRED] BLOCKED: nope', is_error: true }]);
    add('assistant', [read]);
    add('user', [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }]);
    add('assistant', [{ ...read, id: 'r2' }]);
    add('user', [{ type: 'tool_result', tool_use_id: 'r2', content: 'x' }]);
    add('assistant', [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'a.ts', content: 'y' } }]);
    add('user', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }]);
    add('user', '[System: Your draft claims a requested action succeeded, but...]');
    add('assistant', 'I could not produce a safe, reliable final response for that turn.');
    add('user', 'thanks');
    add('assistant', 'You are welcome.');

    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      db.recordCostUsage({ model: 'm', provider: 'p', sessionId: 's1', inputTokens: 1000, outputTokens: 10, cost: 0, timestamp: now + 1000, purpose: i === 0 ? 'outcome_brain' : 'tool_call' });
    }
    db.recordCostUsage({ model: 'm', provider: 'p', sessionId: 'fact-extractor', inputTokens: 500, outputTokens: 5, cost: 0, timestamp: now + 1000 });
    db.close();
    const before = readFileSync(dbPath);

    const report = analyse(dbPath);
    expect(report.userTurns).toBe(2);
    expect(report.cannedRefusals.count).toBe(1);
    expect(report.blockedToolResults.byCode).toEqual({ SAFETY_LOCAL_INTENT_REQUIRED: 1 });
    expect(report.repeatedReads.excessCalls).toBe(1);
    expect(report.writeFileRewrites).toMatchObject({ count: 1, afterRead: 1 });
    expect(report.systemNudges).toBe(1);
    expect(report.toolCalls).toBe(4);
    expect(report.llm.foregroundRows).toBe(4);
    expect(report.llm.backgroundBySession).toEqual({ 'fact-extractor': 1 });
    expect(report.llm.callsPerUserTurn).toBe(2);
    expect(report.llm.byPurpose).toMatchObject({ outcome_brain: 1, tool_call: 3, untagged: 1 });
    expect(formatReport(report)).toContain('canned refusals      1');

    // The source database is never modified.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});
