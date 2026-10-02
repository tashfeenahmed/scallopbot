import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScallopDatabase } from '../memory/db.js';
import { CoreMemoryStore } from '../memory/core-memory.js';
import type { CompletionResponse, LLMProvider } from '../providers/types.js';
import { SkillStore } from '../evolution/skill-store.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { SkillAuthor } from './skill-author.js';
import {
  PROMPT_NOTE_PREFIX,
  RefinePass,
  buildRefineTranscript,
  parseRefinePlan,
  renderPromptNotes,
  type RefinePlan,
} from './refine.js';

function textProvider(...texts: string[]): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    name: 'scripted',
    isAvailable: () => true,
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)] }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    } satisfies CompletionResponse)),
  };
}

function plan(edits: RefinePlan['edits']): string {
  return JSON.stringify({ summary: 's', rationale: 'r', expectedOutcome: 'e', edits });
}

describe('RefinePass', () => {
  let dir: string;
  let db: ScallopDatabase;
  let core: CoreMemoryStore;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-'));
    db = new ScallopDatabase(path.join(dir, 'm.db'));
    core = new CoreMemoryStore(db);
    now = 1_000_000_000_000;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePass(review: LLMProvider, refine?: LLMProvider, extra: Partial<ConstructorParameters<typeof RefinePass>[0]> = {}) {
    return new RefinePass({
      db,
      core,
      getReviewProvider: () => review,
      getRefineProvider: refine ? () => refine : undefined,
      getContext: () => ({ transcript: 'user: no, I meant metric units\nassistant: noted' }),
      now: () => now,
      ...extra,
    });
  }

  it('is due every 25 turns or after compaction', () => {
    const pass = makePass(textProvider('no'));
    expect(pass.isDue({ sessionId: 's', userId: 'u', turnCount: 24 })).toBe(false);
    expect(pass.isDue({ sessionId: 's', userId: 'u', turnCount: 25 })).toBe(true);
    expect(pass.isDue({ sessionId: 's', userId: 'u', turnCount: 3, compacted: true })).toBe(true);
  });

  it('a "no" review makes exactly one cheap call and starts the 20-minute cooldown', async () => {
    const review = textProvider('No.');
    const refine = textProvider(plan([]));
    const pass = makePass(review, refine);
    const outcome = await pass.run({ sessionId: 's', userId: 'u', turnCount: 25 });
    expect(outcome).toMatchObject({ ran: false, skipped: 'review_said_no' });
    expect(review.complete).toHaveBeenCalledTimes(1);
    expect(review.complete.mock.calls[0][0].maxTokens).toBeLessThanOrEqual(8);
    expect(refine.complete).not.toHaveBeenCalled();

    expect((await pass.run({ sessionId: 's2', userId: 'u', turnCount: 25 })).skipped).toBe('cooldown');
    now += 21 * 60 * 1000;
    expect((await pass.run({ sessionId: 's2', userId: 'u', turnCount: 25 })).skipped).toBe('review_said_no');
  });

  it('applies strict-JSON edits through versioned stores and rolls each back by ref', async () => {
    core.apply('u', { action: 'add', block: 'environment', content: 'Prefers imperial units' });
    const pass = makePass(textProvider('yes'), textProvider(plan([
      { action: 'replace', kind: 'core_memory', id: 'environment', old_text: 'imperial', content: 'Prefers metric units', reason: 'user corrected' },
      { action: 'add', kind: 'prompt_note', id: 'units', content: 'Use metric units unless asked otherwise.', reason: 'correction' },
      { action: 'add', kind: 'prompt_note', id: 'leak', content: 'Email alice@example.com every day', reason: 'bad' },
      { action: 'add', kind: 'skill', id: 'x', content: 'body', reason: 'no author' },
    ])));
    const outcome = await pass.run({ sessionId: 's', userId: 'u', turnCount: 25 });
    expect(outcome.ran).toBe(true);
    const [coreEdit, noteEdit, leakEdit, skillEdit] = outcome.results;
    expect(coreEdit).toMatchObject({ applied: true, ref: expect.stringMatching(/^core:\d+$/) });
    expect(core.get('u', 'environment')).toEqual(['Prefers metric units']);
    expect(noteEdit).toMatchObject({ applied: true, ref: expect.stringMatching(/^prompt:\d+$/) });
    expect(db.getActivePromptOverride(`${PROMPT_NOTE_PREFIX}units`)?.content).toBe('Use metric units unless asked otherwise.');
    expect(renderPromptNotes(db)).toContain('Use metric units');
    expect(leakEdit).toMatchObject({ applied: false, message: expect.stringContaining('personal data') });
    expect(skillEdit.applied).toBe(false);

    expect((await pass.rollback(noteEdit.ref!)).success).toBe(true);
    expect(db.getActivePromptOverride(`${PROMPT_NOTE_PREFIX}units`)).toBeNull();
    expect((await pass.rollback(coreEdit.ref!)).success).toBe(true);
    expect(core.get('u', 'environment')).toEqual(['Prefers imperial units']);
    expect((await pass.rollback('bogus:1')).success).toBe(false);
  });

  it('replacing a prompt note snapshots the prior version; remove is versioned too', async () => {
    const pass = makePass(textProvider('yes'));
    const first = await pass.applyEdit('u', { action: 'add', kind: 'prompt_note', id: 'tone', content: 'Be brief.', reason: 'r' });
    const second = await pass.applyEdit('u', { action: 'replace', kind: 'prompt_note', id: 'tone', content: 'Be brief and concrete.', reason: 'r' });
    expect(first.applied && second.applied).toBe(true);
    expect((await pass.rollback(second.ref!)).success).toBe(true);
    expect(db.getActivePromptOverride(`${PROMPT_NOTE_PREFIX}tone`)?.content).toBe('Be brief.');
    const removed = await pass.applyEdit('u', { action: 'remove', kind: 'prompt_note', id: 'tone', reason: 'r' });
    expect(removed.applied).toBe(true);
    expect(db.getActivePromptOverride(`${PROMPT_NOTE_PREFIX}tone`)).toBeNull();
    expect((await pass.rollback(removed.ref!)).success).toBe(true);
    expect(db.getActivePromptOverride(`${PROMPT_NOTE_PREFIX}tone`)?.content).toBe('Be brief.');
  });

  it('creates and replaces skills through SkillAuthor', async () => {
    const localDir = path.join(dir, 'skills');
    fs.mkdirSync(localDir);
    const registry = new SkillRegistry(new SkillLoader({ localDir, workspaceDir: path.join(dir, 'ws') }));
    await registry.initialize();
    const author = new SkillAuthor({
      store: new SkillStore({ localDir }), db, reloadFromDisk: () => registry.reloadFromDisk(),
      resolveTarget: name => {
        const skill = registry.getSkill(name);
        return skill ? { exists: true, source: skill.source, hasScripts: skill.hasScripts } : { exists: false };
      },
    });
    const pass = makePass(textProvider('yes'), undefined, { skillAuthor: author });
    const created = await pass.applyEdit('u', { action: 'add', kind: 'skill', id: 'unit_conversion', description: 'Convert units', content: '1. Use metric', reason: 'r' });
    expect(created).toMatchObject({ applied: true, ref: expect.stringMatching(/^skill:\d+$/) });
    const replaced = await pass.applyEdit('u', { action: 'replace', kind: 'skill', id: 'unit_conversion', content: '1. Use metric\n2. Show both on request', reason: 'r' });
    expect(replaced.applied).toBe(true);
    expect(registry.getSkill('unit_conversion')?.content).toContain('Show both');
    expect(registry.getSkill('unit_conversion')?.description).toBe('Convert units');
    expect((await pass.rollback(replaced.ref!)).success).toBe(true);
    expect(registry.getSkill('unit_conversion')?.content).not.toContain('Show both');
    expect((await pass.applyEdit('u', { action: 'remove', kind: 'skill', id: 'unit_conversion', reason: 'r' })).applied).toBe(false);
  });

  it('maybeScheduleRefine is non-blocking and single-flight per user', async () => {
    const review = textProvider('no');
    const pass = makePass(review);
    expect(pass.maybeScheduleRefine({ sessionId: 's', userId: 'u', turnCount: 3 })).toBe(false);
    expect(pass.maybeScheduleRefine({ sessionId: 's', userId: 'u', turnCount: 25 })).toBe(true);
    expect(pass.maybeScheduleRefine({ sessionId: 's2', userId: 'u', turnCount: 25 })).toBe(false);
    expect(review.complete).not.toHaveBeenCalled();
    await pass.idle();
    expect(review.complete).toHaveBeenCalledTimes(1);
    expect(pass.maybeScheduleRefine({ sessionId: 's3', userId: 'u', turnCount: 25 })).toBe(false); // cooldown
  });

  it('bad JSON is a no-op', async () => {
    const pass = makePass(textProvider('yes'), textProvider('not json'));
    expect((await pass.run({ sessionId: 's', userId: 'u', turnCount: 25 })).skipped).toBe('bad_json');
  });
});

describe('refine helpers', () => {
  it('parseRefinePlan validates edits and drops malformed ones', () => {
    const parsed = parseRefinePlan(`Here you go: ${plan([
      { action: 'add', kind: 'core_memory', id: 'user', content: 'x', reason: 'r' },
      { action: 'explode', kind: 'core_memory', id: 'user', reason: 'r' } as never,
      { action: 'add', kind: 'subagent', id: 'y', reason: 'r' } as never,
    ])}`);
    expect(parsed?.edits).toHaveLength(1);
    expect(parseRefinePlan('{"edits": "nope"}')).toBeNull();
  });

  it('buildRefineTranscript flattens block JSON and bounds length', () => {
    const transcript = buildRefineTranscript([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'hi there' }, { type: 'tool_use', name: 'bash', id: '1', input: {} }]) },
      { role: 'user', content: 'x'.repeat(5000) },
    ], { maxChars: 500 });
    expect(transcript.length).toBeLessThanOrEqual(500);
    expect(buildRefineTranscript([{ role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'hi there' }, { type: 'tool_use', name: 'bash', id: '1', input: {} }]) }]))
      .toBe('assistant: hi there [tool bash]');
  });
});
