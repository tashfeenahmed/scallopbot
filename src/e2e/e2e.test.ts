/**
 * E2E WebSocket Integration Tests
 *
 * Tests the full pipeline: WebSocket client -> ApiChannel -> Agent -> Mock LLM
 * with real SQLite database, real SessionManager, and real memory system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';

// Fact extraction JSON that the mock LLM returns when used as fact extractor
const FACT_EXTRACTION_RESPONSE = JSON.stringify({
  facts: [
    {
      content: 'User\'s name is Alice',
      subject: 'user',
      category: 'personal',
      confidence: 0.95,
      action: 'fact',
    },
    {
      content: 'User lives in Tokyo',
      subject: 'user',
      category: 'location',
      confidence: 0.95,
      action: 'fact',
    },
  ],
  proactive_triggers: [],
});

describe('E2E WebSocket Integration', () => {
  let ctx: E2EGatewayContext;

  beforeAll(async () => {
    ctx = await createE2EGateway({
      responses: [
        'Hello! Nice to meet you. [DONE]',
        'I remember that you live in Tokyo! [DONE]',
      ],
      factExtractorResponses: [FACT_EXTRACTION_RESPONSE],
    });
  }, 30000);

  afterAll(async () => {
    await cleanupE2E(ctx);
  }, 15000);

  // Each test gets a fresh WebSocket client
  let client: WsClient;

  beforeEach(async () => {
    client = await createWsClient(ctx.port);
  });

  afterEach(async () => {
    await client.close();
  });

  // --------------------------------------------------------------------------
  // Test 1: WebSocket connect and ping/pong
  // --------------------------------------------------------------------------
  it('should connect via WebSocket and respond to ping with pong', async () => {
    client.send({ type: 'ping' });

    const response = await client.waitForResponse('pong', 5000);

    expect(response.type).toBe('pong');
  });

  // --------------------------------------------------------------------------
  // Test 2: Send chat message and receive response
  // --------------------------------------------------------------------------
  it('should send a chat message and receive a response', async () => {
    client.send({
      type: 'chat',
      message: 'Hello, how are you?',
    });

    const messages = await client.collectUntilResponse(15000);

    // Should have at least one response message
    const responseMsg = messages.find((m) => m.type === 'response');
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.content).toBeTruthy();
    expect(typeof responseMsg!.content).toBe('string');
    expect(responseMsg!.content!.length).toBeGreaterThan(0);
    // Session ID should be present
    expect(responseMsg!.sessionId).toBeDefined();
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 3: Memory storage after conversation
  // --------------------------------------------------------------------------
  it('should store memories after processing a message with facts', async () => {
    client.send({
      type: 'chat',
      message: 'My name is Alice and I live in Tokyo.',
    });

    // Wait for the response to complete
    const messages = await client.collectUntilResponse(15000);
    const responseMsg = messages.find((m) => m.type === 'response');
    expect(responseMsg).toBeDefined();

    // Give fact extraction a moment to complete (it runs async)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Query the database directly to verify facts were stored
    const userMemories = ctx.scallopStore.getByUser('default', {
      limit: 50,
    });

    // The fact extractor should have stored at least one fact
    expect(userMemories.length).toBeGreaterThan(0);

    // Check that at least one memory relates to the stated facts
    const memoryTexts = userMemories.map((m) => m.content.toLowerCase());
    const hasAliceFact = memoryTexts.some(
      (t) => t.includes('alice') || t.includes('name')
    );
    const hasTokyoFact = memoryTexts.some(
      (t) => t.includes('tokyo') || t.includes('live')
    );
    expect(hasAliceFact || hasTokyoFact).toBe(true);
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 4: Memory retrieval in follow-up message
  // --------------------------------------------------------------------------
  it('should retrieve memories in follow-up messages', async () => {
    // Pre-seed a unique fact (avoid overlap with Test 3's Tokyo fact
    // which would trigger ingestion-time dedup)
    await ctx.scallopStore.add({
      content: 'User works as a robotics engineer at SpaceX headquarters in Hawthorne',
      userId: 'default',
      category: 'fact',
      importance: 8,
      confidence: 0.95,
    });

    // Send a follow-up question that should trigger memory search
    client.send({
      type: 'chat',
      message: 'What is my job?',
    });

    const messages = await client.collectUntilResponse(15000);

    // The response should exist
    const responseMsg = messages.find((m) => m.type === 'response');
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.content).toBeTruthy();

    // The agent's buildMemoryContext should have found the pre-seeded fact.
    // This is verified by checking that the memory search yielded results,
    // which we can verify through the mock provider's last request (the
    // system prompt should contain the memory context).
    const lastRequest = ctx.mockProvider.lastRequest;
    expect(lastRequest).not.toBeNull();

    // The system prompt should contain our pre-seeded memory
    const systemPrompt = lastRequest!.system || '';
    const hasMemoryInContext =
      systemPrompt.includes('SpaceX') ||
      systemPrompt.includes('robotics');
    expect(hasMemoryInContext).toBe(true);
  }, 30000);
});
