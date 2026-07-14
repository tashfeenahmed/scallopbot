import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, ScallopMemoryEntry } from './db.js';
import type { LLMProvider } from '../providers/types.js';
import type { CompletionResponse } from '../providers/types.js';
import type { GardenerContext } from './gardener-context.js';
import { GoalService } from '../goals/goal-service.js';
import {
  runFullDecay,
  runMemoryFusion,
  runSessionSummarization,
  runEnhancedForgetting,
  runBehavioralInference,
  runTrustScoreUpdate,
  runGoalDeadlineCheck,
  runInnerThoughts,
  runSubAgentCleanup,
} from './gardener-deep-steps.js';

const TEST_DB_PATH = '/tmp/gardener-deep-steps-test.db';
const logger = pino({ level: 'silent' });
const OWNER_ALIASES = ['owner-example', 'telegram:owner-example'] as const;

/** Run a raw SQL write (UPDATE/DELETE) — db.raw() only supports SELECT */
function rawRun(db: ScallopDatabase, sql: string, params: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db.prepare(sql).run(...params);
}

function cleanupTestDb() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch { /* ignore */ }
}

function createMockFusionProvider(responseText?: string): LLMProvider {
  const defaultResponse = JSON.stringify({
    summary: 'Fused insight',
    importance: 7,
    category: 'insight',
  });
  return {
    name: 'mock-fusion',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText ?? defaultResponse }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

function seedMemory(
  db: ScallopDatabase,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    importance?: number;
  },
): ScallopMemoryEntry {
  return db.addMemory({
    userId: opts.userId ?? 'default',
    content: opts.content,
    category: opts.category,
    memoryType: 'regular',
    importance: opts.importance ?? 6,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
    learnedFrom: null,
  });
}

function buildCtx(
  store: ScallopMemoryStore,
  db: ScallopDatabase,
  overrides?: Partial<GardenerContext>,
): GardenerContext {
  return {
    scallopStore: store,
    db,
    logger: logger.child({ component: 'gardener' }),
    quietHours: { start: 2, end: 5 },
    disableArchival: false,
    canonicalSingleUserIds: OWNER_ALIASES,
    ...overrides,
  };
}

describe('gardener-deep-steps', () => {
  let store: ScallopMemoryStore;
  let db: ScallopDatabase;

  beforeEach(() => {
    cleanupTestDb();
    store = new ScallopMemoryStore({ dbPath: TEST_DB_PATH, logger });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanupTestDb();
  });

  describe('runFullDecay', () => {
    it('calls processFullDecay and returns result', () => {
      seedMemory(db, { content: 'Test memory', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db);
      const result = runFullDecay(ctx);
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('archived');
    });
  });

  describe('runMemoryFusion', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      const result = await runMemoryFusion(ctx);
      expect(result.totalFused).toBe(0);
      expect(result.totalMerged).toBe(0);
    });

    it('finds clusters, fuses, stores with DERIVES relations', async () => {
      // Create related dormant memories
      const m1 = seedMemory(db, { content: 'Loves hiking in mountains', category: 'preference', prominence: 0.5 });
      const m2 = seedMemory(db, { content: 'Enjoys mountain trails', category: 'preference', prominence: 0.45 });
      // Add relation so they cluster
      db.addRelation(m1.id, m2.id, 'RELATED', 0.8);

      const provider = createMockFusionProvider();
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runMemoryFusion(ctx);

      expect(result.totalFused).toBeGreaterThanOrEqual(1);
      expect(result.totalMerged).toBeGreaterThanOrEqual(2);

      // Verify DERIVES relations were created
      const allMemories = db.getMemoriesByUser('default', { includeAllSources: true });
      const derivedMem = allMemories.find(m => m.memoryType === 'derived');
      expect(derivedMem).toBeDefined();
      if (derivedMem) {
        const relations = db.getRelations(derivedMem.id);
        const derives = relations.filter(r => r.relationType === 'DERIVES');
        expect(derives.length).toBe(2);
      }
    });
  });

  describe('runSessionSummarization', () => {
    it('skips when no sessionSummarizer', async () => {
      const ctx = buildCtx(store, db);
      const result = await runSessionSummarization(ctx);
      expect(result.summarized).toBe(0);
    });

    it('finds old sessions and calls summarizeBatch with resolved userId', async () => {
      // Seed a memory so the user can be resolved
      seedMemory(db, { userId: 'telegram:123', content: 'test', category: 'fact', prominence: 0.5 });

      // Create a session with old updated_at
      const session = db.createSession('old-session-1', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      db.addSessionMessage(session.id, 'user', 'First question');
      db.addSessionMessage(session.id, 'assistant', 'First answer');
      db.addSessionMessage(session.id, 'user', 'Second question');
      db.addSessionMessage(session.id, 'assistant', 'Second answer');
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [twoDaysAgo, session.id]);

      const mockSummarizer = {
        summarizeBatch: vi.fn().mockResolvedValue(1),
        summarize: vi.fn(),
        minimumMessageCount: 4,
      };

      const ctx = buildCtx(store, db, { sessionSummarizer: mockSummarizer as any });
      const result = await runSessionSummarization(ctx);

      expect(mockSummarizer.summarizeBatch).toHaveBeenCalledWith(db, ['old-session-1'], 'default');
      expect(result.summarized).toBe(1);
    });

    it('retries rejected summaries but excludes sessions with a verified receipt', async () => {
      const old = Date.now() - 3 * 60 * 60 * 1000;
      for (const sessionId of ['rejected-summary-session', 'verified-summary-session']) {
        db.createSession(sessionId, { userId: 'default', channelId: 'api' });
        db.addSessionMessage(sessionId, 'user', 'What was the decision?');
        db.addSessionMessage(sessionId, 'assistant', 'The safer rollout was selected.');
        rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [old, sessionId]);
      }
      db.addSessionSummary({
        sessionId: 'rejected-summary-session',
        userId: 'default',
        summary: 'An interim legacy summary without verification.',
        topics: ['decision'],
        messageCount: 2,
        durationMs: 0,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: 'verified-summary-session',
        userId: 'default',
        summary: 'The safer rollout was selected as the final decision.',
        topics: ['decision'],
        messageCount: 2,
        durationMs: 0,
        embedding: null,
      }, {
        verifier: 'session_summarizer',
        verificationVersion: 1,
      });
      const mockSummarizer = {
        summarizeBatch: vi.fn().mockResolvedValue(1),
        minimumMessageCount: 2,
      };

      const result = await runSessionSummarization(buildCtx(store, db, {
        sessionSummarizer: mockSummarizer as any,
      }));

      expect(mockSummarizer.summarizeBatch).toHaveBeenCalledWith(
        db,
        ['rejected-summary-session'],
        'default',
      );
      expect(result.summarized).toBe(1);
    });
  });

  describe('runEnhancedForgetting', () => {
    it('runs audit + archival + prune + orphan cleanup without throwing', async () => {
      seedMemory(db, { content: 'Memory for forgetting test', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db);
      await expect(runEnhancedForgetting(ctx)).resolves.not.toThrow();
    });

    it('skips archival when disableArchival=true', async () => {
      seedMemory(db, { content: 'Test', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db, { disableArchival: true });
      // Should complete without throwing; archival/pruning skipped internally
      await expect(runEnhancedForgetting(ctx)).resolves.not.toThrow();
    });
  });

  describe('runBehavioralInference', () => {
    it('gathers messages and calls inferBehavioralPatterns', () => {
      // Seed a memory so the user is discoverable
      seedMemory(db, { userId: 'telegram:123', content: 'test', category: 'fact', prominence: 0.5 });

      // Create a session with user messages
      const session = db.createSession('session-1', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      db.addSessionMessage(session.id, 'user', 'Hello, how are you?');
      db.addSessionMessage(session.id, 'assistant', 'I am fine!');
      db.addSessionMessage(session.id, 'user', JSON.stringify([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'not a human turn' },
      ]));
      db.addSessionMessage(session.id, 'user', 'Tell me about AI');

      const worker = db.createSession('session-worker', {
        userId: 'telegram:owner-example', channelId: 'telegram', isSubAgent: true,
      });
      db.addSessionMessage(worker.id, 'user', 'Internal worker instruction');

      const ctx = buildCtx(store, db);
      const result = runBehavioralInference(ctx);

      expect(result.messageCount).toBe(2); // Only user messages
    });
  });

  describe('runSubAgentCleanup', () => {
    it('removes old protocol sessions but preserves a compact diagnostic ledger', () => {
      db.createSession('parent', { userId: 'telegram:owner-example' });
      db.createSession('child', { userId: 'telegram:owner-example', isSubAgent: true });
      db.createSession('child-active', { userId: 'telegram:owner-example', isSubAgent: true });
      db.addSessionMessage('child', 'user', 'private task protocol');
      const old = Date.now() - 2 * 60 * 60 * 1000;
      db.insertSubAgentRun({
        id: 'run-old', parentSessionId: 'parent', childSessionId: 'child',
        task: 'private task', label: 'worker', status: 'completed', allowedSkills: 'bash',
        modelTier: 'fast', timeoutMs: 1_000, resultResponse: null,
        resultIterations: null, resultTaskComplete: null, error: null,
        inputTokens: 10, outputTokens: 5, createdAt: old, startedAt: old, completedAt: old,
      });
      db.updateSubAgentRun('run-old', {
        resultResponse: 'private result', resultIterations: 2, resultTaskComplete: true,
      });
      db.insertSubAgentRun({
        id: 'run-active', parentSessionId: 'parent', childSessionId: 'child-active',
        task: 'still running', label: 'worker', status: 'running', allowedSkills: 'bash',
        modelTier: 'fast', timeoutMs: 1_000, resultResponse: null,
        resultIterations: null, resultTaskComplete: null, error: null,
        inputTokens: 1, outputTokens: 0, createdAt: old, startedAt: old, completedAt: null,
      });

      runSubAgentCleanup(buildCtx(store, db), 3600);

      expect(db.getActiveSession('child')).toBeNull();
      expect(db.getSessionMessages('child')).toEqual([]);
      const runs = db.getSubAgentRunsByParent('parent');
      expect(runs.find(run => run.id === 'run-active')).toMatchObject({
        id: 'run-active', task: 'still running',
      });
      expect(runs.find(run => run.id === 'run-old')).toMatchObject({
        id: 'run-old', task: '[compacted]', resultResponse: null,
        resultIterations: 2, resultTaskComplete: true,
        inputTokens: 10, outputTokens: 5,
      });
      expect(db.getActiveSession('child-active')).not.toBeNull();
    });

    it('archives stale empty top-level sessions once and leaves fresh sessions active', () => {
      db.createSession('stale-empty', { userId: 'telegram:owner-example', channelId: 'api' });
      db.createSession('fresh-empty', { userId: 'telegram:owner-example', channelId: 'api' });
      rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [
        Date.now() - 2 * 24 * 60 * 60 * 1000,
        'stale-empty',
      ]);

      const ctx = buildCtx(store, db);
      runSubAgentCleanup(ctx, 3600);
      runSubAgentCleanup(ctx, 3600);

      expect(db.getActiveSession('stale-empty')).toBeNull();
      expect(db.getSession('stale-empty')?.transcriptDeletedAt).toBeNull();
      expect(db.getSessionLifecycleEvents('stale-empty')).toMatchObject([
        { action: 'archived', reason: 'stale_empty_session' },
      ]);
      expect(db.getActiveSession('fresh-empty')).not.toBeNull();
    });
  });

  describe('runTrustScoreUpdate', () => {
    it('computes trust score and updates behavioral patterns', () => {
      // Create sessions with messages for trust computation
      for (let i = 0; i < 6; i++) {
        const session = db.createSession(`trust-session-${i}`);
        for (let j = 0; j < 3; j++) {
          db.addSessionMessage(session.id, 'user', `Message ${j}`);
        }
      }

      const ctx = buildCtx(store, db);
      // Should not throw (returns void)
      expect(() => runTrustScoreUpdate(ctx)).not.toThrow();
    });

    it('adapts repeated ignored proactive sends down to the conservative dial', () => {
      for (let i = 0; i < 6; i++) {
        const session = db.createSession(`ignored-session-${i}`, { userId: 'default' });
        db.addSessionMessage(session.id, 'user', `Question ${i}`);
        db.addSessionMessage(session.id, 'assistant', `Answer ${i}`);
        db.addSessionSummary({
          sessionId: session.id,
          userId: 'default',
          summary: `Synthetic completed conversation ${i} used for trust calibration.`,
          topics: ['trust calibration'],
          messageCount: 2,
          durationMs: 1_000,
          embedding: null,
        });
      }
      for (let i = 0; i < 6; i++) {
        db.addScheduledItem({
          userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
          type: 'follow_up', message: `Ignored synthetic outreach ${i}`, context: null,
          triggerAt: Date.now() - (i + 1) * 60_000, recurring: null,
          sourceMemoryId: null, status: 'fired',
        });
      }

      runTrustScoreUpdate(buildCtx(store, db));

      expect(db.getBehavioralPatterns('default')?.responsePreferences).toMatchObject({
        proactivenessDial: 'conservative',
      });
    });

    it('handles <5 summaries without error', () => {
      // Create sessions with messages but no summaries
      for (let i = 0; i < 3; i++) {
        const session = db.createSession(`raw-session-${i}`);
        for (let j = 0; j < 5; j++) {
          db.addSessionMessage(session.id, 'user', `Hello ${j}`);
          db.addSessionMessage(session.id, 'assistant', `Reply ${j}`);
        }
      }

      const ctx = buildCtx(store, db);
      // Should not throw even with few summaries
      expect(() => runTrustScoreUpdate(ctx)).not.toThrow();
    });
  });

  describe('runGoalDeadlineCheck', () => {
    it('handles no goals gracefully', async () => {
      const ctx = buildCtx(store, db);
      await expect(runGoalDeadlineCheck(ctx)).resolves.not.toThrow();
    });

    it('does not let an expired undelivered reminder consume a deadline stage', async () => {
      const goalService = new GoalService({ db, logger });
      const dueDate = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const goal = await goalService.createGoal('default', {
        title: 'Submit the public release',
        status: 'active',
        dueDate,
      });
      const expired = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'goal_checkin',
        message: 'Goal approaching deadline: Submit the public release — due in 5 days',
        context: JSON.stringify({
          proactiveKind: 'goal_deadline',
          goalId: goal.id,
          dueDate,
          deadlineStage: 'warning',
        }),
        triggerAt: Date.now() - 1,
        recurring: null,
        sourceMemoryId: goal.id,
      });
      db.markScheduledItemExpired(expired.id);

      await runGoalDeadlineCheck(buildCtx(store, db, { getTimezone: () => 'UTC' }));

      const reminders = db.getScheduledItemsByUser('default')
        .filter(item => item.sourceMemoryId === goal.id);
      expect(reminders).toHaveLength(2);
      expect(reminders.some(item => item.status === 'pending')).toBe(true);
    });
  });

  describe('runInnerThoughts', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      await expect(runInnerThoughts(ctx)).resolves.not.toThrow();
    });

    it('only processes users with recent summaries (within 6h)', async () => {
      // Create a session and summary from 12 hours ago
      const session = db.createSession('old-session');
      db.addSessionMessage(session.id, 'user', 'Old message');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-old',
        summary: 'Old summary',
        topics: ['test'],
        messageCount: 1,
        durationMs: 5000,
        embedding: null,
      });
      // Backdate the summary
      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE session_summaries SET created_at = ? WHERE user_id = ?', [twelveHoursAgo, 'user-old']);

      const provider = createMockFusionProvider(JSON.stringify({
        decision: 'proact',
        reason: 'test',
        message: 'Follow up',
        urgency: 'low',
      }));
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      await runInnerThoughts(ctx);

      // Should skip because summary is too old — provider never called
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('catches errors and logs (does not throw)', async () => {
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('LLM down')),
      };

      // Create a recent session summary
      const session = db.createSession('test-session');
      db.addSessionMessage(session.id, 'user', 'Test message');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-fail',
        summary: 'Test summary',
        topics: ['test'],
        messageCount: 1,
        durationMs: 5000,
        embedding: null,
      });

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      // Should not throw
      await expect(runInnerThoughts(ctx)).resolves.not.toThrow();
    });

    it('does not call the evaluator when the user has globally opted out', async () => {
      seedMemory(db, {
        content: "User asked the assistant not to check in or send proactive messages.",
        category: 'preference',
        prominence: 0.9,
      });
      const session = db.createSession('opt-out-session', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'default',
        summary: 'A recent conversation with an open project topic.',
        topics: ['project'],
        messageCount: 4,
        durationMs: 10_000,
        embedding: null,
      });
      const provider = createMockFusionProvider(JSON.stringify({ items: [] }));

      await runInnerThoughts(buildCtx(store, db, { fusionProvider: provider }));

      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('elevates only an unopposed explicit positive preference', async () => {
      seedMemory(db, {
        content: 'User prefers the assistant to be proactive and check in.',
        category: 'preference',
        prominence: 0.9,
      });
      seedMemory(db, {
        content: "Don't remind me about medication.",
        category: 'preference',
        prominence: 0.85,
      });
      const session = db.createSession('scoped-preference-session', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      const summary = db.addSessionSummary({
        sessionId: session.id,
        userId: 'default',
        summary: 'The user will follow up on the project plan.',
        topics: ['project plan'],
        messageCount: 4,
        durationMs: 10_000,
        embedding: null,
      });
      rawRun(db, 'UPDATE session_summaries SET created_at = ? WHERE id = ?', [Date.now() - 3 * 24 * 60 * 60 * 1000, summary.id]);
      const provider = createMockFusionProvider(JSON.stringify({ items: [] }));

      await runInnerThoughts(buildCtx(store, db, { fusionProvider: provider }));

      expect(provider.complete).toHaveBeenCalledTimes(1);
      const request = vi.mocked(provider.complete).mock.calls[0][0];
      expect(String(request.system)).toContain('Proactiveness dial: moderate');
      expect(String(request.system)).not.toContain('Proactiveness dial: eager');
    });

    it('elevates the dial for an explicit positive preference with no negative boundary', async () => {
      seedMemory(db, {
        content: 'User prefers the assistant to be proactive and check in.',
        category: 'preference',
        prominence: 0.9,
      });
      const session = db.createSession('positive-preference-session', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      const summary = db.addSessionSummary({
        sessionId: session.id,
        userId: 'default',
        summary: 'The user will follow up on the project plan.',
        topics: ['project plan'],
        messageCount: 4,
        durationMs: 10_000,
        embedding: null,
      });
      rawRun(db, 'UPDATE session_summaries SET created_at = ? WHERE id = ?', [Date.now() - 3 * 24 * 60 * 60 * 1000, summary.id]);
      const provider = createMockFusionProvider(JSON.stringify({ items: [] }));

      await runInnerThoughts(buildCtx(store, db, { fusionProvider: provider }));

      expect(provider.complete).toHaveBeenCalledTimes(1);
      const request = vi.mocked(provider.complete).mock.calls[0][0];
      expect(String(request.system)).toContain('Proactiveness dial: eager');
    });
  });

  describe('error isolation', () => {
    it('runMemoryFusion catches errors and logs', async () => {
      // Provide a failing provider
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('boom')),
      };

      // Create memories that will cluster
      const m1 = seedMemory(db, { content: 'A', category: 'fact', prominence: 0.5 });
      const m2 = seedMemory(db, { content: 'B', category: 'fact', prominence: 0.45 });
      db.addRelation(m1.id, m2.id, 'RELATED', 0.8);

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      // Should not throw
      await expect(runMemoryFusion(ctx)).resolves.not.toThrow();
    });

    it('runSessionSummarization catches errors and logs', async () => {
      const failingSummarizer = {
        summarizeBatch: vi.fn().mockRejectedValue(new Error('summarizer error')),
        summarize: vi.fn(),
      };

      const session = db.createSession('fail-session', {
        userId: 'telegram:owner-example',
        channelId: 'telegram',
      });
      db.addSessionMessage(session.id, 'user', 'First question');
      db.addSessionMessage(session.id, 'assistant', 'First answer');
      db.addSessionMessage(session.id, 'user', 'Second question');
      db.addSessionMessage(session.id, 'assistant', 'Second answer');
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [twoDaysAgo, session.id]);

      const ctx = buildCtx(store, db, { sessionSummarizer: failingSummarizer as any });
      const result = await runSessionSummarization(ctx);
      expect(result.summarized).toBe(0);
    });

    it('runGoalDeadlineCheck catches errors and does not throw', async () => {
      const ctx = buildCtx(store, db);
      await expect(runGoalDeadlineCheck(ctx)).resolves.not.toThrow();
    });
  });
});
