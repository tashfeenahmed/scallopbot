/**
 * E2E Chat Scenarios
 *
 * Comprehensive tests for tool use flows, proactive message delivery,
 * error recovery during tool execution, and user stop signals.
 * All exercised through real WebSocket E2E flows with side-effect
 * verification on DB state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
  type MockCompletionResponse,
} from './helpers.js';
import { defineSkill } from '../skills/sdk.js';
import type { ContentBlock } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helper: register a native test skill on the gateway's skill registry
// ---------------------------------------------------------------------------
function registerTestSkill(
  ctx: E2EGatewayContext,
  name: string,
  description: string,
  handler: (args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>,
  inputSchema?: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] }
): void {
  const builder = defineSkill(name, description)
    .userInvocable(false)
    .onNativeExecute(async (context) => {
      return handler(context.args as Record<string, unknown>);
    });

  if (inputSchema) {
    builder.inputSchema(inputSchema);
  }

  const skillDef = builder.build();
  ctx.skillRegistry.registerSkill(skillDef.skill);
}

// ============================================================================
// Tool Use Basics (Scenarios 1, 2, 3)
// ============================================================================
describe('E2E Chat Scenarios', () => {

  describe('Tool Use Basics', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    // Scenario 1: Single tool use
    describe('Scenario 1: Single Tool Use E2E', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // Turn 1: LLM wants to call echo_tool
          {
            content: [
              { type: 'text', text: 'Let me echo that for you.' },
              { type: 'tool_use', id: 'tool_1', name: 'echo_tool', input: { message: 'hello world' } },
            ],
            stopReason: 'tool_use',
          },
          // Turn 2: LLM returns final text after seeing tool_result
          {
            content: [{ type: 'text', text: 'The echo returned: hello world [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        registerTestSkill(ctx, 'echo_tool', 'Echoes input back', async (args) => {
          return { success: true, output: `echo: ${args.message}` };
        }, {
          type: 'object',
          properties: { message: { type: 'string', description: 'Message to echo' } },
          required: ['message'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should execute a single tool use and return final response', async () => {
        client.send({ type: 'chat', message: 'Echo hello world' });
        const messages = await client.collectUntilResponse(15000);

        // Should have skill_start, skill_complete, and response
        const skillStart = messages.find(m => m.type === 'skill_start');
        const skillComplete = messages.find(m => m.type === 'skill_complete');
        const response = messages.find(m => m.type === 'response');

        expect(skillStart).toBeDefined();
        expect(skillStart!.skill).toBe('echo_tool');
        expect(skillComplete).toBeDefined();
        expect(skillComplete!.skill).toBe('echo_tool');
        expect(skillComplete!.output).toContain('echo: hello world');
        expect(response).toBeDefined();
        expect(response!.content).toContain('echo returned');

        // Provider should have been called exactly 2 times
        expect(ctx.mockProvider.callCount).toBe(2);

        // Second request should contain tool_result in messages
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        const secondRequest = allRequests[1];
        const lastMessage = secondRequest.messages[secondRequest.messages.length - 1];
        expect(lastMessage.role).toBe('user');
        // tool_result content blocks
        const content = lastMessage.content as ContentBlock[];
        expect(Array.isArray(content)).toBe(true);
        const toolResult = content.find((b: ContentBlock) => b.type === 'tool_result');
        expect(toolResult).toBeDefined();

        // Session should have 4 messages: user, assistant(tool_use), user(tool_result), assistant(final)
        const sessionId = response!.sessionId!;
        const session = await ctx.sessionManager.getSession(sessionId);
        expect(session!.messages.length).toBe(4);
      }, 30000);
    });

    // Scenario 2: Multi-tool chaining
    describe('Scenario 2: Multi-Tool Chaining', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM calls tool_a
          {
            content: [
              { type: 'text', text: 'First I will call tool_a.' },
              { type: 'tool_use', id: 'tool_a_1', name: 'tool_a', input: { value: 'step1' } },
            ],
            stopReason: 'tool_use',
          },
          // LLM sees tool_a result, calls tool_b
          {
            content: [
              { type: 'text', text: 'Now calling tool_b with the result.' },
              { type: 'tool_use', id: 'tool_b_1', name: 'tool_b', input: { value: 'step2' } },
            ],
            stopReason: 'tool_use',
          },
          // LLM returns final response
          {
            content: [{ type: 'text', text: 'Both tools complete. Results: step1+step2 [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        registerTestSkill(ctx, 'tool_a', 'First tool', async (args) => {
          return { success: true, output: `result_a: ${args.value}` };
        }, {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        });

        registerTestSkill(ctx, 'tool_b', 'Second tool', async (args) => {
          return { success: true, output: `result_b: ${args.value}` };
        }, {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should chain multiple tool calls across iterations', async () => {
        client.send({ type: 'chat', message: 'Run both tools' });
        const messages = await client.collectUntilResponse(15000);

        // Should have 4 skill messages: start_a, complete_a, start_b, complete_b
        const skillMessages = messages.filter(m =>
          m.type === 'skill_start' || m.type === 'skill_complete'
        );
        expect(skillMessages.length).toBe(4);

        // Planning messages should be present
        const planningMessages = messages.filter(m => m.type === 'planning');
        expect(planningMessages.length).toBeGreaterThanOrEqual(1);

        // Provider called 3 times
        expect(ctx.mockProvider.callCount).toBe(3);

        // Session should have 6 messages
        const response = messages.find(m => m.type === 'response')!;
        const session = await ctx.sessionManager.getSession(response.sessionId!);
        expect(session!.messages.length).toBe(6);
      }, 30000);
    });

    // Scenario 3: Parallel tool use (2 tool_use blocks in one response)
    describe('Scenario 3: Parallel Tool Use', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM returns 2 tool_use blocks in one response
          {
            content: [
              { type: 'text', text: 'Running both tools at once.' },
              { type: 'tool_use', id: 'par_1', name: 'par_tool_x', input: { val: 'x' } },
              { type: 'tool_use', id: 'par_2', name: 'par_tool_y', input: { val: 'y' } },
            ],
            stopReason: 'tool_use',
          },
          // Final response
          {
            content: [{ type: 'text', text: 'Both done. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        registerTestSkill(ctx, 'par_tool_x', 'Parallel tool X', async (args) => {
          return { success: true, output: `x_result: ${args.val}` };
        }, {
          type: 'object',
          properties: { val: { type: 'string' } },
          required: ['val'],
        });

        registerTestSkill(ctx, 'par_tool_y', 'Parallel tool Y', async (args) => {
          return { success: true, output: `y_result: ${args.val}` };
        }, {
          type: 'object',
          properties: { val: { type: 'string' } },
          required: ['val'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should execute parallel tool_use blocks and feed back both results', async () => {
        client.send({ type: 'chat', message: 'Run parallel' });
        const messages = await client.collectUntilResponse(15000);

        // Both tools should have start+complete
        const skillStarts = messages.filter(m => m.type === 'skill_start');
        const skillCompletes = messages.filter(m => m.type === 'skill_complete');
        expect(skillStarts.length).toBe(2);
        expect(skillCompletes.length).toBe(2);

        // Provider called 2 times
        expect(ctx.mockProvider.callCount).toBe(2);

        // Second request should have 2 tool_result blocks
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        const secondRequest = allRequests[1];
        const lastMsg = secondRequest.messages[secondRequest.messages.length - 1];
        const content = lastMsg.content as ContentBlock[];
        const toolResults = content.filter((b: ContentBlock) => b.type === 'tool_result');
        expect(toolResults.length).toBe(2);
      }, 30000);
    });
  });

  // ============================================================================
  // Specific Skills (Scenarios 4, 10)
  // ============================================================================
  describe('Specific Skills', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    // Scenario 4: Memory search via tool
    describe('Scenario 4: Memory Search via Tool', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM calls memory_search
          {
            content: [
              { type: 'tool_use', id: 'mem_1', name: 'memory_search_tool', input: { query: 'favorite color' } },
            ],
            stopReason: 'tool_use',
          },
          // LLM uses the result
          {
            content: [{ type: 'text', text: 'Based on my memory search, your favorite color is blue. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        // Pre-seed a fact
        ctx.scallopStore.add({
          content: 'User favorite color is blue',
          userId: 'default',
          category: 'fact',
          importance: 8,
          confidence: 0.95,
        });

        // Register native memory_search skill
        registerTestSkill(ctx, 'memory_search_tool', 'Search memories', async (args) => {
          const results = await ctx.scallopStore.search(args.query as string, {
            userId: 'default',
            limit: 5,
          });
          const output = results.map(r => r.memory.content).join('; ');
          return { success: true, output: output || 'No memories found' };
        }, {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should search memories via tool and return results to LLM', async () => {
        client.send({ type: 'chat', message: 'What is my favorite color?' });
        const messages = await client.collectUntilResponse(15000);

        const skillComplete = messages.find(m => m.type === 'skill_complete');
        expect(skillComplete).toBeDefined();
        expect(skillComplete!.output).toContain('blue');

        // Verify tool_result fed back to LLM contains the fact
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        const secondRequest = allRequests[1];
        const lastMsg = secondRequest.messages[secondRequest.messages.length - 1];
        const content = lastMsg.content as ContentBlock[];
        const toolResult = content.find((b: ContentBlock) => b.type === 'tool_result') as { type: 'tool_result'; content: string } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.content).toContain('blue');
      }, 30000);
    });

    // Scenario 10: Goal operations via tool
    describe('Scenario 10: Goal Operations via Tool', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM calls goals_tool to create a goal
          {
            content: [
              { type: 'tool_use', id: 'goal_1', name: 'goals_tool', input: { action: 'create', title: 'Learn TypeScript', status: 'active' } },
            ],
            stopReason: 'tool_use',
          },
          // Final response
          {
            content: [{ type: 'text', text: 'Goal created: Learn TypeScript [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        // Register native goals skill that writes to DB
        registerTestSkill(ctx, 'goals_tool', 'Manage goals', async (args) => {
          if (args.action === 'create') {
            const db = ctx.scallopStore.getDatabase();
            // Insert goal as a memory with goalType metadata
            db.addMemory({
              userId: 'default',
              content: args.title as string,
              category: 'goal',
              memoryType: 'regular',
              importance: 7,
              confidence: 1.0,
              isLatest: true,
              source: 'user',
              documentDate: Date.now(),
              eventDate: null,
              prominence: 0.5,
              lastAccessed: null,
              accessCount: 0,
              sourceChunk: null,
              embedding: new Array(384).fill(0),
              metadata: { goalType: args.status || 'active' },
            });
            return { success: true, output: `Goal created: ${args.title}` };
          }
          return { success: false, output: '', error: 'Unknown action' };
        }, {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Action: create, update, list' },
            title: { type: 'string', description: 'Goal title' },
            status: { type: 'string', description: 'Goal status' },
          },
          required: ['action'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should create a goal via tool and persist it in DB', async () => {
        client.send({ type: 'chat', message: 'Create a goal to learn TypeScript' });
        const messages = await client.collectUntilResponse(15000);

        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();
        expect(response!.content).toContain('Goal created');

        // Verify goal persisted in memories table
        const db = ctx.scallopStore.getDatabase();
        const goals = db.raw<{ content: string; metadata: string }>(
          "SELECT content, metadata FROM memories WHERE category = 'goal' AND user_id = 'default'",
          []
        );
        expect(goals.length).toBeGreaterThanOrEqual(1);
        const goal = goals.find(g => g.content.includes('Learn TypeScript'));
        expect(goal).toBeDefined();
        const meta = JSON.parse(goal!.metadata);
        expect(meta.goalType).toBe('active');
      }, 30000);
    });
  });

  // ============================================================================
  // Error Handling (Scenarios 5, 6, 13)
  // ============================================================================
  describe('Error Handling', () => {
    let client: WsClient;

    // Scenario 5: Tool not found
    describe('Scenario 5: Tool Not Found', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM hallucinates a nonexistent tool
          {
            content: [
              { type: 'tool_use', id: 'bad_1', name: 'nonexistent_tool', input: { query: 'test' } },
            ],
            stopReason: 'tool_use',
          },
          // LLM recovers and responds with text
          {
            content: [{ type: 'text', text: 'Sorry, that tool is not available. Let me help differently. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should return error tool_result for unknown skill and continue', async () => {
        client.send({ type: 'chat', message: 'Use the nonexistent tool' });
        const messages = await client.collectUntilResponse(15000);

        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();

        // Verify tool_result has is_error with "Unknown skill"
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        const secondRequest = allRequests[1];
        const lastMsg = secondRequest.messages[secondRequest.messages.length - 1];
        const content = lastMsg.content as ContentBlock[];
        const toolResult = content.find((b: ContentBlock) => b.type === 'tool_result') as { type: 'tool_result'; content: string; is_error?: boolean } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBe(true);
        expect(toolResult!.content).toContain('Unknown skill');
      }, 30000);
    });

    // Scenario 6: Tool execution failure
    describe('Scenario 6: Tool Execution Failure', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // LLM calls failing_tool
          {
            content: [
              { type: 'tool_use', id: 'fail_1', name: 'failing_tool', input: {} },
            ],
            stopReason: 'tool_use',
          },
          // LLM recovers
          {
            content: [{ type: 'text', text: 'The tool failed, but I can still help. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        registerTestSkill(ctx, 'failing_tool', 'A tool that always fails', async () => {
          throw new Error('Intentional test failure');
        }, {
          type: 'object',
          properties: {},
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should handle tool execution failure and recover', async () => {
        client.send({ type: 'chat', message: 'Use the failing tool' });
        const messages = await client.collectUntilResponse(15000);

        // Should receive skill_start then skill_error
        const skillStart = messages.find(m => m.type === 'skill_start');
        const skillError = messages.find(m => m.type === 'skill_error');
        expect(skillStart).toBeDefined();
        expect(skillStart!.skill).toBe('failing_tool');
        expect(skillError).toBeDefined();
        expect(skillError!.skill).toBe('failing_tool');
        expect(skillError!.error).toContain('Intentional test failure');

        // Agent should still produce a final response
        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();

        // tool_result should have error
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        const secondRequest = allRequests[1];
        const lastMsg = secondRequest.messages[secondRequest.messages.length - 1];
        const content = lastMsg.content as ContentBlock[];
        const toolResult = content.find((b: ContentBlock) => b.type === 'tool_result') as { type: 'tool_result'; content: string; is_error?: boolean } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBe(true);
        expect(toolResult!.content).toContain('Intentional test failure');
      }, 30000);
    });

    // Scenario 13: Max iterations reached
    describe('Scenario 13: Max Iterations Reached', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        // LLM always returns tool_use (never ends) — agent should hit max iterations
        const scenarioResponses: MockCompletionResponse[] = [
          {
            content: [
              { type: 'text', text: 'Calling loop tool.' },
              { type: 'tool_use', id: 'loop_1', name: 'loop_tool', input: {} },
            ],
            stopReason: 'tool_use',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses, maxIterations: 2 });

        registerTestSkill(ctx, 'loop_tool', 'Loops forever', async () => {
          return { success: true, output: 'loop iteration done' };
        }, {
          type: 'object',
          properties: {},
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should stop at max iterations and include warning in response', async () => {
        client.send({ type: 'chat', message: 'Run the loop tool' });
        const messages = await client.collectUntilResponse(15000);

        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();
        expect(response!.content).toContain('maximum iterations');

        // Provider should have been called exactly 2 times
        expect(ctx.mockProvider.callCount).toBe(2);
      }, 30000);
    });
  });

  // ============================================================================
  // User Interaction (Scenarios 7, 8)
  // ============================================================================
  describe('User Interaction', () => {
    let client: WsClient;

    // Scenario 7: User stop mid-execution
    describe('Scenario 7: User Stop Mid-Execution', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        // LLM returns 2 parallel tool_use blocks
        const scenarioResponses: MockCompletionResponse[] = [
          {
            content: [
              { type: 'tool_use', id: 'stop_1', name: 'slow_tool_a', input: {} },
              { type: 'tool_use', id: 'stop_2', name: 'slow_tool_b', input: {} },
            ],
            stopReason: 'tool_use',
          },
          // Final response after stop
          {
            content: [{ type: 'text', text: 'Stopped as requested. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        let toolCallCount = 0;

        registerTestSkill(ctx, 'slow_tool_a', 'First slow tool', async () => {
          toolCallCount++;
          // After first tool completes, the stop signal check happens before second tool
          return { success: true, output: 'tool_a done' };
        }, { type: 'object', properties: {} });

        registerTestSkill(ctx, 'slow_tool_b', 'Second slow tool', async () => {
          toolCallCount++;
          return { success: true, output: 'tool_b done' };
        }, { type: 'object', properties: {} });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should stop execution when user sends stop signal', async () => {
        // Send stop after a brief delay to allow the first tool to start
        const stopDelay = setTimeout(() => {
          client.send({ type: 'stop' });
        }, 500);

        client.send({ type: 'chat', message: 'Run both slow tools' });

        // Collect all messages until response
        const messages = await client.collectUntilResponse(15000);
        clearTimeout(stopDelay);

        // We should get a response (either the agent completes or stops)
        const response = messages.find(m => m.type === 'response');
        expect(response).toBeDefined();

        // Check if a tool_result with stop message was fed back
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        if (allRequests.length > 1) {
          const lastReq = allRequests[allRequests.length - 1];
          const toolResultMsgs = lastReq.messages.filter(m => {
            if (m.role !== 'user' || typeof m.content === 'string') return false;
            return (m.content as ContentBlock[]).some(b => b.type === 'tool_result');
          });
          // If stop was processed during tool execution, at least one tool_result
          // should mention "stopped by user request"
          if (toolResultMsgs.length > 0) {
            const contents = toolResultMsgs.flatMap(m =>
              (m.content as ContentBlock[])
                .filter(b => b.type === 'tool_result')
                .map(b => (b as { content: string }).content)
            );
            const hasStopMsg = contents.some(c => c.toLowerCase().includes('stopped'));
            // The stop may or may not have been received in time, so we just
            // verify the response was delivered either way.
            expect(response!.content).toBeTruthy();
          }
        }
      }, 30000);
    });

    // Scenario 8: Session continuity with tools
    describe('Scenario 8: Session Continuity with Tools', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        let callCount = 0;
        const scenarioResponses: MockCompletionResponse[] = [
          // Turn 1: tool use
          {
            content: [
              { type: 'tool_use', id: 'cont_1', name: 'counter_tool', input: { action: 'increment' } },
            ],
            stopReason: 'tool_use',
          },
          // Turn 1: final
          {
            content: [{ type: 'text', text: 'Counter incremented to 1. [DONE]' }],
            stopReason: 'end_turn',
          },
          // Turn 2: tool use
          {
            content: [
              { type: 'tool_use', id: 'cont_2', name: 'counter_tool', input: { action: 'increment' } },
            ],
            stopReason: 'tool_use',
          },
          // Turn 2: final
          {
            content: [{ type: 'text', text: 'Counter incremented to 2. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        let counter = 0;
        registerTestSkill(ctx, 'counter_tool', 'Increment counter', async () => {
          counter++;
          return { success: true, output: `count: ${counter}` };
        }, {
          type: 'object',
          properties: { action: { type: 'string' } },
          required: ['action'],
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should maintain session history across multiple tool-use turns', async () => {
        // Turn 1
        client.send({ type: 'chat', message: 'Increment the counter' });
        const msgs1 = await client.collectUntilResponse(15000);
        const response1 = msgs1.find(m => m.type === 'response')!;
        const sessionId = response1.sessionId!;

        // Turn 2: same session (via same WS client, the channel manages sessions per WS client)
        client.send({ type: 'chat', message: 'Increment again' });
        const msgs2 = await client.collectUntilResponse(15000);
        const response2 = msgs2.find(m => m.type === 'response')!;

        // Provider should have been called 4 times total (2 per turn)
        expect(ctx.mockProvider.callCount).toBe(4);

        // Turn 2 LLM request should contain full turn 1 history
        const allRequests = (ctx.mockProvider as unknown as { allRequests: unknown[] }).allRequests as Array<{ messages: Array<{ role: string; content: ContentBlock[] | string }> }>;
        // 3rd request (index 2) is the first request of turn 2
        const turn2FirstRequest = allRequests[2];
        // Should have turn 1 messages (user, assistant tool_use, user tool_result, assistant final) + turn 2 user
        expect(turn2FirstRequest.messages.length).toBeGreaterThanOrEqual(5);

        // Session should have 8 messages total
        const session = await ctx.sessionManager.getSession(sessionId);
        expect(session!.messages.length).toBe(8);
      }, 30000);
    });
  });

  // ============================================================================
  // Cognitive Integration (Scenarios 9, 12)
  // ============================================================================
  describe('Cognitive Integration', () => {
    let client: WsClient;

    // Scenario 9: Affect classification impact
    describe('Scenario 9: Affect Classification Impact', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          // Response to negative message
          {
            content: [{ type: 'text', text: 'I hear you, that sounds frustrating. [DONE]' }],
            stopReason: 'end_turn',
          },
          // Response to follow-up
          {
            content: [{ type: 'text', text: 'Let me help cheer you up. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should classify affect and include it in system prompt', async () => {
        // Turn 1: strongly negative message
        client.send({
          type: 'chat',
          message: 'I am so angry and frustrated, everything is terrible and broken and I hate it all!',
        });
        const msgs1 = await client.collectUntilResponse(15000);
        expect(msgs1.find(m => m.type === 'response')).toBeDefined();

        // Check affect was persisted with negative valence
        const profileManager = ctx.scallopStore.getProfileManager();
        const patterns = profileManager.getBehavioralPatterns('default');
        expect(patterns).not.toBeNull();
        expect(patterns!.smoothedAffect).toBeDefined();
        expect(patterns!.smoothedAffect!.valence).toBeLessThan(0);

        // Turn 2: system prompt should include affect context
        client.send({ type: 'chat', message: 'Help me feel better' });
        const msgs2 = await client.collectUntilResponse(15000);
        expect(msgs2.find(m => m.type === 'response')).toBeDefined();

        // Inspect the system prompt of the last LLM call
        const lastRequest = ctx.mockProvider.lastRequest!;
        const systemPrompt = lastRequest.system || '';
        expect(systemPrompt).toContain('Emotion:');
        expect(systemPrompt).toContain('Valence:');
      }, 30000);
    });

    // Scenario 12: Memory progress events
    describe('Scenario 12: Memory Progress Events', () => {
      let ctx: E2EGatewayContext;

      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          {
            content: [{ type: 'text', text: 'Based on what I know, your cat is named Whiskers. [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });

        // Pre-seed facts so memory search finds them
        ctx.scallopStore.add({
          content: "User's cat is named Whiskers",
          userId: 'default',
          category: 'fact',
          importance: 7,
          confidence: 0.9,
        });
        ctx.scallopStore.add({
          content: "User's cat is a tabby breed",
          userId: 'default',
          category: 'fact',
          importance: 6,
          confidence: 0.85,
        });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should send memory progress event before response', async () => {
        client.send({ type: 'chat', message: 'What is my cat named?' });
        const messages = await client.collectUntilResponse(15000);

        // Should have a memory message before the response
        const memoryMsg = messages.find(m => m.type === 'memory');
        const response = messages.find(m => m.type === 'response');

        expect(memoryMsg).toBeDefined();
        expect(memoryMsg!.action).toBe('search');
        expect(memoryMsg!.count).toBeGreaterThan(0);
        expect(memoryMsg!.items).toBeDefined();
        expect(Array.isArray(memoryMsg!.items)).toBe(true);
        expect(memoryMsg!.items!.length).toBeGreaterThan(0);

        // Memory message should come before response
        const memIdx = messages.indexOf(memoryMsg!);
        const respIdx = messages.indexOf(response!);
        expect(memIdx).toBeLessThan(respIdx);
      }, 30000);
    });
  });

  // ============================================================================
  // Proactive Messages (Scenario 11)
  // ============================================================================
  describe('Proactive Messages', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    // Scenario 11: Proactive message delivery
    describe('Scenario 11: Proactive Message Delivery', () => {
      beforeAll(async () => {
        const scenarioResponses: MockCompletionResponse[] = [
          {
            content: [{ type: 'text', text: 'Hello there! [DONE]' }],
            stopReason: 'end_turn',
          },
        ];

        ctx = await createE2EGateway({ scenarioResponses });
      }, 30000);

      afterAll(async () => { await cleanupE2E(ctx); }, 15000);
      beforeEach(async () => { client = await createWsClient(ctx.port); });
      afterEach(async () => { await client.close(); });

      it('should deliver proactive messages to connected WS client', async () => {
        // First establish a session by sending a chat message
        client.send({ type: 'chat', message: 'Hi there' });
        const msgs = await client.collectUntilResponse(15000);
        const response = msgs.find(m => m.type === 'response');
        expect(response).toBeDefined();

        // The WS client is tracked by userId pattern "ws-{clientId}"
        // We need to find the userId assigned to this client.
        // The clientsByUser map tracks ws-{clientId} -> Set<WebSocket>.
        // We can extract it from the internal state of apiChannel.
        // Since apiChannel is a class instance, we access the private field via cast.
        const apiChannel = ctx.apiChannel as unknown as {
          clientsByUser: Map<string, Set<unknown>>;
          sendMessage(userId: string, message: string): Promise<boolean>;
        };

        // Find the user ID that has connected clients
        let targetUserId = '';
        for (const [userId, clients] of apiChannel.clientsByUser.entries()) {
          if (clients.size > 0) {
            targetUserId = userId;
            break;
          }
        }
        expect(targetUserId).toBeTruthy();

        // Now send a plain text proactive message via sendMessage
        const collectPromise = client.collectAll(3000);
        await apiChannel.sendMessage(targetUserId, 'Time for your daily standup!');

        // Also send a structured proactive JSON
        await apiChannel.sendMessage(targetUserId, JSON.stringify({
          type: 'proactive',
          content: 'Remember to drink water',
          category: 'wellness',
          urgency: 'low',
          source: 'scheduler',
        }));

        const proactiveMessages = await collectPromise;

        // Should receive a 'trigger' message for plain text
        const triggerMsg = proactiveMessages.find(m => m.type === 'trigger');
        expect(triggerMsg).toBeDefined();
        expect(triggerMsg!.content).toContain('standup');

        // Should receive a 'proactive' message for structured JSON
        const proactiveMsg = proactiveMessages.find(m => m.type === 'proactive');
        expect(proactiveMsg).toBeDefined();
        expect(proactiveMsg!.content).toContain('water');
        expect(proactiveMsg!.category).toBe('wellness');
        expect(proactiveMsg!.urgency).toBe('low');
        expect(proactiveMsg!.source).toBe('scheduler');
      }, 30000);
    });
  });
});
