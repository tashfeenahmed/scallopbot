import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Agent } from './agent.js';
import { SessionManager } from './session.js';
import { ScallopDatabase } from '../memory/db.js';
import { createSkillRegistry } from '../skills/registry.js';
import { defineSkill } from '../skills/sdk.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';

describe('Agent dispatch policy boundary', () => {
  let db: ScallopDatabase;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
  });

  afterEach(() => db.close());

  it('blocks a denied tool even when the model emits a hidden/hallucinated call', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'should not execute' });
    const registry = createSkillRegistry('/tmp/dispatch-policy-empty', pino({ level: 'silent' }));
    await registry.initialize();
    registry.registerSkill(defineSkill('secret_tool', 'denied test tool')
      .onNativeExecute(handler)
      .build().skill);

    const responses: CompletionResponse[] = [
      {
        content: [{ type: 'tool_use', id: 'denied-1', name: 'secret_tool', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test',
      },
      {
        content: [{ type: 'text', text: 'The tool was blocked.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test',
      },
    ];
    const provider: LLMProvider = {
      name: 'test',
      isAvailable: () => true,
      complete: vi.fn(async () => responses.shift()!),
    };
    const sessions = new SessionManager(db);
    const session = await sessions.createSession({ channelId: 'api' });
    const agent = new Agent({
      provider,
      sessionManager: sessions,
      skillRegistry: registry,
      workspace: '/tmp',
      logger: pino({ level: 'silent' }),
      maxIterations: 4,
      toolPolicy: { deny: ['secret_tool'] },
    });

    const result = await agent.processMessage(session.id, 'Run the secret tool');
    expect(result.response).toBe('The tool was blocked.');
    expect(handler).not.toHaveBeenCalled();
    const stored = await sessions.getSession(session.id);
    expect(JSON.stringify(stored?.messages)).toContain('not permitted');
  });
});
