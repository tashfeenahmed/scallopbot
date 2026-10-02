import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { createLoadProcedureSkill } from '../evolution/procedure-skill.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { LearningRuntime, replayFromSessionRows } from './index.js';

describe('LearningRuntime', () => {
  let dir: string;
  let store: ScallopMemoryStore;
  let registry: SkillRegistry;
  let runtime: LearningRuntime;
  let provider: LLMProvider & { complete: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-'));
    const localSkillsDir = path.join(dir, 'skills');
    fs.mkdirSync(localSkillsDir);
    store = new ScallopMemoryStore({ dbPath: path.join(dir, 'm.db'), logger: pino({ level: 'silent' }) });
    registry = new SkillRegistry(new SkillLoader({ localDir: localSkillsDir, workspaceDir: path.join(dir, 'ws') }));
    await registry.initialize();
    registry.registerSkill(createLoadProcedureSkill(registry));
    provider = {
      name: 'p',
      isAvailable: () => true,
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Nothing to save.' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm',
      } satisfies CompletionResponse)),
    };
    runtime = new LearningRuntime({
      db: store.getDatabase(),
      scallopStore: store,
      registry,
      workspace: dir,
      localSkillsDir,
      getReviewProvider: () => provider,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers memory + skill_manage and exposes only learning tools to reviews', () => {
    const { coreMemory, skillManage } = runtime.registerTools();
    expect(coreMemory.name).toBe('memory');
    expect(skillManage.name).toBe('skill_manage');
    expect(registry.getSkill('memory')).toBeDefined();
    expect(runtime.reviewTools().map(tool => tool.definition.name).sort())
      .toEqual(['load_procedure', 'memory', 'read_file', 'skill_manage']);
  });

  it('seeds core memory from the profile at session start and renders the frozen block', () => {
    store.getProfileManager().setStaticValue('u1', 'name', 'Tash');
    const block = runtime.renderSessionCoreMemory('u1');
    expect(block).toContain('## CORE MEMORY — user');
    expect(block).toContain('- Name: Tash');
  });

  it('reviews fall back to persisted text messages until the agent supplies a replay', async () => {
    runtime.registerTools();
    const db = store.getDatabase();
    db.createSession('s1');
    db.addSessionMessage('s1', 'user', 'hello');
    db.addSessionMessage('s1', 'assistant', JSON.stringify([{ type: 'text', text: 'hi' }]));
    const summary = await runtime.reviewer.runReview('s1', 'u1', ['turns']);
    expect(summary.error).toBeUndefined();
    const request = provider.complete.mock.calls[0][0];
    expect(request.messages.slice(0, 2)).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);

    runtime.setReplaySource(() => ({ system: 'FROZEN', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }));
    await runtime.reviewer.runReview('s1', 'u1', ['turns']);
    expect(provider.complete.mock.calls[1][0].system).toBe('FROZEN');
  });

  it('replayFromSessionRows merges same-role rows and starts with a user turn', () => {
    expect(replayFromSessionRows([
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'system', content: 'ignored' },
      { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: '1', name: 'x', input: {} }]) },
      { role: 'assistant', content: 'done' },
    ])).toEqual([{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'done' }]);
  });
});
