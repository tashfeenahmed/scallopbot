import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Kernel, formatVariables, readSnapshotFile, type RpcDispatch } from './kernel.js';

const kernels: Kernel[] = [];
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codemode-kernel-'));
  dirs.push(dir);
  return dir;
}

function makeKernel(options: { dispatch?: RpcDispatch; snapshotFile?: string | null; interruptGraceMs?: number; cellTimeoutMs?: number; outputCap?: number } = {}): Kernel {
  const kernel = new Kernel({
    sessionId: 'test',
    workspace: process.cwd(),
    dispatch: options.dispatch ?? (async (p) => { throw new Error(`no api ${p}`); }),
    snapshotFile: options.snapshotFile ?? null,
    interruptGraceMs: options.interruptGraceMs ?? 500,
    cellTimeoutMs: options.cellTimeoutMs,
    outputCap: options.outputCap,
  });
  kernels.push(kernel);
  return kernel;
}

afterEach(async () => {
  await Promise.all(kernels.splice(0).map(k => k.dispose()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('Kernel cells', () => {
  it('persists const/let/var/function/class declarations across cells', async () => {
    const k = makeKernel();
    await k.exec('const a = 2; let b = 3; var c = 4\nfunction add(x, y) { return x + y }\nclass Box { constructor(v) { this.v = v } }');
    const r = await k.exec('add(a, b) + c + new Box(1).v');
    expect(r.error).toBeUndefined();
    expect(r.value).toBe('10');
  });

  it('allows redeclaring a const in a later cell (REPL semantics)', async () => {
    const k = makeKernel();
    await k.exec('const x = 1');
    const r = await k.exec('const x = 5; x * 2');
    expect(r.error).toBeUndefined();
    expect(r.value).toBe('10');
  });

  it('hoists destructuring declarations', async () => {
    const k = makeKernel();
    await k.exec('const {p, q: [r1, ...rest]} = {p: "P", q: [1, 2, 3]}');
    const r = await k.exec('[p, r1, rest]');
    expect(r.value).toBe("[ 'P', 1, [ 2, 3 ] ]");
  });

  it('supports top-level await and awaits a returned promise', async () => {
    const k = makeKernel();
    const r = await k.exec('const v = await new Promise(res => setTimeout(() => res(41), 10));\nv + 1');
    expect(r.value).toBe('42');
    const r2 = await k.exec('Promise.resolve("later")');
    expect(r2.value).toBe('later');
  });

  it('reports the last expression only, inspected with depth 3', async () => {
    const k = makeKernel();
    expect((await k.exec('const z = 1')).value).toBeUndefined();
    expect((await k.exec('({a: {b: {c: {d: {e: 1}}}}})')).value?.replace(/\s+/g, ' ')).toBe('{ a: { b: { c: { d: [Object] } } } }');
    expect((await k.exec('for (let i = 0; i < 2; i++) {}')).value).toBeUndefined();
    expect((await k.exec('"raw\\ntext"')).value).toBe('raw\ntext');
  });

  it('captures console.log, console.error and process.stdout.write', async () => {
    const k = makeKernel();
    const r = await k.exec('console.log("hello", {n: 1}); console.error("oops"); process.stdout.write("raw\\n"); print("p")');
    expect(r.stdout).toBe("hello { n: 1 }\nraw\np\n");
    expect(r.stderr).toBe('oops\n');
  });

  it('caps each output stream at the configured size', async () => {
    const k = makeKernel({ outputCap: 1_000 });
    const r = await k.exec('for (let i = 0; i < 500; i++) console.log("line " + i); "x".repeat(5000)');
    expect(r.stdout.length).toBeLessThan(1_200);
    expect(r.stdout).toContain('line 0');
    expect(r.stdout).toContain('line 499');
    expect(r.stdout).toMatch(/chars truncated/);
    expect(r.value!.length).toBeLessThan(1_200);
  });

  it('caps at 64k characters by default', async () => {
    const k = makeKernel();
    const r = await k.exec('console.log("y".repeat(200000))');
    expect(r.stdout.length).toBeLessThan(64_200);
    expect(r.stdout.length).toBeGreaterThan(60_000);
  });

  it('shows tracebacks with <cell-N> line numbers and the source line', async () => {
    const k = makeKernel();
    await k.exec('function boom() {\n  return null.x\n}');
    const r = await k.exec('const ok = 1\n\nboom()');
    expect(r.error).toMatch(/^TypeError: Cannot read properties of null/);
    expect(r.error).toContain('<cell-1>:2:');
    expect(r.error).toContain('<cell-2>:3:1');
    const r2 = await k.exec('const a1 = 1\nthrow new Error("bad thing")');
    expect(r2.error).toContain('Error: bad thing');
    expect(r2.error).toContain('<cell-3>:2:');
    expect(r2.error).toContain('2 | throw new Error("bad thing")');
  });

  it('fixes line-1 columns for the injected prelude', async () => {
    const k = makeKernel();
    const r = await k.exec('const q = 1; undefinedFn()');
    expect(r.error).toContain('<cell-1>:1:14');
  });

  it('reports syntax errors with position and caret', async () => {
    const k = makeKernel();
    const r = await k.exec('const a = 1\nconst = 2');
    expect(r.error).toMatch(/^SyntaxError: Unexpected token/);
    expect(r.error).toContain('<cell-1>:2:7');
    expect(r.error).toContain('^');
  });

  it('keeps running after uncaught async errors and reports them as background output', async () => {
    const k = makeKernel();
    await k.exec('setTimeout(() => { throw new Error("late") }, 5); Promise.reject(new Error("unhandled")); 1');
    await new Promise(r => setTimeout(r, 50));
    const r = await k.exec('2');
    expect(r.value).toBe('2');
    expect(r.background).toContain('late');
    expect(r.background).toContain('unhandled');
  });

  it('blocks process.exit', async () => {
    const k = makeKernel();
    const r = await k.exec('process.exit(1)');
    expect(r.error).toContain('process.exit(1) is disabled');
    expect((await k.exec('1 + 1')).value).toBe('2');
  });

  it('supports static and dynamic imports and require', async () => {
    const k = makeKernel();
    const r = await k.exec('import path, {basename} from "node:path"\nconst os = await import("node:os")\nconst fs = require("node:fs");\n[basename("/a/b.txt"), typeof path.join, typeof os.cpus, typeof fs.readFileSync]');
    expect(r.error).toBeUndefined();
    expect(r.value).toBe("[ 'b.txt', 'function', 'function', 'function' ]");
  });
});

describe('Kernel interrupt and timeout', () => {
  it('interrupts an awaiting cell cooperatively and keeps all variables', async () => {
    const k = makeKernel();
    await k.exec('const keep = {n: 7}; function f() { return keep.n }');
    const running = k.exec('keep.n = 8; await new Promise(() => {}); keep.n = 9');
    await new Promise(r => setTimeout(r, 50));
    expect(await k.interrupt()).toBe('cooperative');
    const r = await running;
    expect(r.interrupted).toBe(true);
    expect(r.restarted).toBe(false);
    expect((await k.exec('f()')).value).toBe('8');
  });

  it('clears timers created by an interrupted cell', async () => {
    const k = makeKernel();
    await k.exec('globalThis.ticks = 0');
    const running = k.exec('setInterval(() => ticks++, 5); await new Promise(() => {})');
    await new Promise(r => setTimeout(r, 40));
    await k.interrupt();
    await running;
    const t1 = Number((await k.exec('ticks')).value);
    await new Promise(r => setTimeout(r, 60));
    const t2 = Number((await k.exec('ticks')).value);
    expect(t2).toBe(t1);
  });

  it('stops a synchronous top-level loop with the vm timeout without losing state', async () => {
    const k = makeKernel();
    await k.exec('const before = "kept"');
    const r = await k.exec('while (true) {}', { timeoutMs: 200 });
    expect(r.error ?? '').toMatch(/timed out/i);
    expect((await k.exec('before')).value).toBe('kept');
  });

  it('terminates a worker stuck in sync code after an await, restoring the snapshot', async () => {
    const k = makeKernel({ interruptGraceMs: 200 });
    await k.exec('const data = [1, 2, 3]; const label = "x"; function total() { return data.reduce((a, b) => a + b, 0) }');
    await k.flush();
    const running = k.exec('await null; while (true) {}');
    await new Promise(r => setTimeout(r, 100));
    expect(await k.interrupt()).toBe('restarted');
    const r = await running;
    expect(r.interrupted).toBe(true);
    expect(r.restarted).toBe(true);
    const after = await k.exec('[total(), label]');
    expect(after.value).toBe("[ 6, 'x' ]");
    expect(after.notes.join('\n')).toMatch(/kernel-restore|restarted/);
  });

  it('times out an async cell and keeps variables', async () => {
    const k = makeKernel();
    await k.exec('const v1 = 5');
    const r = await k.exec('await new Promise(() => {})', { timeoutMs: 150 });
    expect(r.interrupted).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.notes.join('\n')).toMatch(/timed out/);
    expect((await k.exec('v1')).value).toBe('5');
  });

  it('honours an interrupt that arrives before the worker has started', async () => {
    const k = makeKernel();
    const running = k.exec('globalThis.ran = true; await new Promise(() => {})');
    expect(await k.interrupt()).toBe('cooperative');
    const r = await running;
    expect(r.interrupted).toBe(true);
    expect((await k.exec('typeof ran')).value).toBe('undefined');
  });

  it('interrupts via AbortSignal', async () => {
    const k = makeKernel();
    const controller = new AbortController();
    const running = k.exec('await new Promise(() => {})', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect((await running).interrupted).toBe(true);
  });
});

describe('Kernel RPC', () => {
  it('dispatches API calls to the host and returns structured values', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const k = makeKernel({
      dispatch: async (p, args) => {
        calls.push([p, args]);
        if (p === 'read') return `content of ${args[0]}`;
        if (p === 'glob') return ['a.ts', 'b.ts'];
        if (p === 'skills') return { tool: args[0], args: args[1] };
        throw new Error('nope');
      },
    });
    const r = await k.exec('const files = await glob("**/*.ts")\nconst texts = await Promise.all(files.map(f => read(f)))\nconst s = await skills.weather({city: "Oslo"});\n[files.length, Array.isArray(files), texts[1], s.tool, s.args.city]');
    expect(r.error).toBeUndefined();
    expect(r.value).toBe("[ 2, true, 'content of b.ts', 'weather', 'Oslo' ]");
    expect(calls.map(c => c[0])).toEqual(['glob', 'read', 'read', 'skills']);
  });

  it('rejects with an Error pointing at the calling cell line', async () => {
    const k = makeKernel({ dispatch: async () => { throw new Error('read_file: File not found: x'); } });
    const r = await k.exec('const a = 1\nawait read("x")');
    expect(r.error).toMatch(/^Error: read_file: File not found: x/);
    expect(r.error).toContain('<cell-1>:2:');
  });

  it('reports non-cloneable arguments clearly', async () => {
    const k = makeKernel({ dispatch: async () => 'ok' });
    const r = await k.exec('await read("x", {fn: () => 1})');
    expect(r.error).toMatch(/arguments must be plain data/);
  });

  it('aborts the host signal of in-flight calls on interrupt', async () => {
    let seenSignal: AbortSignal | undefined;
    const k = makeKernel({
      dispatch: (_p, _a, ctx) => {
        seenSignal = ctx.signal;
        return new Promise(() => {});
      },
    });
    const running = k.exec('await read("slow")');
    while (!seenSignal) await new Promise(r => setTimeout(r, 5));
    expect(seenSignal.aborted).toBe(false);
    await k.interrupt();
    const r = await running;
    expect(r.interrupted).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('bash() returns a handle at once, is awaitable and exposes poll/tail/kill', async () => {
    let finish!: (v: unknown) => void;
    const k = makeKernel({
      dispatch: async (p, args) => {
        switch (p) {
          case 'bash.start': return { id: 'b1' };
          case 'bash.poll': return { running: true };
          case 'bash.tail': return `tail ${args[1]}`;
          case 'bash.kill': return 'killed';
          case 'bash.wait': return new Promise(res => { finish = res; });
          default: throw new Error(p);
        }
      },
    });
    const r1 = await k.exec('const h = bash("npm test")\nh');
    expect(r1.value).toMatch(/^BashHandle\((b1|starting): npm test\)$/);
    const r2 = await k.exec('[await h.poll(), await h.tail(5), h.id]');
    expect(r2.value).toBe("[ { running: true }, 'tail 5', 'b1' ]");
    const pending = k.exec('const res = await h; res.exitCode');
    await new Promise(r => setTimeout(r, 30));
    finish({ exitCode: 0, ok: true, output: 'done' });
    expect((await pending).value).toBe('0');
    expect((await k.exec('await h.kill()')).value).toBe('killed');
  });
});

describe('Kernel variables and snapshots', () => {
  it('lists user variables with types and sizes', async () => {
    const k = makeKernel();
    await k.exec('const s = "abc"; const arr = [1, 2]; const m = new Map([[1, 2]]); function fn() {}; const o = {a: 1, b: 2}; const n = 42');
    const vars = await k.listVariables();
    const text = formatVariables(vars);
    expect(text).toBe('[kernel-state] vars: arr: Array(2), fn: function, m: Map(1), n: number = 42, o: Object{2 keys}, s: string (3 chars)');
  });

  it('snapshots to disk per variable, skips failures, and restores on a new kernel', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'sess.bin');
    const k1 = makeKernel({ snapshotFile: file });
    await k1.exec([
      'const rows = [{file: "a.ts", n: 3}]',
      'const when = new Date(0)',
      'const counts = new Map([["a", 1]])',
      'function double(x) { return x * 2 }',
      'const triple = (x) => x * 3',
      'class Point { constructor(x) { this.x = x } norm() { return Math.abs(this.x) } }',
      'const pt = new Point(-4)',
      'const sym = Symbol("s")',
      'const inner = (() => { const secret = 9; return () => secret })()',
    ].join('\n'));
    await k1.flush();
    expect(existsSync(file)).toBe(true);
    const snap = await readSnapshotFile(file);
    expect(snap!.entries.map(e => e.name).sort()).toEqual(['Point', 'counts', 'double', 'pt', 'rows', 'triple', 'when']);
    expect(snap!.skipped.map(s => s.name).sort()).toEqual(['inner', 'sym']);
    await k1.dispose();

    const k2 = makeKernel({ snapshotFile: file });
    const r = await k2.exec('JSON.stringify([rows[0].file, when.getTime(), counts.get("a"), double(4), triple(2), pt.norm(), pt instanceof Point])');
    expect(r.error).toBeUndefined();
    expect(r.value).toBe('["a.ts",0,1,8,6,4,true]');
    expect(r.notes[0]).toMatch(/^\[kernel-restore\] 7 variable\(s\) restored from the saved session/);
    expect(r.notes[0]).toMatch(/not restored: .*inner/);
    // cell numbering continues
    expect(r.n).toBe(2);
  });

  it('restores bash handles from a snapshot', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'h.bin');
    const dispatch: RpcDispatch = async (p, args) => {
      if (p === 'bash.start') return { id: 'b7' };
      if (p === 'bash.poll') return { running: false, exitCode: 0, id: args[0] };
      throw new Error(p);
    };
    const k1 = makeKernel({ snapshotFile: file, dispatch });
    await k1.exec('const job = bash("make")\nawait job.poll()');
    await k1.flush();
    await k1.dispose();
    const k2 = makeKernel({ snapshotFile: file, dispatch });
    const r = await k2.exec('[job.id, (await job.poll()).id]');
    expect(r.value).toBe("[ 'b7', 'b7' ]");
  });
});
