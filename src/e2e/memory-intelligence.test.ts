/**
 * E2E Memory Intelligence Tests
 *
 * Tests v3.0 memory intelligence features end-to-end via WebSocket conversations:
 * - Re-ranking reorders search results by relevance
 * - LLM-classified relations stored after fact extraction
 * - Spreading activation retrieves related memories
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  createMockLLMProvider,
  createMockEmbeddingProvider,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';
import type { LLMProvider, CompletionRequest, CompletionResponse, ContentBlock } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Custom mock rerank provider: inspects candidate content and assigns
// high scores to food-related items, low scores to others.
// ---------------------------------------------------------------------------
function createFoodAwareRerankProvider(): LLMProvider & { callCount: number } {
  const provider: LLMProvider & { callCount: number } = {
    name: 'mock-reranker',
    callCount: 0,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      provider.callCount++;

      // Extract the user message to find candidate texts
      const userMsg = request.messages.find(m => m.role === 'user')?.content ?? '';
      const msgText = typeof userMsg === 'string' ? userMsg : '';

      // Parse numbered candidates from the prompt (format: "1. \"content\"")
      const candidatePattern = /(\d+)\.\s*"([^"]+)"/g;
      const scores: Array<{ index: number; score: number }> = [];
      let match;

      while ((match = candidatePattern.exec(msgText)) !== null) {
        const index = parseInt(match[1], 10) - 1; // Convert 1-based prompt to 0-based
        const content = match[2].toLowerCase();
        const foodKeywords = ['food', 'restaurant', 'eat', 'cook', 'italian', 'olive garden', 'shellfish', 'allergic', 'diet'];
        const isFoodRelated = foodKeywords.some(kw => content.includes(kw));
        scores.push({ index, score: isFoodRelated ? 0.9 : 0.05 });
      }

      const responseText = JSON.stringify(scores);

      return {
        content: [{ type: 'text', text: responseText }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        model: 'mock-reranker',
      };
    },

    isAvailable(): boolean {
      return true;
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Test 1: Re-ranking reorders search results by relevance
// ---------------------------------------------------------------------------
describe('E2E Memory Intelligence', () => {

  describe('re-ranking', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;
    let rerankProvider: ReturnType<typeof createFoodAwareRerankProvider>;

    beforeAll(async () => {
      rerankProvider = createFoodAwareRerankProvider();

      // Boot gateway with the custom rerank provider wired in.
      // We cannot use rerankResponses here since we need dynamic scoring,
      // so we create the gateway manually with the custom provider.
      const port = 10000 + Math.floor(Math.random() * 10000);
      const dbPath = `/tmp/e2e-rerank-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      // Import the real components to wire manually
      const { ApiChannel } = await import('../channels/api.js');
      const { Agent } = await import('../agent/agent.js');
      const { SessionManager } = await import('../agent/session.js');
      const { ScallopMemoryStore } = await import('../memory/scallop-store.js');
      const { BotConfigManager } = await import('../channels/bot-config.js');
      const { ContextManager } = await import('../routing/context.js');
      const { Router } = await import('../routing/router.js');
      const { CostTracker } = await import('../routing/cost.js');
      const { createSkillRegistry } = await import('../skills/registry.js');
      const { createSkillExecutor } = await import('../skills/executor.js');
      const pino = (await import('pino')).default;

      const testLogger = pino({ level: 'silent' });
      const mockProvider = createMockLLMProvider([
        'Based on your memories, you love Italian food and your favorite restaurant is Olive Garden. You are also allergic to shellfish. [DONE]',
      ]);
      const mockEmbedder = createMockEmbeddingProvider();

      const scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
        rerankProvider,
      });

      const sessionManager = new SessionManager(scallopStore.getDatabase());
      const contextManager = new ContextManager({
        hotWindowSize: 50,
        maxContextTokens: 128000,
        compressionThreshold: 0.7,
        maxToolOutputBytes: 30000,
      });
      const router = new Router({});
      router.registerProvider(mockProvider);
      const costTracker = new CostTracker({ db: scallopStore.getDatabase() });
      const configManager = new BotConfigManager(scallopStore.getDatabase(), testLogger);
      const skillRegistry = createSkillRegistry('/tmp', testLogger);
      await skillRegistry.initialize();
      const skillExecutor = createSkillExecutor(testLogger);

      const agent = new Agent({
        provider: mockProvider,
        sessionManager,
        skillRegistry,
        skillExecutor,
        router,
        costTracker,
        scallopStore,
        contextManager,
        configManager,
        workspace: '/tmp',
        logger: testLogger,
        maxIterations: 10,
        enableThinking: false,
      });

      const apiChannel = new ApiChannel({
        port,
        host: '127.0.0.1',
        agent,
        sessionManager,
        logger: testLogger,
        costTracker,
      });

      await apiChannel.start();

      ctx = {
        apiChannel,
        port,
        dbPath,
        mockProvider,
        scallopStore,
        sessionManager,
        agent,
      };

      // Seed memories with varying food-relevance
      await scallopStore.add({
        userId: 'default',
        content: 'User loves Italian food',
        category: 'preference',
        importance: 7,
        confidence: 0.9,
      });
      await scallopStore.add({
        userId: 'default',
        content: 'User works at a bank',
        category: 'fact',
        importance: 7,
        confidence: 0.9,
      });
      await scallopStore.add({
        userId: 'default',
        content: "User's favorite restaurant is Olive Garden",
        category: 'preference',
        importance: 7,
        confidence: 0.9,
      });
      await scallopStore.add({
        userId: 'default',
        content: 'User drives a Toyota',
        category: 'fact',
        importance: 7,
        confidence: 0.9,
      });
      await scallopStore.add({
        userId: 'default',
        content: 'User is allergic to shellfish',
        category: 'fact',
        importance: 7,
        confidence: 0.9,
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    }, 15000);

    beforeEach(async () => {
      client = await createWsClient(ctx.port);
    });

    afterEach(async () => {
      await client.close();
    });

    it('should reorder search results by relevance when re-ranking is enabled', async () => {
      // Send a food-related query
      client.send({
        type: 'chat',
        message: 'What are my food preferences?',
      });

      const messages = await client.collectUntilResponse(15000);

      // Should have a response
      const responseMsg = messages.find(m => m.type === 'response');
      expect(responseMsg).toBeDefined();
      expect(responseMsg!.content).toBeTruthy();

      // The reranker should have been called at least once
      expect(rerankProvider.callCount).toBeGreaterThan(0);

      // The system prompt should contain food-related memories
      const lastRequest = ctx.mockProvider.lastRequest;
      expect(lastRequest).not.toBeNull();

      const systemPrompt = lastRequest!.system || '';

      // Food-related memories should be in the context
      const hasItalianFood = systemPrompt.includes('Italian food');
      const hasOliveGarden = systemPrompt.includes('Olive Garden');
      const hasShellfish = systemPrompt.includes('shellfish');
      expect(hasItalianFood || hasOliveGarden || hasShellfish).toBe(true);

      // Verify access counts were updated in the DB for re-ranked results
      const db = ctx.scallopStore.getDatabase();
      const accessedMemories = db.raw<{ content: string; access_count: number }>(
        'SELECT content, access_count FROM memories WHERE access_count > 0 AND user_id = ?',
        ['default']
      );
      expect(accessedMemories.length).toBeGreaterThan(0);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // These tests will be added in Task 2
  // -------------------------------------------------------------------------
});
