/**
 * E2E: Skill Hot-Loading via manage_skills
 *
 * Validates that the agent can search + install a ClawHub skill at runtime
 * and that the newly installed skill appears in tool definitions on the
 * very next iteration — without a restart.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
  type MockCompletionResponse,
} from './helpers.js';
import { defineSkill } from '../skills/sdk.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake skill directory on disk so that reloadFromDisk() picks it up.
 * Mimics what SkillPackageManager.installFromClawHub writes.
 */
async function writeFakeSkillToDisk(skillsDir: string, name: string): Promise<void> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });

  const skillMd = `---
name: ${name}
description: A test skill installed from ClawHub
scripts:
  run: scripts/run.sh
---

Instructions for ${name}.
`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

  // Create a scripts dir so hasScripts is true
  const scriptsDir = path.join(skillDir, 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, 'run.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });
}

// The e2e gateway uses /tmp as workspace, so the SkillLoader scans
// /tmp/.scallopbot/skills/ for workspace skills. Write fake skills there.
const WORKSPACE_SKILLS_DIR = '/tmp/.scallopbot/skills';

// ============================================================================
// Test Suite
// ============================================================================
describe('E2E Skill Hot-Loading', () => {

  afterAll(async () => {
    // Clean up any fake skills written during tests
    await fs.rm(WORKSPACE_SKILLS_DIR, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // Scenario 1: search + install flow over WebSocket
  // --------------------------------------------------------------------------
  describe('Scenario 1: Agent searches and installs a skill', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      // Mock LLM conversation:
      //  Turn 1 — LLM calls manage_skills(action=search, query="weather")
      //  Turn 2 — LLM sees search results, calls manage_skills(action=install, slug="acme/weather")
      //  Turn 3 — LLM confirms install succeeded
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: agent decides to search
        {
          content: [
            { type: 'text', text: 'Let me search ClawHub for weather skills.' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'manage_skills',
              input: { action: 'search', query: 'weather' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: agent decides to install
        {
          content: [
            { type: 'text', text: 'Found a weather skill — installing it now.' },
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'manage_skills',
              input: { action: 'install', slug: 'acme/weather' },
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 3: agent wraps up
        {
          content: [
            { type: 'text', text: 'Done! The weather skill is now installed and ready. [DONE]' },
          ],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 10 });

      // Register the manage_skills skill the same way the real gateway does,
      // but with a STUB SkillPackageManager that writes to our temp dir instead
      // of actually hitting the ClawHub API.
      const registry = ctx.skillRegistry;

      const skill = defineSkill(
        'manage_skills',
        'Search, install, uninstall, or list skills from ClawHub.'
      )
        .userInvocable(false)
        .inputSchema({
          type: 'object',
          properties: {
            action: { type: 'string', description: 'One of: search, install, uninstall, list' },
            query: { type: 'string', description: 'Search query' },
            slug: { type: 'string', description: 'Skill slug e.g. "owner/skill-name"' },
          },
          required: ['action'],
        })
        .onNativeExecute(async (ctxArg) => {
          const action = ctxArg.args.action as string;

          switch (action) {
            case 'search': {
              // Return fake search results
              const fakeResults = [
                { slug: 'acme/weather', displayName: 'Weather', summary: 'Get weather forecasts' },
              ];
              return { success: true, output: JSON.stringify(fakeResults, null, 2) };
            }

            case 'install': {
              // Write a fake skill to the workspace skills dir, then reload
              const slug = ctxArg.args.slug as string;
              const name = slug.split('/').pop()!;
              await writeFakeSkillToDisk(WORKSPACE_SKILLS_DIR, name);
              await registry.reloadFromDisk();
              return { success: true, output: `Installed "${slug}"` };
            }

            case 'uninstall': {
              return { success: true, output: `Uninstalled "${ctxArg.args.slug}"` };
            }

            case 'list': {
              return { success: true, output: 'No skills installed' };
            }

            default:
              return { success: false, output: `Unknown action: ${action}` };
          }
        })
        .build();

      registry.registerSkill(skill.skill);
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

    it('should search ClawHub, install a skill, and hot-load it', async () => {
      // Before: manage_skills is the only executable SDK skill
      const toolsBefore = ctx.skillRegistry.getToolDefinitions();
      const manageSkillTool = toolsBefore.find(t => t.name === 'manage_skills');
      expect(manageSkillTool).toBeDefined();

      // "weather" skill should NOT be present yet
      expect(toolsBefore.find(t => t.name === 'weather')).toBeUndefined();

      // Send chat message
      client.send({ type: 'chat', message: 'Find and install a weather skill from ClawHub' });
      const messages = await client.collectUntilResponse(20000);

      // Verify we saw manage_skills being called
      const skillStarts = messages.filter(m => m.type === 'skill_start' && m.skill === 'manage_skills');
      expect(skillStarts.length).toBeGreaterThanOrEqual(2); // search + install

      // Verify skill_complete for the install action
      const skillCompletes = messages.filter(m => m.type === 'skill_complete' && m.skill === 'manage_skills');
      expect(skillCompletes.length).toBeGreaterThanOrEqual(2);
      const installComplete = skillCompletes.find(m => m.output?.includes('Installed'));
      expect(installComplete).toBeDefined();

      // Verify final response
      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toContain('weather');

      // After: the "weather" skill should now be in the registry
      const toolsAfter = ctx.skillRegistry.getToolDefinitions();
      const weatherTool = toolsAfter.find(t => t.name === 'weather');
      expect(weatherTool).toBeDefined();
      expect(weatherTool!.description).toContain('test skill installed from ClawHub');

      // manage_skills (SDK skill) should still be present after reloadFromDisk
      const manageSkillAfter = toolsAfter.find(t => t.name === 'manage_skills');
      expect(manageSkillAfter).toBeDefined();

      // The mock LLM should have been called 3 times (search turn, install turn, final turn)
      expect(ctx.mockProvider.callCount).toBe(3);
    }, 30000);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: reloadFromDisk preserves all SDK skills
  // --------------------------------------------------------------------------
  describe('Scenario 2: SDK skills survive reloadFromDisk', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });

      // Register several SDK skills
      for (const name of ['skill_a', 'skill_b', 'skill_c']) {
        const s = defineSkill(name, `Test SDK skill ${name}`)
          .userInvocable(false)
          .onNativeExecute(async () => ({ success: true, output: 'ok' }))
          .build();
        ctx.skillRegistry.registerSkill(s.skill);
      }
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    }, 15000);

    it('should preserve SDK skills after reloadFromDisk', async () => {
      const before = ctx.skillRegistry.getToolDefinitions().map(t => t.name).sort();
      expect(before).toContain('skill_a');
      expect(before).toContain('skill_b');
      expect(before).toContain('skill_c');

      // Reload from disk
      await ctx.skillRegistry.reloadFromDisk();

      const after = ctx.skillRegistry.getToolDefinitions().map(t => t.name).sort();
      expect(after).toContain('skill_a');
      expect(after).toContain('skill_b');
      expect(after).toContain('skill_c');
    });

    it('should wipe SDK skills with plain reload()', async () => {
      expect(ctx.skillRegistry.getToolDefinitions().find(t => t.name === 'skill_a')).toBeDefined();

      // Plain reload clears everything
      await ctx.skillRegistry.reload();

      const after = ctx.skillRegistry.getToolDefinitions();
      expect(after.find(t => t.name === 'skill_a')).toBeUndefined();
      expect(after.find(t => t.name === 'skill_b')).toBeUndefined();
      expect(after.find(t => t.name === 'skill_c')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Tool definitions refresh each iteration
  // --------------------------------------------------------------------------
  describe('Scenario 3: Tools refresh mid-loop', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      // Turn 1: LLM calls a tool. During execution, a new skill gets registered.
      // Turn 2: LLM sees the new tool in its available tools (via refreshed definitions).
      const scenarioResponses: MockCompletionResponse[] = [
        // Turn 1: call the "register_new_skill" meta-tool
        {
          content: [
            { type: 'text', text: 'Registering a new skill mid-loop.' },
            {
              type: 'tool_use',
              id: 'tu_reg',
              name: 'register_new_skill',
              input: {},
            },
          ],
          stopReason: 'tool_use',
        },
        // Turn 2: LLM wraps up. We'll verify the tools sent in this request.
        {
          content: [{ type: 'text', text: 'New skill is ready. [DONE]' }],
          stopReason: 'end_turn',
        },
      ];

      ctx = await createE2EGateway({ scenarioResponses, maxIterations: 10 });

      // Register a meta-tool that dynamically adds another skill during execution
      const registry = ctx.skillRegistry;
      const metaSkill = defineSkill('register_new_skill', 'Registers a dynamic skill at runtime')
        .userInvocable(false)
        .inputSchema({ type: 'object', properties: {}, required: [] })
        .onNativeExecute(async () => {
          // Dynamically register a new tool mid-loop
          const dynamic = defineSkill('dynamic_tool', 'A dynamically registered tool')
            .userInvocable(false)
            .inputSchema({ type: 'object', properties: { x: { type: 'string' } }, required: [] })
            .onNativeExecute(async () => ({ success: true, output: 'dynamic!' }))
            .build();
          registry.registerSkill(dynamic.skill);
          return { success: true, output: 'Registered dynamic_tool' };
        })
        .build();
      registry.registerSkill(metaSkill.skill);
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

    it('should see newly registered tools on the next LLM call', async () => {
      // Before: only register_new_skill exists
      expect(ctx.skillRegistry.getToolDefinitions().find(t => t.name === 'dynamic_tool')).toBeUndefined();

      client.send({ type: 'chat', message: 'Register a new skill' });
      const messages = await client.collectUntilResponse(15000);

      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();

      // After: dynamic_tool should be in the registry
      expect(ctx.skillRegistry.getToolDefinitions().find(t => t.name === 'dynamic_tool')).toBeDefined();

      // Verify the second LLM call included dynamic_tool in its tools list
      const allRequests = (ctx.mockProvider as unknown as { allRequests: Array<{ tools?: Array<{ name: string }> }> }).allRequests;
      expect(allRequests.length).toBe(2);

      // The second request (Turn 2) should have dynamic_tool in its tools
      const secondRequestTools = allRequests[1].tools?.map(t => t.name) ?? [];
      expect(secondRequestTools).toContain('dynamic_tool');
      expect(secondRequestTools).toContain('register_new_skill');
    }, 20000);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Runtime key vault enables a gated skill
  // --------------------------------------------------------------------------
  describe('Scenario 4: Key vault enables gated skill', () => {
    let ctx: E2EGatewayContext;
    const ENV_KEY = 'TEST_VAULT_KEY_E2E';

    /**
     * Write a skill with an env gate so it requires TEST_VAULT_KEY_E2E.
     */
    async function writeGatedSkillToDisk(skillsDir: string): Promise<void> {
      const skillDir = path.join(skillsDir, 'gated-skill');
      await fs.mkdir(skillDir, { recursive: true });

      const skillMd = `---
name: gated-skill
description: A gated test skill that requires an API key
metadata:
  openclaw:
    requires:
      env:
        - ${ENV_KEY}
scripts:
  run: scripts/run.sh
---

Instructions for gated-skill.
`;
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'run.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });
    }

    beforeAll(async () => {
      // Ensure the env var is NOT set
      delete process.env[ENV_KEY];

      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });

      // Write the gated skill to disk
      await writeGatedSkillToDisk(WORKSPACE_SKILLS_DIR);

      // Reload so the loader picks it up (gate will fail — env missing)
      await ctx.skillRegistry.reloadFromDisk();
    }, 30000);

    afterAll(async () => {
      // Cleanup: remove env var and test DB
      delete process.env[ENV_KEY];
      await cleanupE2E(ctx);
      await fs.rm(path.join(WORKSPACE_SKILLS_DIR, 'gated-skill'), { recursive: true, force: true }).catch(() => {});
    }, 15000);

    it('should unlock a gated skill after setting an API key via the vault', async () => {
      const db = ctx.scallopStore.getDatabase();

      // 1. Skill should NOT be available (env gate fails)
      const toolsBefore = ctx.skillRegistry.getToolDefinitions();
      expect(toolsBefore.find(t => t.name === 'gated-skill')).toBeUndefined();

      // 2. Set the key via the vault (same as manage_skills set_key handler)
      db.setRuntimeKey(ENV_KEY, 'test-secret-123');
      process.env[ENV_KEY] = 'test-secret-123';

      // 3. Reload — gate should now pass
      await ctx.skillRegistry.reloadFromDisk();

      const toolsAfter = ctx.skillRegistry.getToolDefinitions();
      const gatedTool = toolsAfter.find(t => t.name === 'gated-skill');
      expect(gatedTool).toBeDefined();
      expect(gatedTool!.description).toContain('gated test skill');

      // 4. Verify key is persisted in DB
      expect(db.getRuntimeKey(ENV_KEY)).toBe('test-secret-123');
      expect(db.getAllRuntimeKeys().find(k => k.key === ENV_KEY)).toBeDefined();

      // 5. Remove the key — skill should become unavailable again
      db.deleteRuntimeKey(ENV_KEY);
      delete process.env[ENV_KEY];
      await ctx.skillRegistry.reloadFromDisk();

      const toolsAfterRemove = ctx.skillRegistry.getToolDefinitions();
      expect(toolsAfterRemove.find(t => t.name === 'gated-skill')).toBeUndefined();

      // 6. Key should be gone from DB
      expect(db.getRuntimeKey(ENV_KEY)).toBeNull();
    });
  });
});
