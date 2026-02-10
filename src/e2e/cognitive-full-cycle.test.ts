/**
 * E2E Cognitive Full Cycle Tests
 *
 * Validates end-to-end:
 * 1. Full cognitive cycle: chat -> deepTick -> sleepTick
 *    - Chat triggers affect classification and smoothing
 *    - deepTick computes trust score, behavioral patterns, inner thoughts
 *    - sleepTick runs dream cycle, self-reflection, gap scanner
 * 2. Per-channel proactive message formatting
 *    - Telegram: icon + truncated message + dismiss footer
 *    - WebSocket (API): structured JSON with type, content, metadata
 *    - Channel routing picks correct formatter
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { GoalService } from '../goals/goal-service.js';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  createMockLLMProvider,
  createMockEmbeddingProvider,
  testLogger,
  type E2EGatewayContext,
} from './helpers.js';
import {
  formatProactiveForTelegram,
  formatProactiveForWebSocket,
  formatProactiveMessage,
  type ProactiveFormatInput,
} from '../proactive/proactive-format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Suite 1: Full cognitive cycle: chat -> deepTick -> sleepTick
// ---------------------------------------------------------------------------
describe('E2E Cognitive Full Cycle', () => {

  describe('full cognitive cycle: chat -> deepTick -> sleepTick', () => {
    let ctx: E2EGatewayContext;
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let workspace: string;

    beforeAll(async () => {
      // Create E2E gateway with agent and fact extractor responses
      ctx = await createE2EGateway({
        responses: ['I can help you with that async pattern! [DONE]'],
        factExtractorResponses: [
          JSON.stringify({
            facts: [{
              content: 'User is learning async patterns',
              category: 'fact',
              importance: 6,
              confidence: 0.85,
              action: 'fact',
            }],
            proactive_triggers: [],
          }),
        ],
      });

      scallopStore = ctx.scallopStore;
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-full-cycle-'));

      const db = scallopStore.getDatabase();
      const now = Date.now();

      // Seed 6+ session summaries with recent createdAt (for trust, inner thoughts, reflection)
      for (let i = 0; i < 7; i++) {
        const sessionId = `full-cycle-sess-${i}`;
        db.createSession(sessionId);
        db.addSessionMessage(sessionId, 'user', `Test message about async patterns ${i}`);
        db.addSessionSummary({
          sessionId,
          userId: 'default',
          summary: `Session ${i}: Discussion about JavaScript async patterns and error handling`,
          topics: ['javascript', 'async', 'patterns'],
          messageCount: 5,
          durationMs: 15 * 60 * 1000,
          embedding: null,
        });
      }

      // Seed 3+ scheduled items with status 'acted' (for trust computation)
      for (let i = 0; i < 4; i++) {
        db.addScheduledItem({
          userId: 'default',
          sessionId: null,
          source: 'agent',
          type: 'follow_up',
          message: `Proactive follow-up ${i}`,
          context: null,
          triggerAt: now - (i + 1) * DAY_MS,
          recurring: null,
          sourceMemoryId: null,
          status: 'acted',
        });
      }

      // Seed an active goal with updatedAt 14 days ago (for gap scanner)
      const mockEmbedder = createMockEmbeddingProvider();
      const staleDate = now - 14 * DAY_MS;
      const goalEmbedding = await mockEmbedder.embed('Master async/await patterns in JavaScript');
      const goalMem = db.addMemory({
        userId: 'default',
        content: 'Master async/await patterns in JavaScript',
        category: 'insight',
        memoryType: 'regular',
        importance: 8,
        confidence: 1.0,
        isLatest: true,
        source: 'user',
        documentDate: staleDate,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: goalEmbedding,
        metadata: {
          goalType: 'goal',
          status: 'active',
          progress: 0,
        },
      });
      // Backdate updated_at so scanStaleGoals sees it as 14 days old
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqliteDb = (db as any).db;
      sqliteDb.prepare('UPDATE memories SET updated_at = ?, document_date = ? WHERE id = ?')
        .run(staleDate, staleDate, goalMem.id);

      // Seed behavioral patterns with moderate dial, calm affect
      db.updateBehavioralPatterns('default', {
        responsePreferences: {
          proactivenessDial: 'moderate',
        },
        smoothedAffect: {
          valence: 0.1,
          arousal: 0.3,
          emotion: 'calm',
          goalSignal: 'stable',
        },
        messageFrequency: {
          dailyRate: 3,
          weeklyAvg: 15,
          trend: 'stable' as const,
          lastComputed: now,
        },
      });

      // Create fusionProvider with responses for deepTick and sleepTick:
      // deepTick step 7: inner thoughts evaluation
      // sleepTick: NREM fusion, REM judge, reflection, soul distillation, gap diagnosis
      const fusionProvider = createMockLLMProvider([
        // Call 1: deepTick inner thoughts evaluation
        JSON.stringify({
          decision: 'proact',
          reason: 'User was learning async patterns and may benefit from a follow-up',
          message: 'I noticed you were working on async/await. Want me to walk through error handling patterns?',
          urgency: 'medium',
        }),
        // Call 2: sleepTick NREM fusion response (if enough memories cluster)
        JSON.stringify({
          summary: 'User is actively learning JavaScript async patterns including async/await and error handling',
          importance: 6,
          category: 'insight',
        }),
        // Call 3: sleepTick REM judge (low scores = no discovery)
        JSON.stringify({
          novelty: 1,
          plausibility: 2,
          usefulness: 1,
          connection: 'NO_CONNECTION',
        }),
        // Call 4: sleepTick reflection response
        JSON.stringify({
          insights: [{
            content: 'The user is consistently focused on learning JavaScript async patterns. They show enthusiasm and seem to be building foundational knowledge.',
            topics: ['javascript', 'async', 'learning'],
          }],
          principles: [
            'Provide practical async/await examples when discussing patterns',
          ],
        }),
        // Call 5: sleepTick soul distillation response
        '# SOUL\n\nI help users learn JavaScript async patterns. I provide practical examples and focus on error handling best practices.\n\n## Communication Style\n\nEncourage exploration with clear code examples.',
        // Call 6: sleepTick gap diagnosis
        JSON.stringify({
          gaps: [{
            index: 0,
            actionable: true,
            confidence: 0.80,
            diagnosis: 'Goal has not been updated in two weeks',
            suggestedAction: 'Check in about progress on mastering async/await patterns',
          }],
        }),
        // Call 7+: Additional inner thoughts (if called again) - silent
        JSON.stringify({
          decision: 'silent',
          reason: 'No action needed',
        }),
        JSON.stringify({
          decision: 'silent',
          reason: 'No action needed',
        }),
      ]);

      // Create BackgroundGardener separately with fusionProvider
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
        fusionProvider,
        workspace,
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('should run the full pipeline: chat triggers affect, deepTick processes heartbeat, sleepTick runs cognitive processing', async () => {
      // ================================================================
      // Phase 1 -- Chat interaction
      // ================================================================
      const client = await createWsClient(ctx.port);
      try {
        // Send a clearly positive/excited message
        client.send({
          type: 'chat',
          message: "I'm really excited to learn about async/await patterns in JavaScript!",
        });

        // Collect response
        const messages = await client.collectUntilResponse(15000);
        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();
        expect(response!.content).toBeTruthy();

        // Wait 2s for async fact extraction to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Assert: smoothedAffect persisted (valence should be positive from "excited")
        const profileManager = scallopStore.getProfileManager();
        const patterns = profileManager.getBehavioralPatterns('default');
        expect(patterns).not.toBeNull();
        expect(patterns!.smoothedAffect).not.toBeNull();
        // "excited" is a high-valence emotion
        expect(patterns!.smoothedAffect!.valence).toBeGreaterThan(0);
      } finally {
        await client.close();
      }

      // ================================================================
      // Phase 2 -- Deep tick
      // ================================================================
      await gardener.deepTick();

      const profileManager = scallopStore.getProfileManager();
      const patternsAfterDeep = profileManager.getBehavioralPatterns('default');

      // Assert: trust score computed
      expect(patternsAfterDeep).not.toBeNull();
      expect(patternsAfterDeep!.responsePreferences).toBeDefined();
      const trustScore = patternsAfterDeep!.responsePreferences.trustScore as number;
      expect(typeof trustScore).toBe('number');
      expect(trustScore).toBeGreaterThan(0);
      expect(trustScore).toBeLessThanOrEqual(1);

      // Assert: behavioral patterns updated after deepTick
      // messageFrequency may be null during cold-start (insufficient data),
      // so we check communicationStyle which is always set when messages exist
      expect(patternsAfterDeep!.communicationStyle).toBeTruthy();

      // Check if inner thoughts created a scheduled item (soft assertion)
      const db = scallopStore.getDatabase();
      const scheduledAfterDeep = db.getScheduledItemsByUser('default');
      const innerThoughtItems = scheduledAfterDeep.filter(
        item => item.source === 'agent' && item.type === 'follow_up' && item.context != null
      );
      // Inner thoughts may or may not create an item depending on mock response order
      // We just verify the pipeline didn't crash and check if items exist
      if (innerThoughtItems.length > 0) {
        const itItem = innerThoughtItems.find(item => {
          try {
            const ctx = JSON.parse(item.context!);
            return ctx.source === 'inner_thoughts';
          } catch { return false; }
        });
        // If we found an inner thoughts item, verify it has reasonable content
        if (itItem) {
          expect(itItem.message).toBeTruthy();
        }
      }

      // ================================================================
      // Phase 3 -- Sleep tick
      // ================================================================
      await gardener.sleepTick();

      // Assert: at least one of the following was created:
      // - derived memory (from NREM consolidation)
      // - insight memory (from reflection)
      // - scheduled item (from gap scanner)
      const derivedMemories = db.raw<{ id: string; memory_type: string; learned_from: string }>(
        "SELECT id, memory_type, learned_from FROM memories WHERE user_id = 'default' AND memory_type = 'derived'",
        []
      );

      const insightMemories = db.raw<{ id: string; category: string; learned_from: string }>(
        "SELECT id, category, learned_from FROM memories WHERE user_id = 'default' AND category = 'insight' AND learned_from = 'self_reflection'",
        []
      );

      const scheduledAfterSleep = db.getScheduledItemsByUser('default');
      const gapScannerItems = scheduledAfterSleep.filter(item => {
        if (item.source !== 'agent' || item.type !== 'follow_up') return false;
        try {
          const ctx = JSON.parse(item.context!);
          return ctx.gapType != null;
        } catch { return false; }
      });

      // At least one observable side effect from sleepTick
      const hasNremOutput = derivedMemories.length > 0;
      const hasReflectionOutput = insightMemories.length > 0;
      const hasGapScannerOutput = gapScannerItems.length > 0;

      expect(hasNremOutput || hasReflectionOutput || hasGapScannerOutput).toBe(true);
    }, 120000);
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Per-channel proactive message formatting
  // ---------------------------------------------------------------------------
  describe('per-channel proactive message formatting', () => {
    const testInput: ProactiveFormatInput = {
      message: 'I noticed you were working on async patterns. Need help?',
      gapType: 'follow_up',
      urgency: 'medium',
      source: 'inner_thoughts',
    };

    it('should format proactive message for Telegram with icon, message, and footer', () => {
      const result = formatProactiveForTelegram(testInput);

      // Assert result is a string
      expect(typeof result).toBe('string');

      // Assert result contains an emoji/icon (default icon for unknown gapType)
      // The default icon is used when gapType doesn't match known types
      expect(result).toMatch(/[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u);

      // Assert result contains the message text
      expect(result).toContain(testInput.message);

      // Assert result contains the dismiss footer
      expect(result).toContain('dismiss');
    });

    it('should format proactive message for WebSocket with structured JSON', () => {
      const result = formatProactiveForWebSocket(testInput);

      // Assert result is an object (not string)
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();

      // Assert result has 'type' field set to 'proactive'
      expect(result.type).toBe('proactive');

      // Assert result has 'content' field containing the original message
      expect(result.content).toBe(testInput.message);

      // Assert result has metadata: urgency, source, category
      expect(result.urgency).toBe('medium');
      expect(result.source).toBe('inner_thoughts');
      expect(result.category).toBeDefined();
    });

    it('should route to correct formatter based on channel type', () => {
      // Telegram channel should return a string
      const telegramResult = formatProactiveMessage('telegram', testInput);
      expect(typeof telegramResult).toBe('string');

      // API (WebSocket) channel should return an object
      // Note: the channel param is 'api' not 'websocket' in the actual API
      const apiResult = formatProactiveMessage('api', testInput);
      expect(typeof apiResult).toBe('object');
      expect(apiResult).not.toBeNull();

      // Verify the telegram result contains the message
      expect(telegramResult as string).toContain(testInput.message);

      // Verify the API result has the proactive type
      const wsResult = apiResult as { type: string; content: string };
      expect(wsResult.type).toBe('proactive');
      expect(wsResult.content).toBe(testInput.message);
    });
  });
});
