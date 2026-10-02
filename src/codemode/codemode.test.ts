import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../skills/registry.js';
import type { SkillLoader } from '../skills/loader.js';
import { defineSkill } from '../skills/sdk.js';
import type { SkillHandlerContext } from '../skills/types.js';
import {
  KernelManager,
  buildCodeModePrompt,
  buildExecuteCodeDescription,
  codeModeConfigFromEnv,
  createRegistryCallTool,
  isModelDenylisted,
  listKernelVariables,
  registerCodeModeTool,
  registerExecuteCodeTool,
  registryCatalog,
  resolveAgentMode,
  setDefaultKernelManager,
  shouldUseCodeMode,
  transformCell,
  type BackgroundEvent,
} from './index.js';
import { parseSearchOutput, stripLineNumbers } from './api.js';

type Handler = (ctx: SkillHandlerContext) => Promise<{ success: boolean; output: string; error?: string }>;

function fakeRegistry(tools: Record<string, { handler: Handler; props?: Record<string, { type: string }>; required?: string[]; description?: string }>): SkillRegistry {
  const registry = new SkillRegistry({ loadAll: async () => [] } as unknown as SkillLoader);
  for (const [name, spec] of Object.entries(tools)) {
    registry.registerSkill(defineSkill(name, spec.description ?? `The ${name} tool. Second sentence is dropped.`)
      .userInvocable(false)
      .inputSchema({ type: 'object', properties: spec.props ?? {}, required: spec.required ?? [] })
      .onNativeExecute(spec.handler)
      .build().skill);
  }
  return registry;
}

const managers: KernelManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.disposeAll()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  setDefaultKernelManager(null);
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codemode-'));
  dirs.push(dir);
  return dir;
}

function track<T extends { manager: KernelManager }>(value: T): T {
  managers.push(value.manager);
  return value;
}

async function runExec(registry: SkillRegistry, code: string, sessionId = 's1', toolName = 'exec') {
  const skill = registry.getSkill(toolName)!;
  return skill.handler!({ args: { code }, workspace: process.cwd(), sessionId, userId: 'u1', userMessage: 'hi' });
}

describe('transformCell', () => {
  it('rewrites top-level declarations to globals and keeps line numbers', () => {
    const t = transformCell('const a = 1\nlet {b} = o\nfunction f() {}\nclass C {}\na');
    expect(t.declared.sort()).toEqual(['C', 'a', 'b', 'f']);
    expect(t.functionNames.sort()).toEqual(['C', 'f']);
    expect(t.hasValue).toBe(true);
    expect(t.code.split('\n').length).toBe(6);
    expect(t.code).toContain(';(a = 1)');
    expect(t.code).toContain(';({b} = o)');
    expect(t.code).toContain('globalThis["f"] = f;');
    expect(t.code).toContain(';C = class C {};');
    expect(t.code).toContain('return {__v: (a)};');
  });

  it('keeps newlines inside rewritten ranges', () => {
    const t = transformCell('const\n  a = 1\na');
    expect(t.code.split('\n').length).toBe(4);
  });

  it('leaves nested declarations alone', () => {
    const t = transformCell('for (let i = 0; i < 3; i++) { const x = i }\nif (true) { var y = 1 }');
    expect(t.declared).toEqual([]);
    expect(t.hasValue).toBe(false);
  });

  it('protects against ASI swallowing a rewritten declaration', () => {
    const t = transformCell('x = 5\nconst y = 2');
    expect(t.code).toContain('x = 5\n;(y = 2)');
  });

  it('rejects export statements', () => {
    expect(() => transformCell('export default 1')).toThrow(/export is not supported/);
  });
});

describe('api helpers', () => {
  it('strips read_file line-number gutters only when every line has one', () => {
    expect(stripLineNumbers(' 1| a\n 2| b\n10|   c')).toBe('a\nb\n  c');
    expect(stripLineNumbers('plain\n 2| b')).toBe('plain\n 2| b');
  });

  it('parses grep output into matches', () => {
    expect(parseSearchOutput('src/a.ts:3: foo\nsrc/a.ts-4- ctx\n--\n(no matches)')).toEqual([
      { file: 'src/a.ts', line: 3, text: 'foo' },
      { file: 'src/a.ts', line: 4, text: 'ctx', context: true },
    ]);
  });
});

describe('registerCodeModeTool (RPC to real registered tools)', () => {
  it('dispatches kernel API calls to registry tools with the exec context', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown>; userId?: string; sessionId: string }> = [];
    const log = (name: string, output: string): Handler => async (ctx) => {
      seen.push({ name, args: ctx.args, userId: ctx.userId, sessionId: ctx.sessionId });
      return { success: true, output };
    };
    const registry = fakeRegistry({
      read_file: { handler: log('read_file', ' 1| line one\n 2| line two'), props: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      write_file: { handler: log('write_file', 'wrote'), props: { path: { type: 'string' }, content: { type: 'string' } } },
      edit_file: { handler: log('edit_file', 'edited') },
      grep: { handler: log('grep', 'a.ts:1: TODO one\nb.ts:9: TODO two') },
      glob: { handler: log('glob', 'a.ts\nb.ts') },
      web_search: { handler: log('web_search', '{"results":[{"title":"T"}]}') },
      send_message: { handler: log('send_message', 'Message sent') },
      weather: { handler: log('weather', '{"tempC": 12}'), props: { city: { type: 'string' } }, required: ['city'] },
    });
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    const res = await runExec(registry, [
      'const src = await read("a.ts", {offset: 1, limit: 2});',
      'const files = await glob("**/*.ts");',
      'const hits = await search("TODO", {glob: "*.ts"});',
      'await patch("a.ts", "line one", "line 1");',
      'await write("out.csv", "x");',
      'const web = await web.search("q");',
      'const w = await skills.weather("Oslo");',
      'await send("done");',
      'JSON.stringify([src, files, hits.map(h => h.file + ":" + h.line), web.results[0].title, w.tempC])',
    ].join('\n'));
    expect(res.success).toBe(true);
    expect(res.output).toBe('→ ["line one\\nline two",["a.ts","b.ts"],["a.ts:1","b.ts:9"],"T",12]');
    expect(seen.map(s => s.name)).toEqual(['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'web_search', 'weather', 'send_message']);
    expect(seen[0].args).toEqual({ path: 'a.ts', offset: 1, limit: 2 });
    expect(seen[3].args).toEqual({ path: 'a.ts', old_string: 'line one', new_string: 'line 1' });
    expect(seen[6].args).toEqual({ city: 'Oslo' });
    expect(seen[7]).toMatchObject({ args: { message: 'done' }, userId: 'u1', sessionId: 's1' });
  });

  it('prefers a native patch tool over edit_file', async () => {
    const used: string[] = [];
    const registry = fakeRegistry({
      patch: { handler: async () => { used.push('patch'); return { success: true, output: 'ok' }; } },
      edit_file: { handler: async () => { used.push('edit_file'); return { success: true, output: 'ok' }; } },
    });
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    await runExec(registry, 'await patch("f", "a", "b", {replaceAll: true})');
    expect(used).toEqual(['patch']);
  });

  it('throws clear errors for missing tools and failed calls', async () => {
    const registry = fakeRegistry({
      read_file: { handler: async () => ({ success: false, output: '', error: 'File not found: nope.txt' }) },
    });
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    const missing = await runExec(registry, 'await web.fetch("https://x")');
    expect(missing.success).toBe(false);
    expect(missing.output).toMatch(/web\.fetch\(\) is unavailable: no "web_fetch" or "webfetch" tool is registered/);
    const failed = await runExec(registry, 'try { await read("nope.txt") } catch (e) { print("caught:", e.message) }');
    expect(failed.output).toBe('caught: read_file: File not found: nope.txt');
    const unknown = await runExec(registry, 'await skills.nothing({})');
    expect(unknown.output).toMatch(/skills\.nothing: no such tool\. Available: read_file/);
    const self = await runExec(registry, 'await skills.exec({code: "1"})');
    expect(self.output).toMatch(/skills\.exec: no such tool/);
  });

  it('bash() handles: awaitable, poll, tail, and [bash-done] for unawaited jobs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = fakeRegistry({
      bash: {
        handler: async (ctx) => {
          if (String(ctx.args.command).includes('slow')) await gate;
          return { success: true, output: JSON.stringify({ success: true, output: `ran ${ctx.args.command}\nline2`, exitCode: 0 }) };
        },
      },
    });
    const events: BackgroundEvent[] = [];
    // A native bash tool returning JSON text: the default callTool leaves native output as-is,
    // so wrap callTool to emulate the script executor's exitCode unwrapping.
    const base = createRegistryCallTool(registry);
    const { manager } = track(registerCodeModeTool(registry, {
      workspace: process.cwd(),
      snapshotDir: null,
      idleMs: 0,
      onBashDone: (event) => events.push(event),
      callTool: async (name, args, ctx) => {
        const res = await base(name, args, ctx);
        if (name !== 'bash') return res;
        const parsed = JSON.parse(res.output);
        return { success: parsed.success, output: parsed.output, exitCode: parsed.exitCode };
      },
    }));
    const quick = await runExec(registry, 'const r = await bash("echo hi"); [r.exitCode, r.ok, r.output.split("\\n")[0]]');
    expect(quick.output).toBe("→ [ 0, true, 'ran echo hi' ]");

    const started = await runExec(registry, 'const job = bash("slow build"); [await job.poll(), job.id]');
    expect(started.output).toBe("→ [ { running: true }, 'b2' ]");
    release();
    await new Promise(r => setTimeout(r, 30));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'bash-done', sessionId: 's1', id: 'b2', exitCode: 0, text: '[bash-done b2 exit=0] slow build' });
    expect(events[0].tail).toBe('ran slow build\nline2');
    const tail = await runExec(registry, 'await job.tail(1)');
    expect(tail.output).toBe('→ line2');
    expect(manager.has('s1')).toBe(true);
  });

  it('reports a job that finishes during a later cell as a note in that cell', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = fakeRegistry({
      bash: { handler: async () => { await gate; return { success: false, output: 'boom' }; } },
    });
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    await runExec(registry, 'const j = bash("make")');
    const next = runExec(registry, 'await new Promise(r => setTimeout(r, 60)); "after"');
    setTimeout(release, 10);
    const out = await next;
    expect(out.output).toContain('[bash-done b1 exit=1] make');
    expect(out.output).toContain('→ after');
  });

  it('agents.spawn returns a handle that resolves through check_agents', async () => {
    let polls = 0;
    const registry = fakeRegistry({
      spawn_agent: { handler: async (ctx) => ({ success: true, output: `Sub-agent "${ctx.args.label}" spawned (run: run-123abc). Results will appear when complete.` }) },
      check_agents: {
        handler: async (ctx) => {
          if (ctx.args.action === 'info') {
            polls++;
            return { success: true, output: JSON.stringify(polls < 2 ? { status: 'running' } : { status: 'completed', response: 'found 3' }) };
          }
          return { success: true, output: '[]' };
        },
      },
    });
    const reg = track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    // speed up agent polling for the test
    (reg.manager as any).session('s1').api.opts.agentPollIntervalMs = 10;
    const res = await runExec(registry, 'const a = agents.spawn("count the todos", {name: "todo"}); const rep = await a; [a.id, rep.response]');
    expect(res.output).toBe("→ [ 'run-123abc', 'found 3' ]");
  });

  it('keeps one kernel per session', async () => {
    const registry = fakeRegistry({});
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    await runExec(registry, 'const who = "A"', 'sa');
    await runExec(registry, 'const who = "B"', 'sb');
    expect((await runExec(registry, 'who', 'sa')).output).toBe('→ A');
    expect((await runExec(registry, 'who', 'sb')).output).toBe('→ B');
  });

  it('execute_code returns only printed output and errors', async () => {
    const registry = fakeRegistry({ read_file: { handler: async () => ({ success: true, output: 'x' }) } });
    track(registerExecuteCodeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    const res = await runExec(registry, 'print("visible"); 42', 's1', 'execute_code');
    expect(res.output).toBe('visible');
    expect(registry.getSkill('execute_code')!.description).toContain('Only what you print');
  });

  it('marks errors as failed results with the traceback', async () => {
    const registry = fakeRegistry({});
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    const res = await runExec(registry, 'const a = 1\nnull.x');
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/TypeError: Cannot read properties of null[\s\S]*<cell-1>:2:/);
  });
});

describe('KernelManager persistence and reaping', () => {
  it('listKernelVariables works live, after idle reaping, and from disk only', async () => {
    const dir = await tempDir();
    const registry = fakeRegistry({});
    const { manager } = track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: dir, idleMs: 0 }));
    await runExec(registry, 'const files = ["a", "b", "c"]; const csv = "x,y"; function helper() {}', 'sess/1');
    expect(await listKernelVariables('sess/1')).toBe('[kernel-state] vars: csv: string (3 chars), files: Array(3), helper: function');
    await manager.kernel('sess/1').flush();
    expect(await manager.reap(0)).toEqual(['sess/1']);
    expect(manager.has('sess/1')).toBe(false);
    expect(await listKernelVariables('sess/1')).toBe('[kernel-state] vars: csv: string (3 chars), files: Array(3), helper: function');
    // Next exec resumes with the state (new worker, restored from disk).
    const res = await runExec(registry, 'files.length + csv.length', 'sess/1');
    expect(res.output).toContain('[kernel-restore] 3 variable(s) restored from the saved session');
    expect(res.output).toContain('→ 6');
    expect(await listKernelVariables('nobody')).toBe('');
  });

  it('evicts the least recently used kernel beyond maxKernels', async () => {
    const registry = fakeRegistry({});
    const { manager } = track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0, maxKernels: 2 }));
    await runExec(registry, '1', 'k1');
    await runExec(registry, '1', 'k2');
    await runExec(registry, '1', 'k3');
    await new Promise(r => setTimeout(r, 20));
    expect(manager.has('k1')).toBe(false);
    expect(manager.has('k3')).toBe(true);
  });
});

describe('prompt', () => {
  const makeRegistry = () => fakeRegistry({
    zeta: { handler: async () => ({ success: true, output: '' }), props: { q: { type: 'string' }, n: { type: 'number' } }, required: ['q'], description: 'Zeta things. More text.' },
    read_file: { handler: async () => ({ success: true, output: '' }) },
    bash: { handler: async () => ({ success: true, output: '' }) },
    alpha: { handler: async () => ({ success: true, output: '' }), props: { mode: { type: 'string', enum: ['a', 'b'] } as any } },
    grep: { handler: async () => ({ success: true, output: '' }) },
  });

  it('is byte-stable regardless of registration order', () => {
    const a = buildCodeModePrompt(makeRegistry());
    const b = buildCodeModePrompt(makeRegistry());
    expect(a).toBe(b);
    const reversed = fakeRegistry({
      grep: { handler: async () => ({ success: true, output: '' }) },
      alpha: { handler: async () => ({ success: true, output: '' }), props: { mode: { type: 'string', enum: ['a', 'b'] } as any } },
      bash: { handler: async () => ({ success: true, output: '' }) },
      read_file: { handler: async () => ({ success: true, output: '' }) },
      zeta: { handler: async () => ({ success: true, output: '' }), props: { q: { type: 'string' }, n: { type: 'number' } }, required: ['q'], description: 'Zeta things. More text.' },
    });
    expect(buildCodeModePrompt(reversed)).toBe(a);
  });

  it('lists available core API, skills.* signatures, and the usage rules', () => {
    const registry = makeRegistry();
    track(registerCodeModeTool(registry, { workspace: process.cwd(), snapshotDir: null, idleMs: 0 }));
    const prompt = buildCodeModePrompt(registry);
    expect(prompt).toContain('read(path: string, opts?: {offset?: number, limit?: number}): Promise<string>');
    expect(prompt).toContain('bash(cmd: string');
    expect(prompt).toContain('search(pattern: string');
    expect(prompt).not.toContain('web.search(');
    expect(prompt).not.toContain('skills.exec');
    expect(prompt).not.toContain('skills.read_file');
    expect(prompt.indexOf('skills.alpha({mode?: "a" | "b"})')).toBeLessThan(prompt.indexOf('skills.zeta({q: string, n?: number})  // Zeta things.'));
    expect(prompt).toContain('[bash-done');
    expect(prompt).toContain('Assign read/search/fetch results to named variables');
    expect(prompt).toContain('Never sleep or poll');
  });

  it('degrades detail to stay within the size budget', () => {
    const tools: Record<string, { handler: Handler; props: Record<string, { type: string }>; description: string }> = {};
    for (let i = 0; i < 300; i++) {
      tools[`tool_${String(i).padStart(3, '0')}`] = {
        handler: async () => ({ success: true, output: '' }),
        props: { alpha: { type: 'string' }, beta: { type: 'number' }, gamma: { type: 'boolean' } },
        description: 'A fairly long description that goes on for a while to use up the prompt budget quickly.',
      };
    }
    const prompt = buildCodeModePrompt(fakeRegistry(tools));
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain('skills.tool_299');
  });

  it('describes execute_code with the compact API', () => {
    const description = buildExecuteCodeDescription(registryCatalog(makeRegistry()));
    expect(description).toContain('Only what you print');
    expect(description).toContain('read(path: string');
    expect(description).toContain('skills.<name>(args) for any other tool: alpha, zeta');
  });
});

describe('config', () => {
  it('reads AGENT_MODE and the denylist from env', () => {
    const config = codeModeConfigFromEnv({ AGENT_MODE: 'code', CODE_MODE_MODELS_DENYLIST: 'qwen3*, moonshot/kimi-k2-0905' });
    expect(config).toEqual({ mode: 'code', denylist: ['qwen3*', 'moonshot/kimi-k2-0905'], fallback: 'tool' });
    expect(shouldUseCodeMode('kimi-k2.5', config)).toBe(true);
    expect(shouldUseCodeMode('Qwen3-32B', config)).toBe(false);
    expect(shouldUseCodeMode('openrouter/qwen3-coder', config)).toBe(false);
    expect(shouldUseCodeMode('moonshot/kimi-k2-0905', config)).toBe(false);
    expect(isModelDenylisted('kimi-k2-0905', config.denylist)).toBe(false);
    expect(shouldUseCodeMode('kimi-k2.5', codeModeConfigFromEnv({}))).toBe(false);
  });

  it('falls back to the configured mode for denylisted models', () => {
    const config = codeModeConfigFromEnv({ AGENT_MODE: 'code', CODE_MODE_MODELS_DENYLIST: 'bad-*', CODE_MODE_FALLBACK: 'hybrid' });
    expect(resolveAgentMode('bad-model', config)).toBe('hybrid');
    expect(resolveAgentMode('good-model', config)).toBe('code');
    expect(resolveAgentMode('x', codeModeConfigFromEnv({ AGENT_MODE: 'hybrid' }))).toBe('hybrid');
    expect(codeModeConfigFromEnv({ AGENT_MODE: 'nonsense' }).mode).toBe('tool');
  });
});
