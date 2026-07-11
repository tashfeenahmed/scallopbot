import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import type { LLMProvider } from '../providers/types.js';
import { getRecentChatContext } from '../proactive/chat-context.js';
import type { ScallopDatabase } from './db.js';
import {
  runBehavioralInference,
  runInnerThoughts,
  runSessionSummarization,
} from './gardener-deep-steps.js';
import type { GardenerContext } from './gardener-context.js';
import { stateIdentityCandidates } from './gardener-context.js';
import { runSelfReflection } from './gardener-sleep-steps.js';
import { ScallopMemoryStore } from './scallop-store.js';

const logger = pino({ level: 'silent' });
const OWNER_ALIASES = ['owner-example', 'telegram:owner-example'] as const;

function runSql(db: ScallopDatabase, sql: string, params: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db.prepare(sql).run(...params);
}

function makeProvider(response: string): LLMProvider {
  return {
    name: 'synthetic-provider',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: response }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'synthetic-model',
    }),
  };
}

describe('gardener multi-user privacy', () => {
  let dbPath: string;
  let workspace: string;
  let store: ScallopMemoryStore;
  let db: ScallopDatabase;

  beforeEach(async () => {
    workspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gardener-privacy-'));
    dbPath = path.join(workspace, 'state.db');
    store = new ScallopMemoryStore({ dbPath, logger });
    db = store.getDatabase();
  });

  afterEach(async () => {
    store.close();
    await fsPromises.rm(workspace, { recursive: true, force: true });
  });

  function context(overrides: Partial<GardenerContext> = {}): GardenerContext {
    return {
      scallopStore: store,
      db,
      logger,
      quietHours: { start: 2, end: 5 },
      disableArchival: false,
      canonicalSingleUserIds: OWNER_ALIASES,
      ...overrides,
    };
  }

  function createSession(id: string, userId?: string): void {
    db.createSession(id, userId ? { userId, channelId: 'telegram' } : undefined);
  }

  it('groups summaries and behavioral inference by state owner and scopes default chat aliases', async () => {
    createSession('owner-session', 'telegram:owner-example');
    createSession('beta-session', 'telegram:user-beta');
    createSession('missing-owner-session');
    db.addSessionMessage(
      'owner-session',
      'user',
      'Synthetic owner work uses TypeScript on Project Juniper.',
    );
    db.addSessionMessage(
      'beta-session',
      'user',
      'Synthetic beta work uses Kubernetes on Project Magnolia.',
    );
    db.addSessionMessage(
      'missing-owner-session',
      'user',
      'Ambiguous session text must be skipped.',
    );
    const old = Date.now() - 3 * 60 * 60 * 1000;
    runSql(db, 'UPDATE sessions SET updated_at = ?', [old]);

    const summarizer = {
      summarizeBatch: vi.fn(async (
        database: ScallopDatabase,
        sessionIds: string[],
        userId: string,
      ) => {
        for (const sessionId of sessionIds) {
          const first = database.getSessionMessages(sessionId)[0];
          database.addSessionSummary({
            sessionId,
            userId,
            summary: `Summary: ${first.content}`,
            topics: ['synthetic'],
            messageCount: 4,
            durationMs: 1_000,
            embedding: null,
          });
        }
        return sessionIds.length;
      }),
    };

    const result = await runSessionSummarization(context({
      sessionSummarizer: summarizer as unknown as NonNullable<GardenerContext['sessionSummarizer']>,
    }));

    expect(result.summarized).toBe(2);
    expect(db.getSessionSummariesByUser('default').map(summary => summary.summary))
      .toEqual(['Summary: Synthetic owner work uses TypeScript on Project Juniper.']);
    expect(db.getSessionSummariesByUser('telegram:user-beta').map(summary => summary.summary))
      .toEqual(['Summary: Synthetic beta work uses Kubernetes on Project Magnolia.']);
    expect(db.getSessionSummary('missing-owner-session')).toBeNull();

    const behavior = runBehavioralInference(context());
    expect(behavior.messageCount).toBe(2);
    expect(db.getBehavioralPatterns('default')?.expertiseAreas).toContain('typescript');
    expect(db.getBehavioralPatterns('default')?.expertiseAreas).not.toContain('kubernetes');
    expect(db.getBehavioralPatterns('telegram:user-beta')?.expertiseAreas).toContain('kubernetes');
    expect(db.getBehavioralPatterns('telegram:user-beta')?.expertiseAreas).not.toContain('typescript');

    expect(db.getRecentMessagesByUserId('default', 20)).toEqual([]);
    const candidates = stateIdentityCandidates('default', OWNER_ALIASES);
    const ownerChat = getRecentChatContext(db, 'default', {
      identityCandidates: candidates,
      stalenessMs: 24 * 60 * 60 * 1000,
    });
    expect(ownerChat?.formattedContext).toContain('Project Juniper');
    expect(ownerChat?.formattedContext).not.toContain('Project Magnolia');
    expect(ownerChat?.formattedContext).not.toContain('Ambiguous session text');
  });

  it('keeps foreign summaries out of proactive items and global SOUL reflection', async () => {
    createSession('owner-thread', 'telegram:owner-example');
    createSession('beta-thread', 'telegram:user-beta');
    createSession('legacy-polluted-thread', 'telegram:user-beta');
    db.addSessionMessage(
      'owner-thread',
      'user',
      'Project Juniper still needs a synthetic next-step outline.',
    );
    db.addSessionMessage(
      'beta-thread',
      'user',
      'Project Magnolia contains private synthetic beta details.',
    );

    const ownerSummary = db.addSessionSummary({
      sessionId: 'owner-thread',
      userId: 'default',
      summary: 'The user asked the assistant to follow up on Project Juniper tomorrow.',
      topics: ['Project Juniper'],
      messageCount: 5,
      durationMs: 10_000,
      embedding: null,
    });
    const betaSummary = db.addSessionSummary({
      sessionId: 'beta-thread',
      userId: 'telegram:user-beta',
      summary: 'The beta user asked to follow up on private Project Magnolia details.',
      topics: ['Project Magnolia'],
      messageCount: 5,
      durationMs: 10_000,
      embedding: null,
    });
    const pollutedSummary = db.addSessionSummary({
      sessionId: 'legacy-polluted-thread',
      userId: 'default',
      summary: 'Legacy pollution contains private Project Magnolia beta details.',
      topics: ['Project Magnolia'],
      messageCount: 5,
      durationMs: 10_000,
      embedding: null,
    });
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    runSql(
      db,
      'UPDATE session_summaries SET created_at = ? WHERE id IN (?, ?, ?)',
      [threeDaysAgo, ownerSummary.id, betaSummary.id, pollutedSummary.id],
    );

    const proactiveProvider = makeProvider(JSON.stringify({
      items: [{
        index: 1,
        action: 'nudge',
        userFacingMessage: 'Would a quick next-step outline help with the Juniper plan?',
        urgency: 'low',
      }],
    }));
    await runInnerThoughts(context({ fusionProvider: proactiveProvider }));

    expect(proactiveProvider.complete).toHaveBeenCalledTimes(1);
    const proactivePrompt = JSON.stringify(vi.mocked(proactiveProvider.complete).mock.calls[0][0]);
    expect(proactivePrompt).toContain('Project Juniper');
    expect(proactivePrompt).not.toContain('Project Magnolia');
    const ownerItems = db.getScheduledItemsByUser('default');
    expect(ownerItems).toHaveLength(1);
    expect(ownerItems[0]).toMatchObject({
      userId: 'default',
      sessionId: 'owner-thread',
    });
    expect(ownerItems[0].message).not.toContain('Magnolia');

    const disabledProvider = makeProvider(JSON.stringify({ items: [] }));
    await runInnerThoughts(context({
      fusionProvider: disabledProvider,
      canonicalSingleUserIds: [],
    }));
    expect(disabledProvider.complete).not.toHaveBeenCalled();

    const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
    runSql(
      db,
      'UPDATE session_summaries SET created_at = ? WHERE id IN (?, ?, ?)',
      [twelveHoursAgo, ownerSummary.id, betaSummary.id, pollutedSummary.id],
    );

    const reflectionProvider: LLMProvider = {
      name: 'synthetic-reflection',
      isAvailable: () => true,
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: [{
            type: 'text',
            text: JSON.stringify({
              insights: [{ content: 'Use concrete roadmap next steps.', topics: ['planning'] }],
              principles: ['Keep project guidance concrete.'],
            }),
          }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'synthetic-model',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '# Synthetic Guidance\n\nKeep roadmap guidance concrete.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'synthetic-model',
        }),
    };
    await runSelfReflection(context({
      fusionProvider: reflectionProvider,
      workspace,
    }));

    expect(reflectionProvider.complete).toHaveBeenCalledTimes(2);
    const reflectionPrompts = JSON.stringify(vi.mocked(reflectionProvider.complete).mock.calls);
    expect(reflectionPrompts).toContain('Project Juniper');
    expect(reflectionPrompts).not.toContain('Project Magnolia');
    const soul = await fsPromises.readFile(path.join(workspace, 'SOUL.md'), 'utf8');
    expect(soul).toContain('Synthetic Guidance');
    expect(soul).not.toContain('Magnolia');
    expect(db.getMemoriesByUser('default', { includeAllSources: true })
      .filter(memory => memory.learnedFrom === 'self_reflection')
      .every(memory => !memory.content.includes('Magnolia'))).toBe(true);

    const blockedWorkspace = path.join(workspace, 'blocked-reflection');
    const blockedReflection = makeProvider('{}');
    await runSelfReflection(context({
      fusionProvider: blockedReflection,
      workspace: blockedWorkspace,
      canonicalSingleUserIds: [],
    }));
    expect(blockedReflection.complete).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(blockedWorkspace, 'SOUL.md'))).toBe(false);
  });
});
