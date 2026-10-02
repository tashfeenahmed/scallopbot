/**
 * Phase 6 delegation: async spawn, fan-in through files, message headers,
 * no-reply exits, depth/concurrency limits, check_agents, progress notes and
 * grandchild resume — all with fake providers.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { SubAgentExecutor } from './executor.js';
import { SubAgentRegistry } from './registry.js';
import { AnnounceQueue } from './announce-queue.js';
import { createSubAgentSkills } from './tools.js';
import {
  formatAgentResult,
  formatAgentExited,
  formatAnnounceEntry,
  isHarnessMessage,
  AGENT_RESULT_MAX_CHARS,
  SPAWN_ACK_INSTRUCTION,
} from './messages.js';
import { agentReportPath } from './report.js';
import { SessionWaker, type WakeTurnRequest } from '../gateway/wake.js';
import type { AnnounceEntry, SubAgentConfig } from './types.js';
import { SessionManager } from '../agent/session.js';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { Router } from '../routing/router.js';
import { createSkillRegistry } from '../skills/registry.js';
import { createSkillExecutor } from '../skills/executor.js';
import type { Skill } from '../skills/types.js';
import type { LLMProvider, CompletionRequest, CompletionResponse, ContentBlock } from '../providers/types.js';
import { flattenSystem } from '../providers/types.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';

const logger = pino({ level: 'silent' });

function embedder(): EmbeddingProvider {
  const embed = (text: string) => {
    const vec = new Array(32).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 32] += text.charCodeAt(i);
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    return vec.map((v: number) => v / mag);
  };
  return {
    name: 'mock', dimension: 32,
    async embed(text: string) { return embed(text); },
    async embedBatch(texts: string[]) { return texts.map(embed); },
    isAvailable() { return true; },
  };
}

function text(value: string): CompletionResponse {
  return { content: [{ type: 'text', text: value }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, model: 'mock' };
}

function toolUse(name: string, input: Record<string, unknown>, id = `tu-${Math.random().toString(36).slice(2)}`): CompletionResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, model: 'mock' };
}

/** Provider whose answer is chosen by a function of the request. */
function scriptedProvider(script: (request: CompletionRequest) => Promise<CompletionResponse> | CompletionResponse): LLMProvider & { requests: CompletionRequest[] } {
  const provider = {
    name: 'openai',
    requests: [] as CompletionRequest[],
    isAvailable: () => true,
    async complete(request: CompletionRequest) {
      provider.requests.push(request);
      return script(request);
    },
  };
  return provider;
}

/** A gate the test opens to let blocked children finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

function lastUserText(request: CompletionRequest): string {
  const last = [...request.messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string'
    ? last.content
    : (last.content as ContentBlock[]).map(b => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '')).join('\n');
}

let store: ScallopMemoryStore;
let sessionManager: SessionManager;
let dbPath: string;
let workspace: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `delegation-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new ScallopMemoryStore({ dbPath, logger, embedder: embedder() });
  sessionManager = new SessionManager(store.getDatabase());
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-ws-'));
});

afterAll(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function setup(provider: LLMProvider, config: Partial<SubAgentConfig> = {}, onResultReady?: (entry: AnnounceEntry) => void) {
  const skillRegistry = createSkillRegistry(workspace, logger);
  await skillRegistry.initialize();
  const router = new Router({});
  router.registerProvider(provider);
  const registry = new SubAgentRegistry({ logger, config });
  const announceQueue = new AnnounceQueue({ logger, maxQueueSize: 50 });
  const executor = new SubAgentExecutor({
    registry,
    announceQueue,
    sessionManager,
    skillRegistry,
    skillExecutor: createSkillExecutor(logger),
    router,
    workspace,
    logger,
    config,
    onResultReady,
  });
  const tools = createSubAgentSkills({ registry, executor, sessionManager, logger });
  for (const skill of tools) skillRegistry.registerSkill(skill);
  const tool = (name: string) => tools.find(s => s.name === name) as Skill;
  const call = (name: string, sessionId: string, args: Record<string, unknown>) =>
    tool(name).handler!({ args, sessionId, workspace });
  return { executor, registry, announceQueue, skillRegistry, call };
}

// ---------------------------------------------------------------------------

describe('message headers', () => {
  it('formats agent results as labelled self-reports', () => {
    const message = formatAgentResult('fix-tests', 'All 12 tests pass.', { runId: 'r1', reportPath: '/w/r.md' });
    expect(message.startsWith('[agent-result: fix-tests] (self-report — verify before relying on it)\nAll 12 tests pass.')).toBe(true);
    expect(message).toContain('[full report: /w/r.md]');
    expect(message).toContain('[run r1]');
    expect(isHarnessMessage(message)).toBe(true);
  });

  it('caps at 24k by default and at 50% of the remaining room, pointing to the file on overflow', () => {
    const report = 'x'.repeat(30_000);
    const capped = formatAgentResult('big', report, { reportPath: '/w/big.md' });
    const body = capped.split('\n')[1];
    expect(body.length).toBeLessThanOrEqual(AGENT_RESULT_MAX_CHARS);
    expect(capped).toContain('the full report is at /w/big.md');

    const tight = formatAgentResult('big', report, { reportPath: '/w/big.md', remainingContextChars: 10_000 });
    expect(tight.length).toBeLessThan(5_300);
    expect(tight).toContain('/w/big.md');

    const roomy = formatAgentResult('small', 'short', { remainingContextChars: 1_000_000 });
    expect(roomy).not.toContain('truncated');
  });

  it('formats no-reply exits with the tail of the last text', () => {
    const message = formatAgentExited('crawler', `${'a'.repeat(5_000)}LAST WORDS`, { reason: 'timed_out' });
    expect(message.startsWith('[agent-exited: no-reply crawler]\n')).toBe(true);
    expect(message).toContain('Reason: timed_out');
    expect(message).toContain('LAST WORDS');
    expect(message.length).toBeLessThan(2_300);
    expect(isHarnessMessage('[bash-done 123 exit=0]')).toBe(true);
    expect(isHarnessMessage('hello [agent-result: x]')).toBe(false);
  });
});

describe('async delegation', () => {
  it('spawn_agent returns a running handle immediately and the result arrives later with a report file', async () => {
    const release = gate();
    const provider = scriptedProvider(async () => {
      await release.opened;
      return text('{"status":"succeeded","summary":"Found 3 broken imports and fixed them.","acceptancePassed":true} [DONE]');
    });
    const ready: AnnounceEntry[] = [];
    const { registry, announceQueue, call } = await setup(provider, {}, entry => ready.push(entry));
    const parent = await sessionManager.createSession({ label: 'parent' });

    const started = Date.now();
    const out = await call('spawn_agent', parent.id, { task: 'Fix the broken imports in src/', name: 'imports' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.success).toBe(true);
    const handle = JSON.parse(out.output.split('\n')[0]);
    expect(handle).toMatchObject({ name: 'imports', status: 'running' });
    expect(out.output).toContain(SPAWN_ACK_INSTRUCTION);
    expect(out.output).toContain('never poll or sleep');
    await vi.waitFor(() => expect(registry.getRun(handle.id)?.status).toBe('running'));
    expect(announceQueue.hasPending(parent.id)).toBe(false);

    release.open();
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true));
    const [entry] = announceQueue.drain(parent.id);
    expect(entry.kind).toBe('agent-result');
    expect(ready.map(e => e.runId)).toContain(handle.id);
    const message = formatAnnounceEntry(entry);
    expect(message.startsWith('[agent-result: imports] (self-report — verify before relying on it)')).toBe(true);
    expect(message).toContain('Found 3 broken imports');

    const file = agentReportPath(workspace, parent.id, 'imports');
    expect(entry.reportPath).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toContain('Found 3 broken imports');
    expect(announceQueue.wasDrained(parent.id, handle.id)).toBe(true);
  });

  it('uses the standard tier and 60 iterations by default and keeps the parent tool policy', async () => {
    const provider = scriptedProvider(() => text('done [DONE]'));
    const { executor, registry } = await setup(provider);
    expect(executor.getConfig()).toMatchObject({ defaultModelTier: 'standard', maxIterations: 60, maxConcurrentPerSession: 8, maxSpawnDepth: 2 });
    const parent = await sessionManager.createSession({ label: 'parent' });
    const result = await executor.spawnAndWait(parent.id, { task: 'Say done', label: 'tier' });
    expect(result.status).toBe('succeeded');
    const run = registry.getRunsForParent(parent.id)[0];
    expect(run.modelTier).toBe('standard');
    const system = flattenSystem(provider.requests[0].system!);
    expect(system).toContain('up to 60 iterations');
    const tools = (provider.requests[0].tools ?? []).map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['bash', 'write_file', 'progress_note', 'spawn_agent', 'check_agents']));
  });

  it('reports a crashed child as [agent-exited: no-reply name] with its last text', async () => {
    const provider = scriptedProvider(() => text('never used'));
    const { executor, announceQueue } = await setup(provider, { maxInputTokens: 0 });
    const parent = await sessionManager.createSession({ label: 'parent' });
    const { runId } = await executor.spawn(parent.id, { task: 'Do a big crawl', label: 'crawler' });
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true));
    const [entry] = announceQueue.drain(parent.id);
    expect(entry.runId).toBe(runId);
    expect(entry.kind).toBe('agent-exited');
    const message = formatAnnounceEntry(entry);
    expect(message.startsWith('[agent-exited: no-reply crawler]\n')).toBe(true);
    expect(message).toMatch(/token budget/);
    expect(fs.existsSync(agentReportPath(workspace, parent.id, 'crawler'))).toBe(true);
  });

  it('reports a child that runs out of iterations without a final answer as no-reply', async () => {
    const target = path.join(workspace, 'loop.txt');
    fs.writeFileSync(target, 'content');
    let n = 0;
    const provider = scriptedProvider(() => toolUse('read_file', { path: target, offset: n++ }));
    const { executor, announceQueue } = await setup(provider, { maxIterations: 2 });
    const parent = await sessionManager.createSession({ label: 'parent' });
    await executor.spawn(parent.id, { task: 'Keep reading forever', label: 'looper' });
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true), { timeout: 10_000 });
    const [entry] = announceQueue.drain(parent.id);
    expect(formatAnnounceEntry(entry)).toMatch(/^\[agent-exited: no-reply looper\]/);
  });

  it('caps concurrent children per parent at 8', async () => {
    const release = gate();
    const provider = scriptedProvider(async () => { await release.opened; return text('ok [DONE]'); });
    const { call, registry } = await setup(provider, { maxConcurrentGlobal: 50 });
    const parent = await sessionManager.createSession({ label: 'parent' });
    for (let i = 0; i < 8; i++) {
      const out = await call('spawn_agent', parent.id, { task: `Parallel task number ${i}`, name: `w${i}` });
      expect(out.success).toBe(true);
    }
    const ninth = await call('spawn_agent', parent.id, { task: 'One task too many', name: 'w8' });
    expect(ninth.success).toBe(false);
    expect(ninth.error).toMatch(/Maximum concurrent sub-agents per session reached \(8\)/);
    release.open();
    await vi.waitFor(() => expect(registry.getActiveRunsForParent(parent.id)).toHaveLength(0));
  });

  it('lets children spawn grandchildren but not deeper (depth 2)', async () => {
    const release = gate();
    const provider = scriptedProvider(async () => { await release.opened; return text('ok [DONE]'); });
    const { call, registry } = await setup(provider);
    const parent = await sessionManager.createSession({ label: 'parent' });
    const child = JSON.parse((await call('spawn_agent', parent.id, { task: 'Child level task', name: 'child' })).output.split('\n')[0]);
    const childRun = registry.getRun(child.id)!;
    expect(childRun.role).toBe('orchestrator');

    const grand = await call('spawn_agent', childRun.childSessionId, { task: 'Grandchild level task', name: 'grand' });
    expect(grand.success).toBe(true);
    const grandRun = registry.getRun(JSON.parse(grand.output.split('\n')[0]).id)!;
    expect(grandRun.role).toBe('leaf');

    const great = await call('spawn_agent', grandRun.childSessionId, { task: 'Great-grandchild task', name: 'great' });
    expect(great.success).toBe(false);
    expect(great.error).toMatch(/orchestrator|depth/i);
    release.open();
    await vi.waitFor(() => expect(registry.getActiveRunsForParent(parent.id)).toHaveLength(0));
  });

  it('resumes a child with its grandchild result and delivers the child final answer to the parent', async () => {
    const provider = scriptedProvider(request => {
      const system = flattenSystem(request.system!);
      const last = lastUserText(request);
      if (system.includes('GRANDCHILD-JOB')) return text('{"status":"succeeded","summary":"grand says hello","acceptancePassed":true} [DONE]');
      if (last.includes('[agent-result: gc]')) return text('The child relays hello from gc. [DONE]');
      if (last.includes('"status":"running"')) return text('Waiting for gc.');
      return toolUse('spawn_agent', { task: 'GRANDCHILD-JOB compute the answer', name: 'gc' });
    });
    const { executor, announceQueue } = await setup(provider);
    const parent = await sessionManager.createSession({ label: 'parent' });
    await executor.spawn(parent.id, { task: 'Delegate the computation', label: 'orchestrator' });
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true), { timeout: 10_000 });
    const [entry] = announceQueue.drain(parent.id);
    const message = formatAnnounceEntry(entry);
    expect(message).toMatch(/^\[agent-result: orchestrator\]/);
    expect(message).toContain('child relays hello');
    // The child's turn ended after spawning, and it was resumed with the grandchild's result.
    const childTurns = provider.requests.filter(r => !flattenSystem(r.system!).includes('GRANDCHILD-JOB')).map(lastUserText);
    expect(childTurns.some(t => t.startsWith('[agent-result: gc] (self-report'))).toBe(true);
    // The parent never sees grandchild results directly.
    expect(announceQueue.hasPending(parent.id)).toBe(false);
  });
});

describe('idle wake vs busy parent', () => {
  /** Wire executor → waker the way the gateway does (announce queue as the in-turn carrier). */
  async function wired(provider: LLMProvider, parentBusy: () => boolean) {
    const turns: WakeTurnRequest[] = [];
    let waker!: SessionWaker;
    let queue!: AnnounceQueue;
    const ctx = await setup(provider, {}, entry => {
      waker.wake(entry.parentSessionId, formatAnnounceEntry(entry), {
        kind: entry.kind ?? 'agent-result',
        isPending: () => !queue.wasDrained(entry.parentSessionId, entry.runId),
        claim: () => { queue.acknowledge(entry.parentSessionId, entry.runId); },
      });
    });
    queue = ctx.announceQueue;
    waker = new SessionWaker({ isBusy: parentBusy, runTurn: async r => { turns.push(r); }, pollMs: 10 });
    return { ...ctx, turns, waker };
  }

  it('wakes an idle parent with a new turn carrying the result', async () => {
    const provider = scriptedProvider(() => text('Tests are green now. [DONE]'));
    const { executor, announceQueue, turns } = await wired(provider, () => false);
    const parent = await sessionManager.createSession({ label: 'parent' });
    await executor.spawn(parent.id, { task: 'Make the tests green', label: 'green' });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].sessionId).toBe(parent.id);
    expect(turns[0].message).toMatch(/^\[agent-result: green\] \(self-report — verify before relying on it\)/);
    // claimed: the next parent turn will not see it a second time
    expect(announceQueue.hasTerminalPending(parent.id)).toBe(false);
  });

  it('does not wake a busy parent whose running turn drains the result', async () => {
    let busy = true;
    const provider = scriptedProvider(() => text('The release notes describe a small bug fix. [DONE]'));
    const { executor, announceQueue, turns } = await wired(provider, () => busy);
    const parent = await sessionManager.createSession({ label: 'parent' });
    await executor.spawn(parent.id, { task: 'Summarize the release notes', label: 'docs' });
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true));
    // agent.ts drains at its next iteration boundary...
    const drained = announceQueue.drain(parent.id);
    expect(formatAnnounceEntry(drained[0])).toMatch(/^\[agent-result: docs\]/);
    busy = false;
    await new Promise(r => setTimeout(r, 60));
    expect(turns).toHaveLength(0);
  });

  it('wakes a parent that was busy but finished without draining', async () => {
    let busy = true;
    const provider = scriptedProvider(() => text('Benchmarks collected. [DONE]'));
    const { executor, announceQueue, turns } = await wired(provider, () => busy);
    const parent = await sessionManager.createSession({ label: 'parent' });
    await executor.spawn(parent.id, { task: 'Collect benchmarks', label: 'bench' });
    await vi.waitFor(() => expect(announceQueue.hasTerminalPending(parent.id)).toBe(true));
    await new Promise(r => setTimeout(r, 30));
    expect(turns).toHaveLength(0);
    busy = false;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].message).toMatch(/^\[agent-result: bench\]/);
  });
});

describe('check_agents and progress_note', () => {
  it('returns status without blocking, waits when asked, and shows throttled progress notes', async () => {
    const release = gate();
    const provider = scriptedProvider(async () => { await release.opened; return text('{"status":"succeeded","summary":"done","acceptancePassed":true} [DONE]'); });
    const { call, announceQueue, registry } = await setup(provider, { progressNoteIntervalSeconds: 30 });
    const parent = await sessionManager.createSession({ label: 'parent' });
    const handle = JSON.parse((await call('spawn_agent', parent.id, { task: 'Slow research task', name: 'slow' })).output.split('\n')[0]);
    await vi.waitFor(() => expect(provider.requests.length).toBe(1));
    const child = registry.getRun(handle.id)!.childSessionId;

    const note1 = await call('progress_note', child, { text: 'read 4 of 9 files' });
    expect(note1.output).toBe('Noted.');
    const note2 = await call('progress_note', child, { text: 'read 5 of 9 files' });
    expect(note2.output).toMatch(/Throttled/);
    const progress = announceQueue.drain(parent.id);
    expect(progress.map(e => formatAnnounceEntry(e))).toEqual(['[agent-progress: slow] read 4 of 9 files']);

    const t0 = Date.now();
    const status = await call('check_agents', parent.id, {});
    expect(Date.now() - t0).toBeLessThan(200);
    expect(status.output).toContain(`id=${handle.id}`);
    expect(status.output).toContain('name=slow');
    expect(status.output).toContain('status=running');
    expect(status.output).toMatch(/elapsed=\d+s/);
    expect(status.output).toMatch(/iterations=1/);
    expect(status.output).toContain('note="read 4 of 9 files"');

    setTimeout(() => release.open(), 100);
    const waited = await call('check_agents', parent.id, { timeout: 5 });
    expect(waited.output).toContain('All sub-agents have finished.');
    expect(waited.output).toContain('status=completed');
    expect(waited.output).toContain('report=');
  });

  it('caps check_agents waits at the given timeout', async () => {
    const release = gate();
    const provider = scriptedProvider(async () => { await release.opened; return text('ok [DONE]'); });
    const { call, registry } = await setup(provider);
    const parent = await sessionManager.createSession({ label: 'parent' });
    await call('spawn_agent', parent.id, { task: 'Never-ending task', name: 'forever' });
    const t0 = Date.now();
    const out = await call('check_agents', parent.id, { timeout: 0.3 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(out.output).toContain('Still running after 0.3s');
    release.open();
    await vi.waitFor(() => expect(registry.getActiveRunsForParent(parent.id)).toHaveLength(0));
  });
});
