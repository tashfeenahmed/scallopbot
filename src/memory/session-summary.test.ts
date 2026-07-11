import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import { ScallopDatabase } from './db.js';
import { SessionSummarizer } from './session-summary.js';

function summaryProvider(): LLMProvider {
  return {
    name: 'test',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"summary":"A real chat.","topics":["chat"]}' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test',
    }),
  };
}

describe('SessionSummarizer transcript hygiene', () => {
  it('summarizes only genuine conversation turns', async () => {
    const db = new ScallopDatabase(':memory:');
    db.createSession('chat', { userId: 'default', channelId: 'api' });
    db.addSessionMessage('chat', 'user', 'Real question');
    db.addSessionMessage('chat', 'assistant', JSON.stringify([
      { type: 'thinking', thinking: 'private thought' },
      { type: 'tool_use', id: '1', name: 'search', input: { query: 'private query' } },
    ]));
    db.addSessionMessage('chat', 'user', JSON.stringify([
      { type: 'tool_result', tool_use_id: '1', content: 'private tool output' },
    ]));
    db.addSessionMessage('chat', 'assistant', 'Final answer');
    const provider = summaryProvider();
    const summarizer = new SessionSummarizer({
      provider, logger: pino({ level: 'silent' }), minMessages: 2,
    });

    await expect(summarizer.summarizeAndStore(db, 'chat')).resolves.toBe(true);
    const prompt = String(vi.mocked(provider.complete).mock.calls[0][0].messages[0].content);
    expect(prompt).toContain('User: Real question');
    expect(prompt).toContain('Assistant: Final answer');
    expect(prompt).not.toContain('private thought');
    expect(prompt).not.toContain('private tool output');
    expect(vi.mocked(provider.complete).mock.calls[0][0]).toMatchObject({
      enableThinking: false,
      purpose: 'session_summary',
      structuredOutput: {
        name: 'session_summary',
        strict: true,
        schema: {
          required: ['summary', 'topics'],
          additionalProperties: false,
        },
      },
    });
    expect(vi.mocked(provider.complete).mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(db.getSessionSummary('chat')).toMatchObject({
      messageCount: 2,
      schemaValid: true,
      verifier: 'session_summarizer',
      verificationVersion: 1,
    });
    const summaryId = db.getSessionSummary('chat')!.id;
    expect(db.getSessionSummaryVerificationEvents(summaryId)).toMatchObject([
      { outcome: 'verified', reason: 'schema_and_transcript_match' },
    ]);
    db.close();
  });

  it('never summarizes an isolated sub-agent transcript', async () => {
    const db = new ScallopDatabase(':memory:');
    db.createSession('worker', { userId: 'default', isSubAgent: true });
    db.addSessionMessage('worker', 'user', 'Internal task');
    db.addSessionMessage('worker', 'assistant', 'Internal result');
    const provider = summaryProvider();
    const summarizer = new SessionSummarizer({
      provider, logger: pino({ level: 'silent' }), minMessages: 1,
    });

    await expect(summarizer.summarizeAndStore(db, 'worker')).resolves.toBe(false);
    expect(provider.complete).not.toHaveBeenCalled();
    db.close();
  });

  it('regenerates a rejected summary losslessly and then skips the verified revision', async () => {
    const db = new ScallopDatabase(':memory:');
    db.createSession('healing-chat', { userId: 'default', channelId: 'api' });
    db.addSessionMessage('healing-chat', 'user', 'Please capture the final project decision.');
    db.addSessionMessage('healing-chat', 'assistant', 'The team selected the safer rollout plan.');
    const rejected = db.addSessionSummary({
      sessionId: 'healing-chat',
      userId: 'default',
      summary: 'Legacy summary that was preserved but rejected.',
      topics: [],
      messageCount: 2,
      durationMs: 0,
      embedding: null,
    });
    const provider = summaryProvider();
    vi.mocked(provider.complete).mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"summary":"The team selected the safer rollout plan.","topics":["project decision"]}',
      }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test',
    });
    const summarizer = new SessionSummarizer({
      provider,
      logger: pino({ level: 'silent' }),
      minMessages: 2,
    });

    await expect(summarizer.summarizeAndStore(db, 'healing-chat')).resolves.toBe(true);

    expect(db.getSessionSummary('healing-chat')).toMatchObject({
      id: rejected.id,
      summary: 'The team selected the safer rollout plan.',
      schemaValid: true,
      verifier: 'session_summarizer',
    });
    expect(db.getSessionSummaryRevisions('healing-chat')).toMatchObject([
      {
        summaryId: rejected.id,
        summary: 'Legacy summary that was preserved but rejected.',
        schemaValid: false,
        revisionReason: 'superseded_by_verified_regeneration',
      },
    ]);
    await expect(summarizer.summarizeAndStore(db, 'healing-chat')).resolves.toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('durably backs off parse failures across summarizer and database restarts', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `session-summary-circuit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    let db: ScallopDatabase | null = null;
    try {
      let now = 1_000_000;
      const provider: LLMProvider = {
        name: 'malformed-test',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'not json' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'malformed-test',
        }),
      };
      db = new ScallopDatabase(dbPath);
      db.createSession('broken-chat', { userId: 'default' });
      db.addSessionMessage('broken-chat', 'user', 'First real turn');
      db.addSessionMessage('broken-chat', 'assistant', 'First real response');

      const first = new SessionSummarizer({
        provider,
        logger: pino({ level: 'silent' }),
        minMessages: 2,
        now: () => now,
      });
      await expect(first.summarizeAndStore(db, 'broken-chat')).resolves.toBe(false);
      expect(db.getSessionSummaryFailure('broken-chat')).toMatchObject({
        failureCount: 1,
        lastErrorCode: 'invalid_json',
        nextRetryAt: now + 60_000,
      });
      expect(db.getStructuredRouteCircuit('session_summary')).toMatchObject({ failureCount: 1 });

      // A new summarizer object cannot reset the persisted retry gate.
      const second = new SessionSummarizer({
        provider,
        logger: pino({ level: 'silent' }),
        minMessages: 2,
        now: () => now,
      });
      await expect(second.summarizeAndStore(db, 'broken-chat')).resolves.toBe(false);
      expect(provider.complete).toHaveBeenCalledTimes(1);

      db.close();
      db = new ScallopDatabase(dbPath);
      const afterRestart = new SessionSummarizer({
        provider,
        logger: pino({ level: 'silent' }),
        minMessages: 2,
        now: () => now,
      });
      await expect(afterRestart.summarizeAndStore(db, 'broken-chat')).resolves.toBe(false);
      expect(provider.complete).toHaveBeenCalledTimes(1);

      now += 60_001;
      await expect(afterRestart.summarizeAndStore(db, 'broken-chat')).resolves.toBe(false);
      expect(db.getSessionSummaryFailure('broken-chat')).toMatchObject({
        failureCount: 2,
        lastErrorCode: 'invalid_json',
      });
      expect(provider.complete).toHaveBeenCalledTimes(2);
    } finally {
      db?.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
      }
    }
  });

  it('aborts and records a provider timeout instead of hanging the gardener', async () => {
    const db = new ScallopDatabase(':memory:');
    db.createSession('slow-chat', { userId: 'default' });
    db.addSessionMessage('slow-chat', 'user', 'Please summarize this');
    db.addSessionMessage('slow-chat', 'assistant', 'This call will stall');
    let signal: AbortSignal | undefined;
    const provider: LLMProvider = {
      name: 'stalled-test',
      isAvailable: () => true,
      complete: vi.fn().mockImplementation(request => {
        signal = request.signal;
        return new Promise(() => undefined);
      }),
    };
    const summarizer = new SessionSummarizer({
      provider,
      logger: pino({ level: 'silent' }),
      minMessages: 2,
      requestTimeoutMs: 15,
    });
    const startedAt = Date.now();

    await expect(summarizer.summarizeAndStore(db, 'slow-chat')).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(signal?.aborted).toBe(true);
    expect(db.getSessionSummaryFailure('slow-chat')).toMatchObject({
      failureCount: 1,
      lastErrorCode: 'timeout',
    });
    db.close();
  });
});
