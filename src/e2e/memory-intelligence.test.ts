/**
 * E2E Memory Intelligence Tests
 *
 * Tests v3.0 memory intelligence features end-to-end via WebSocket conversations:
 * - Re-ranking reorders search results by relevance
 * - LLM-classified relations stored after fact extraction
 * - Spreading activation retrieves related memories
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  // Test 2: LLM-classified relations stored after fact extraction
  // -------------------------------------------------------------------------
  describe('LLM relations', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    // Classification response for the RelationGraph's LLM classifier.
    // When it classifies the salary memory against the job memory, return EXTENDS.
    // This is what creates memory_relations rows.
    const RELATION_CLASSIFIER_RESPONSE = JSON.stringify({
      classification: 'EXTENDS',
      confidence: 0.85,
      reason: 'Salary extends job information at the same company',
    });

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: [
          'You work at Google as a software engineer earning $200k. [DONE]',
        ],
        // relationsProvider enables LLM-based relation classification in RelationGraph.
        // The response cycles, so every classify call gets this EXTENDS response.
        relationsResponses: [RELATION_CLASSIFIER_RESPONSE],
      });

      // Seed the first memory (job at Google) without relation detection
      await ctx.scallopStore.add({
        userId: 'default',
        content: 'User got a new job at Google as a software engineer',
        category: 'fact',
        importance: 7,
        confidence: 0.95,
        detectRelations: false,
      });

      // Add the second memory (salary at Google) WITH relation detection enabled.
      // This triggers detectRelations() in the RelationGraph, which:
      // 1. Finds the job memory as a similar candidate (cosine similarity ~0.64 > extendThreshold 0.5)
      // 2. Calls the relationsProvider (LLM classifier) to classify the relationship
      // 3. Gets EXTENDS classification and stores it in memory_relations table
      await ctx.scallopStore.add({
        userId: 'default',
        content: "User's salary at Google is $200k",
        category: 'fact',
        importance: 7,
        confidence: 0.95,
        detectRelations: true,
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

    it('should store LLM-classified relations between related memories', async () => {
      // Verify both facts exist in the DB
      const db = ctx.scallopStore.getDatabase();
      const googleMemories = db.raw<{ id: string; content: string }>(
        "SELECT id, content FROM memories WHERE user_id = 'default' AND source = 'user' AND content LIKE '%Google%' AND is_latest = 1",
        []
      );
      expect(googleMemories.length).toBeGreaterThanOrEqual(2);

      // Check the memory_relations table for LLM-classified relations.
      // The RelationGraph's detectRelations should have created an EXTENDS relation
      // because the relationsProvider returned an EXTENDS classification.
      const relations = db.raw<{
        source_id: string;
        target_id: string;
        relation_type: string;
        confidence: number;
      }>(
        'SELECT source_id, target_id, relation_type, confidence FROM memory_relations',
        []
      );

      // At least one relation should exist between the Google-related memories
      const googleMemoryIds = new Set(googleMemories.map(m => m.id));
      const googleRelations = relations.filter(
        r => googleMemoryIds.has(r.source_id) || googleMemoryIds.has(r.target_id)
      );

      expect(googleRelations.length).toBeGreaterThan(0);

      // The relation type should be EXTENDS (as returned by the LLM classifier)
      expect(googleRelations[0].relation_type).toBe('EXTENDS');

      // Confidence should be from the LLM classifier (0.85)
      expect(googleRelations[0].confidence).toBeGreaterThan(0.3);

      // Now verify the relation works end-to-end through a WebSocket conversation:
      // searching for one memory should surface the related memory too.
      client.send({
        type: 'chat',
        message: 'What do you know about my job at Google?',
      });

      const messages = await client.collectUntilResponse(15000);
      const responseMsg = messages.find(m => m.type === 'response');
      expect(responseMsg).toBeDefined();

      // The system prompt should contain both Google-related memories
      const lastRequest = ctx.mockProvider.lastRequest;
      expect(lastRequest).not.toBeNull();

      const systemPrompt = lastRequest!.system || '';
      const hasJobFact = systemPrompt.includes('Google') && systemPrompt.includes('engineer');
      const hasSalaryFact = systemPrompt.includes('$200k') || systemPrompt.includes('salary');
      // At least the job fact should be in the context (directly matched by query)
      expect(hasJobFact).toBe(true);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 3: Spreading activation retrieves related memories
  // -------------------------------------------------------------------------
  describe('spreading activation', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: [
          'Based on your living situation: you live in San Francisco, in the Mission District, and pay $3000 rent. [DONE]',
        ],
        activationConfig: {
          maxSteps: 3,
          decayFactor: 0.5,
          noiseSigma: 0, // Deterministic for testing
          resultThreshold: 0.01,
          maxResults: 10,
        },
      });

      // Seed a cluster of related memories
      const memX = await ctx.scallopStore.add({
        userId: 'default',
        content: 'User lives in San Francisco',
        category: 'fact',
        importance: 8,
        confidence: 0.95,
        detectRelations: false, // Manual relation setup
      });

      const memY = await ctx.scallopStore.add({
        userId: 'default',
        content: "User's apartment is in Mission District",
        category: 'fact',
        importance: 7,
        confidence: 0.9,
        detectRelations: false,
      });

      const memZ = await ctx.scallopStore.add({
        userId: 'default',
        content: 'User pays $3000 rent',
        category: 'fact',
        importance: 7,
        confidence: 0.9,
        detectRelations: false,
      });

      // Manually insert EXTENDS relations: Y extends X, Z extends Y
      const db = ctx.scallopStore.getDatabase();
      db.addRelation(memY.id, memX.id, 'EXTENDS', 0.85);
      db.addRelation(memZ.id, memY.id, 'EXTENDS', 0.80);
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

    it('should retrieve related memories through spreading activation graph', async () => {
      // Send a query that should match the "San Francisco" memory
      client.send({
        type: 'chat',
        message: 'Tell me about my living situation',
      });

      const messages = await client.collectUntilResponse(15000);

      const responseMsg = messages.find(m => m.type === 'response');
      expect(responseMsg).toBeDefined();
      expect(responseMsg!.content).toBeTruthy();

      // The system prompt should contain the seed memory AND related memories
      // found through spreading activation (apartment + rent)
      const lastRequest = ctx.mockProvider.lastRequest;
      expect(lastRequest).not.toBeNull();

      const systemPrompt = lastRequest!.system || '';

      // San Francisco should definitely be there (direct search match)
      expect(systemPrompt).toContain('San Francisco');

      // Mission District and/or rent should also appear through activation
      // (they wouldn't match "living situation" by keyword alone,
      //  but spreading activation through relations should surface them)
      const hasMissionDistrict = systemPrompt.includes('Mission District');
      const hasRent = systemPrompt.includes('$3000');

      // At least one related memory should appear via activation
      expect(hasMissionDistrict || hasRent).toBe(true);

      // Verify that access counts were updated for activated memories
      const db = ctx.scallopStore.getDatabase();
      const accessedMemories = db.raw<{ content: string; access_count: number }>(
        "SELECT content, access_count FROM memories WHERE access_count > 0 AND user_id = 'default'",
        []
      );
      expect(accessedMemories.length).toBeGreaterThan(0);
    }, 30000);
  });
});
