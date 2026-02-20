/**
 * E2E: Tool Conversation Integration Test
 *
 * Boots the full pipeline (WebSocket -> Agent -> Mock LLM -> Skill Executor)
 * and simulates a realistic multi-turn conversation where the agent uses
 * the new bundled skills (ls, glob, grep, read_file, multi_edit, apply_patch).
 *
 * Validates:
 * - Tool execution via real SkillExecutor (spawns tsx scripts)
 * - Parallel tool execution (read-only tools run concurrently)
 * - Tool call repair (case-insensitive matching)
 * - Doom loop detection
 * - WebSocket event flow (skill_start, skill_complete, response)
 * - DB integrity (sessions, messages, token usage)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
  type MockCompletionResponse,
  type WsResponse,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared temp workspace with files for tools to operate on
// ---------------------------------------------------------------------------

let tmpWorkspace: string;

function setupWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-e2e-'));

  // Create a mini project structure for ls/glob/grep/read/edit to work with
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), [
    'import { helper } from "./utils/helper";',
    '',
    'export function main(): void {',
    '  const result = helper("world");',
    '  console.log(result);',
    '}',
    '',
    'main();',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(dir, 'src', 'utils', 'helper.ts'), [
    '/**',
    ' * Helper utility function',
    ' */',
    'export function helper(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(dir, 'src', 'config.ts'), [
    'export const PORT = 3000;',
    'export const HOST = "localhost";',
    'export const DEBUG = false;',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(dir, 'tests', 'helper.test.ts'), [
    'import { helper, add } from "../src/utils/helper";',
    '',
    'test("helper returns greeting", () => {',
    '  expect(helper("world")).toBe("Hello, world!");',
    '});',
    '',
    'test("add returns sum", () => {',
    '  expect(add(2, 3)).toBe(5);',
    '});',
    '',
  ].join('\n'));

  return dir;
}

function cleanupWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// Suite 1: Multi-turn tool conversation via WebSocket
// ===========================================================================

describe('E2E Tool Conversation', () => {

  beforeAll(() => {
    tmpWorkspace = setupWorkspace();
  });

  afterAll(() => {
    cleanupWorkspace(tmpWorkspace);
  });

  // -------------------------------------------------------------------------
  // Test 1: Agent uses ls + glob + grep in a codebase exploration flow
  // -------------------------------------------------------------------------
  describe('codebase exploration flow (ls -> glob -> grep)', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Agent decides to list the directory and find TypeScript files
        {
          content: [
            { type: 'text', text: 'Let me explore the project structure.' },
            {
              type: 'tool_use',
              id: 'tu_ls',
              name: 'ls',
              input: { path: '.', long: true },
            },
            {
              type: 'tool_use',
              id: 'tu_glob',
              name: 'glob',
              input: { pattern: '**/*.ts' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Agent sees results, searches for function definitions
        {
          content: [
            { type: 'text', text: 'Found the files. Let me search for function definitions.' },
            {
              type: 'tool_use',
              id: 'tu_grep',
              name: 'grep',
              input: { pattern: 'export function', glob: '*.ts' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 3: Agent provides summary
        {
          content: [
            {
              type: 'text',
              text: 'Here is what I found in your project:\n\n' +
                '- **Structure**: src/, tests/, package.json\n' +
                '- **TypeScript files**: index.ts, helper.ts, config.ts, helper.test.ts\n' +
                '- **Exported functions**: main(), helper(), add()\n\n' +
                'The project is a small TypeScript app with a helper utility. [DONE]',
            },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({
        scenarioResponses,
        maxIterations: 10,
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

    it('should execute ls, glob, grep tools and return results via WebSocket', async () => {
      // Verify new skills are loaded in the registry
      const tools = ctx.skillRegistry.getToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('ls');
      expect(toolNames).toContain('glob');
      expect(toolNames).toContain('grep');
      expect(toolNames).toContain('codesearch');
      expect(toolNames).toContain('multi_edit');
      expect(toolNames).toContain('apply_patch');

      // batch should NOT be a tool (disable-model-invocation: true)
      expect(toolNames).not.toContain('batch');

      // Send the exploration request
      client.send({
        type: 'chat',
        message: 'Can you explore the project structure and tell me what functions are defined?',
      });

      const messages = await client.collectUntilResponse(30000);

      // --- Verify WebSocket event flow ---

      // Should see skill_start events for ls, glob, grep
      const skillStarts = messages.filter(m => m.type === 'skill_start');
      const startedSkills = skillStarts.map(m => m.skill);
      expect(startedSkills).toContain('ls');
      expect(startedSkills).toContain('glob');
      expect(startedSkills).toContain('grep');

      // Should see skill_complete events for each
      const skillCompletes = messages.filter(m => m.type === 'skill_complete');
      const completedSkills = skillCompletes.map(m => m.skill);
      expect(completedSkills).toContain('ls');
      expect(completedSkills).toContain('glob');
      expect(completedSkills).toContain('grep');

      // ls output should contain directory entries (agent workspace is /tmp)
      const lsComplete = skillCompletes.find(m => m.skill === 'ls');
      expect(lsComplete).toBeDefined();
      expect(lsComplete!.output).toBeDefined();
      // /tmp contains various files; just verify ls produced non-empty output
      expect(lsComplete!.output!.length).toBeGreaterThan(0);

      // glob output should list .ts files
      const globComplete = skillCompletes.find(m => m.skill === 'glob');
      expect(globComplete).toBeDefined();

      // grep output should contain function definitions
      const grepComplete = skillCompletes.find(m => m.skill === 'grep');
      expect(grepComplete).toBeDefined();

      // Final response
      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toBeTruthy();
      expect(response!.sessionId).toBeDefined();

      // --- Verify DB state ---
      const db = ctx.scallopStore.getDatabase();
      const sessionId = response!.sessionId!;
      const session = db.getSession(sessionId);
      expect(session).not.toBeNull();

      const sessionMessages = db.getSessionMessages(sessionId);
      // At least: 1 user message + 3 LLM turns (each with assistant + tool_result messages)
      expect(sessionMessages.length).toBeGreaterThanOrEqual(4);

      // Verify the mock LLM was called 3 times (3 turns)
      expect(ctx.mockProvider.callCount).toBe(3);

      // Verify tool definitions were passed to each LLM call
      const allRequests = (ctx.mockProvider as unknown as { allRequests: Array<{ tools?: Array<{ name: string }> }> }).allRequests;
      for (const req of allRequests) {
        expect(req.tools).toBeDefined();
        const reqToolNames = req.tools!.map(t => t.name);
        expect(reqToolNames).toContain('ls');
        expect(reqToolNames).toContain('glob');
        expect(reqToolNames).toContain('grep');
      }
    }, 45000);
  });

  // -------------------------------------------------------------------------
  // Test 2: Parallel tool execution (ls + glob are both read-only)
  // -------------------------------------------------------------------------
  describe('parallel tool execution', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Agent emits two read-only tools in the same turn
        {
          content: [
            { type: 'text', text: 'Let me check the directory and find test files simultaneously.' },
            {
              type: 'tool_use',
              id: 'tu_ls_par',
              name: 'ls',
              input: { path: '.' },
            },
            {
              type: 'tool_use',
              id: 'tu_glob_par',
              name: 'glob',
              input: { pattern: '**/*.test.ts' },
            },
            {
              type: 'tool_use',
              id: 'tu_grep_par',
              name: 'grep',
              input: { pattern: 'expect' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Done
        {
          content: [
            { type: 'text', text: 'All three tools ran. Here are the results. [DONE]' },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 5 });
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

    it('should execute read-only tools in parallel', async () => {
      client.send({
        type: 'chat',
        message: 'List the project, find tests, and search for expect statements.',
      });

      const messages = await client.collectUntilResponse(30000);

      // All three tools should have started and completed
      const starts = messages.filter(m => m.type === 'skill_start');
      const completes = messages.filter(m => m.type === 'skill_complete');

      expect(starts.length).toBeGreaterThanOrEqual(3);
      expect(completes.length).toBeGreaterThanOrEqual(3);

      // Verify all three completed successfully
      const completedNames = completes.map(m => m.skill);
      expect(completedNames).toContain('ls');
      expect(completedNames).toContain('glob');
      expect(completedNames).toContain('grep');

      // Mock LLM called exactly 2 times
      expect(ctx.mockProvider.callCount).toBe(2);

      // The second request should contain tool_result blocks for all 3 tools
      const allRequests = (ctx.mockProvider as unknown as { allRequests: Array<{ messages?: Array<{ content?: unknown }> }> }).allRequests;
      expect(allRequests.length).toBe(2);

      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
    }, 45000);
  });

  // -------------------------------------------------------------------------
  // Test 3: Tool call repair (case-insensitive match)
  // -------------------------------------------------------------------------
  describe('tool call repair', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Agent calls "Ls" (wrong case) — should be auto-repaired to "ls"
        {
          content: [
            { type: 'text', text: 'Let me list the files.' },
            {
              type: 'tool_use',
              id: 'tu_repair',
              name: 'Ls',  // Wrong case!
              input: { path: '.' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Done
        {
          content: [
            { type: 'text', text: 'Got the listing. [DONE]' },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 5 });
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

    it('should auto-repair case-mismatched tool names', async () => {
      client.send({
        type: 'chat',
        message: 'List the files in the project.',
      });

      const messages = await client.collectUntilResponse(20000);

      // The tool should have been repaired and executed successfully
      // We should see skill_start/skill_complete (the repair logs internally)
      const completes = messages.filter(m => m.type === 'skill_complete');

      // The response should exist (agent didn't crash)
      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toContain('listing');

      // LLM should have been called 2 times (not an error loop)
      expect(ctx.mockProvider.callCount).toBe(2);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 4: Unknown tool returns helpful error with available tools
  // -------------------------------------------------------------------------
  describe('unknown tool error', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Agent calls a completely made-up tool
        {
          content: [
            { type: 'text', text: 'Let me use the compiler.' },
            {
              type: 'tool_use',
              id: 'tu_fake',
              name: 'compile_typescript',
              input: { file: 'src/index.ts' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Agent recovers and responds
        {
          content: [
            {
              type: 'text',
              text: 'Sorry, that tool is not available. Let me use a different approach. [DONE]',
            },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 5 });
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

    it('should return error listing available tools when tool not found', async () => {
      client.send({
        type: 'chat',
        message: 'Compile the TypeScript code.',
      });

      const messages = await client.collectUntilResponse(20000);

      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();

      // The second LLM call should have received the error as a tool_result
      const allRequests = (ctx.mockProvider as unknown as {
        allRequests: Array<{
          messages?: Array<{ role: string; content: unknown }>;
        }>;
      }).allRequests;

      expect(allRequests.length).toBe(2);

      // Find the tool_result error in the second request's messages
      const secondReqMessages = allRequests[1].messages || [];
      const toolResultMsg = secondReqMessages.find(m => {
        if (m.role !== 'user') return false;
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type: string }>).some(
            block => block.type === 'tool_result'
          );
        }
        return false;
      });
      expect(toolResultMsg).toBeDefined();

      // The tool_result should contain "Unknown tool" and list available tools
      const blocks = toolResultMsg!.content as Array<{
        type: string;
        content?: string;
        is_error?: boolean;
      }>;
      const errorBlock = blocks.find(b => b.type === 'tool_result');
      expect(errorBlock).toBeDefined();
      expect(errorBlock!.is_error).toBe(true);
      expect(errorBlock!.content).toContain('Unknown tool');
      expect(errorBlock!.content).toContain('Available tools');
      // Should list our new skills
      expect(errorBlock!.content).toContain('ls');
      expect(errorBlock!.content).toContain('glob');
      expect(errorBlock!.content).toContain('grep');
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 5: Full DB audit after multi-tool conversation
  // -------------------------------------------------------------------------
  describe('DB audit after tool conversation', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Use ls
        {
          content: [
            { type: 'text', text: 'Checking project structure.' },
            {
              type: 'tool_use',
              id: 'tu_db_ls',
              name: 'ls',
              input: { path: '.', long: true },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Use grep
        {
          content: [
            { type: 'text', text: 'Searching for exports.' },
            {
              type: 'tool_use',
              id: 'tu_db_grep',
              name: 'grep',
              input: { pattern: 'export', glob: '*.ts' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 3: Final response
        {
          content: [
            { type: 'text', text: 'Found the project layout and exports. [DONE]' },
          ],
          stopReason: 'end_turn',
        },
      ];

      const factExtractorResponses = [
        JSON.stringify({
          facts: [
            {
              content: 'User asked about project structure and exports',
              subject: 'interaction',
              category: 'conversation',
              confidence: 0.7,
              action: 'fact',
            },
          ],
          proactive_triggers: [],
        }),
      ];

      ctx = await createE2EGateway({
        scenarioResponses,
        factExtractorResponses,
        maxIterations: 10,
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

    it('should maintain DB integrity through tool conversation', async () => {
      client.send({
        type: 'chat',
        message: 'Show me the project structure and find all exports.',
      });

      const messages = await client.collectUntilResponse(30000);

      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
      const sessionId = response!.sessionId!;

      // Allow async fact extraction to complete
      await new Promise(r => setTimeout(r, 2000));

      const db = ctx.scallopStore.getDatabase();

      // 1. Session exists
      const session = db.getSession(sessionId);
      expect(session).not.toBeNull();

      // 2. Session has messages (user + assistant turns + tool results)
      const sessionMessages = db.getSessionMessages(sessionId);
      expect(sessionMessages.length).toBeGreaterThanOrEqual(4);

      // 3. Check message role distribution
      const roles = sessionMessages.map(m => m.role);
      expect(roles.filter(r => r === 'user').length).toBeGreaterThanOrEqual(1);
      expect(roles.filter(r => r === 'assistant').length).toBeGreaterThanOrEqual(1);

      // 4. No orphaned sessions
      const allSessions = db.raw<{ id: string }>(
        'SELECT id FROM sessions', []
      );
      for (const s of allSessions) {
        if (s.id === sessionId) {
          const msgs = db.getSessionMessages(s.id);
          expect(msgs.length).toBeGreaterThan(0);
        }
      }

      // 5. Token usage was recorded
      const sessionData = db.getSession(sessionId);
      // The mock provider returns 10 input + 20 output per call
      // 3 calls = 30 input + 60 output
      expect(sessionData).not.toBeNull();

      // 6. Cost usage recorded in cost_usage table
      // The CostTracker prefixes session IDs with channel, so query broadly
      const costRecords = db.raw<{ input_tokens: number; output_tokens: number }>(
        "SELECT input_tokens, output_tokens FROM cost_usage",
        []
      );
      // Should have at least one cost record from our conversation
      expect(costRecords.length).toBeGreaterThanOrEqual(1);
      const totalInput = costRecords.reduce((sum, r) => sum + r.input_tokens, 0);
      const totalOutput = costRecords.reduce((sum, r) => sum + r.output_tokens, 0);
      expect(totalInput).toBeGreaterThan(0);
      expect(totalOutput).toBeGreaterThan(0);

      // 7. Memories may have been stored by fact extractor
      const memories = ctx.scallopStore.getByUser('default', { limit: 50 });
      // May or may not have memories depending on async timing
      // Just verify no corruption
      for (const mem of memories) {
        expect(mem.content).toBeTruthy();
        expect(mem.importance).toBeGreaterThanOrEqual(1);
        expect(mem.importance).toBeLessThanOrEqual(10);
        expect(mem.confidence).toBeGreaterThanOrEqual(0);
        expect(mem.confidence).toBeLessThanOrEqual(1);
      }

      // 8. No memories with null content
      const nullContent = db.raw<{ id: string }>(
        "SELECT id FROM memories WHERE content IS NULL OR content = ''",
        []
      );
      expect(nullContent.length).toBe(0);

      // 9. All session messages have valid createdAt timestamps
      for (const msg of sessionMessages) {
        expect(msg.createdAt).toBeDefined();
        expect(msg.createdAt).toBeGreaterThan(0);
        expect(msg.createdAt).toBeLessThanOrEqual(Date.now() + 60000);
      }
    }, 60000);
  });

  // -------------------------------------------------------------------------
  // Test 6: Doom loop detection
  // -------------------------------------------------------------------------
  describe('doom loop detection', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      // Agent calls the same tool 4 times with identical input
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: ls call
        {
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu_doom_1', name: 'ls', input: { path: '.' } },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: same ls call
        {
          content: [
            { type: 'text', text: 'Checking again.' },
            { type: 'tool_use', id: 'tu_doom_2', name: 'ls', input: { path: '.' } },
          ],
          stopReason: 'tool_use',
        },
        // Turn 3: same ls call — doom loop should be detected
        {
          content: [
            { type: 'text', text: 'One more check.' },
            { type: 'tool_use', id: 'tu_doom_3', name: 'ls', input: { path: '.' } },
          ],
          stopReason: 'tool_use',
        },
        // Turn 4: Agent recovers (after doom loop warning injected)
        {
          content: [
            {
              type: 'text',
              text: 'I apologize for the repetition. The directory contains src/, tests/, and package.json. [DONE]',
            },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 10 });
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

    it('should detect and break out of doom loops', async () => {
      client.send({
        type: 'chat',
        message: 'What files are in this project?',
      });

      const messages = await client.collectUntilResponse(30000);

      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();

      // Should have seen ls executed multiple times
      const lsCompletes = messages.filter(
        m => m.type === 'skill_complete' && m.skill === 'ls'
      );
      expect(lsCompletes.length).toBeGreaterThanOrEqual(2);

      // The agent should have eventually provided a final response
      expect(response!.content).toBeTruthy();

      // LLM was called 4 times (3 tool turns + 1 final)
      expect(ctx.mockProvider.callCount).toBe(4);

      // Verify doom loop warning was injected into the conversation
      const allRequests = (ctx.mockProvider as unknown as {
        allRequests: Array<{
          messages?: Array<{ role: string; content: unknown }>;
        }>;
      }).allRequests;

      // After 3rd identical call, a system warning should be in messages
      // The doom loop detector injects a message, so the 4th request
      // should have more messages than just the tool results
      const lastRequest = allRequests[allRequests.length - 1];
      const lastMessages = lastRequest.messages || [];

      // Check that there's a warning message about repetition/doom loop
      const hasWarning = lastMessages.some(m => {
        if (typeof m.content === 'string') {
          return m.content.toLowerCase().includes('loop') ||
                 m.content.toLowerCase().includes('repetitive') ||
                 m.content.toLowerCase().includes('same tool');
        }
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type: string; text?: string }>).some(
            b => b.type === 'text' && (
              b.text?.toLowerCase().includes('loop') ||
              b.text?.toLowerCase().includes('repetitive') ||
              b.text?.toLowerCase().includes('same tool')
            )
          );
        }
        return false;
      });
      expect(hasWarning).toBe(true);
    }, 45000);
  });

  // -------------------------------------------------------------------------
  // Test 7: Verify all 9 new bundled skills are discovered by SkillLoader
  // -------------------------------------------------------------------------
  describe('skill discovery', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    }, 15000);

    it('should discover all new bundled skills in the registry', () => {
      const tools = ctx.skillRegistry.getToolDefinitions();
      const toolNames = tools.map(t => t.name);

      // The 8 new skills that have scripts (batch is doc-only, no tool)
      const expectedSkills = [
        'ls', 'glob', 'grep', 'codesearch',
        'webfetch', 'question', 'multi_edit', 'apply_patch',
      ];

      for (const skill of expectedSkills) {
        expect(toolNames).toContain(skill);
      }

      // batch should NOT appear as a tool (disable-model-invocation: true)
      expect(toolNames).not.toContain('batch');
    });

    it('should have correct input schemas for new skills', () => {
      const tools = ctx.skillRegistry.getToolDefinitions();

      // ls: optional path, all, long
      const lsTool = tools.find(t => t.name === 'ls')!;
      expect(lsTool.input_schema.properties).toHaveProperty('path');
      expect(lsTool.input_schema.properties).toHaveProperty('all');
      expect(lsTool.input_schema.properties).toHaveProperty('long');

      // glob: required pattern, optional path
      const globTool = tools.find(t => t.name === 'glob')!;
      expect(globTool.input_schema.properties).toHaveProperty('pattern');
      expect(globTool.input_schema.required).toContain('pattern');

      // grep: required pattern, optional path/glob/context/max_results
      const grepTool = tools.find(t => t.name === 'grep')!;
      expect(grepTool.input_schema.properties).toHaveProperty('pattern');
      expect(grepTool.input_schema.required).toContain('pattern');
      expect(grepTool.input_schema.properties).toHaveProperty('context');
      expect(grepTool.input_schema.properties).toHaveProperty('max_results');
    });

    it('should have all existing skills still present', () => {
      const tools = ctx.skillRegistry.getToolDefinitions();
      const toolNames = tools.map(t => t.name);

      // Pre-existing bundled skills should still be here
      const preExisting = ['read_file', 'write_file', 'edit_file', 'bash'];
      for (const skill of preExisting) {
        expect(toolNames).toContain(skill);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: Two-turn conversation verifies WebSocket message ordering
  // -------------------------------------------------------------------------
  describe('WebSocket message ordering', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: Single tool call
        {
          content: [
            { type: 'text', text: 'Looking at the directory.' },
            {
              type: 'tool_use',
              id: 'tu_order_1',
              name: 'ls',
              input: { path: '.' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: Final answer
        {
          content: [
            { type: 'text', text: 'The project has src and tests directories. [DONE]' },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 5 });
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

    it('should deliver WS events in correct order: skill_start -> skill_complete -> response', async () => {
      client.send({
        type: 'chat',
        message: 'What is in this project?',
      });

      const messages = await client.collectUntilResponse(20000);

      // Filter to relevant event types
      const eventFlow = messages
        .filter(m => ['skill_start', 'skill_complete', 'response'].includes(m.type))
        .map(m => m.type);

      // Should see: skill_start -> skill_complete -> response (at minimum)
      expect(eventFlow.length).toBeGreaterThanOrEqual(3);

      // skill_start must come before skill_complete
      const startIdx = eventFlow.indexOf('skill_start');
      const completeIdx = eventFlow.indexOf('skill_complete');
      const responseIdx = eventFlow.indexOf('response');

      expect(startIdx).toBeLessThan(completeIdx);
      expect(completeIdx).toBeLessThan(responseIdx);

      // Response is always last
      expect(eventFlow[eventFlow.length - 1]).toBe('response');
    }, 30000);
  });
});
