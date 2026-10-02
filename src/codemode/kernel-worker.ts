/**
 * Code-mode kernel worker.
 *
 * Runs inside a worker_threads Worker. The worker's own global object IS the
 * kernel's persistent `globalThis`: cells run with vm.Script#runInThisContext,
 * so there is no cross-realm confusion (arrays from tool results are real
 * arrays, `instanceof` works) and every Node global is present.
 *
 * Constraints: this file is loaded directly by Node (type stripping under
 * vitest/tsx, compiled .js in dist), so it must import only `node:` builtins
 * and use erasable TypeScript syntax only (no enums, namespaces, parameter
 * properties).
 *
 * Protocol (host → worker):
 *   exec      {id, n, code, source, shifts, hasValue, timeoutMs, functionNames}
 *   interrupt {id}
 *   rpc-result{rid, ok, value?, error?}
 *   vars      {rid}
 *   snapshot  {rid}
 *   restore   {rid, entries}
 * Worker → host:
 *   ready, done {id, stdout, stderr, value?, error?, interrupted, background},
 *   rpc {rid, path, args, cell}, vars-result, snapshot-result, restore-result
 */

import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import util from 'node:util';
import v8 from 'node:v8';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { createRequire, builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const port = parentPort!;
const data = (workerData ?? {}) as { workspace?: string; outputCap?: number; maxVarBytes?: number; maxSnapshotBytes?: number };
const workspace = data.workspace || process.cwd();
const OUTPUT_CAP = data.outputCap ?? 64_000;
const MAX_VAR_BYTES = data.maxVarBytes ?? 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = data.maxSnapshotBytes ?? 128 * 1024 * 1024;

// Keep private references: model code may overwrite globals.
const JSONparse = JSON.parse;
const inspect = util.inspect;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const fnToString = Function.prototype.toString;

// ── output capture ────────────────────────────────────────────────────────

/** Head+tail capped text buffer: keeps the first 3/4 and the last 1/4 of the cap. */
class CappedText {
  private head = '';
  private tail = '';
  private dropped = 0;
  private readonly cap: number;
  constructor(capChars: number) {
    this.cap = capChars;
  }
  push(chunk: string): void {
    const headCap = Math.floor(this.cap * 0.75);
    if (this.head.length < headCap && this.dropped === 0 && this.tail.length === 0) {
      const room = headCap - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    const tailCap = this.cap - headCap;
    this.tail += chunk;
    if (this.tail.length > tailCap) {
      this.dropped += this.tail.length - tailCap;
      this.tail = this.tail.slice(this.tail.length - tailCap);
    }
  }
  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n…[${this.dropped} chars truncated; assign to a variable and print a slice]…\n${this.tail}`;
  }
  get length(): number {
    return this.head.length + this.tail.length;
  }
}

interface Cell {
  id: number;
  n: number;
  out: CappedText;
  err: CappedText;
  done: boolean;
  cancelled: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  intervals: Set<ReturnType<typeof setInterval>>;
  abort: (reason: unknown) => void;
  aborted: Promise<never>;
}

const als = new AsyncLocalStorage<Cell>();
let background = new CappedText(OUTPUT_CAP);
let running: Cell | null = null;

function route(kind: 'out' | 'err', chunk: unknown): void {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const cell = als.getStore();
  if (cell && !cell.done) {
    (kind === 'out' ? cell.out : cell.err).push(text);
  } else {
    background.push(kind === 'err' ? `[stderr] ${text}` : text);
  }
}

// Real Writables (Console needs the stream API for long writes); _write runs
// synchronously, so the cell's AsyncLocalStorage context is still active.
const captureStream = (kind: 'out' | 'err') => new Writable({
  decodeStrings: false,
  write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    route(kind, chunk);
    callback();
  },
});
const kernelConsole = new Console({
  stdout: captureStream('out'),
  stderr: captureStream('err'),
  colorMode: false,
  inspectOptions: { depth: 3, breakLength: 120 },
});
Object.defineProperty(globalThis, 'console', { value: kernelConsole, writable: true, configurable: true, enumerable: false });
process.stdout.write = ((chunk: unknown) => { route('out', chunk); return true; }) as typeof process.stdout.write;
process.stderr.write = ((chunk: unknown) => { route('err', chunk); return true; }) as typeof process.stderr.write;
process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code ?? ''}) is disabled inside the kernel; end the cell instead`);
}) as typeof process.exit;

process.on('uncaughtException', (error) => {
  route('err', `Uncaught ${formatThrown(error)}\n`);
});
process.on('unhandledRejection', (reason) => {
  route('err', `Unhandled rejection: ${formatThrown(reason)}\n`);
});

// Timers created by a cell are cleared when that cell is interrupted.
function trackTimer<T extends (...args: any[]) => any>(real: T, kind: 'timers' | 'intervals'): T {
  return ((...args: unknown[]) => {
    const handle = real(...args);
    const cell = als.getStore();
    if (cell && !cell.done) cell[kind].add(handle);
    return handle;
  }) as unknown as T;
}
globalThis.setTimeout = trackTimer(realSetTimeout, 'timers') as unknown as typeof setTimeout;
globalThis.setInterval = trackTimer(realSetInterval, 'intervals') as unknown as typeof setInterval;

// ── module loading ─────────────────────────────────────────────────────────

const workspaceRequire = createRequire(path.join(workspace, '__kernel__.js'));
const builtins = new Set(builtinModules);

async function kernelImport(specifier: string): Promise<unknown> {
  if (specifier.startsWith('node:') || builtins.has(specifier)) return import(specifier);
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return import(pathToFileURL(path.resolve(workspace, specifier)).href);
  }
  if (/^[a-z]+:/i.test(specifier)) return import(specifier);
  return import(pathToFileURL(workspaceRequire.resolve(specifier)).href);
}

// ── RPC ────────────────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (message: string) => void;
  cell?: number;
}
let rpcSeq = 0;
const pending = new Map<number, PendingRpc>();

function rpc(apiPath: string, args: unknown[]): Promise<any> {
  const cell = als.getStore();
  if (cell?.cancelled) return Promise.reject(new Error(`${apiPath}: the cell was interrupted`));
  const callSite = new Error();
  const rid = ++rpcSeq;
  return new Promise((resolve, reject) => {
    pending.set(rid, {
      resolve,
      reject: (message: string) => {
        const error = new Error(message);
        const frames = (callSite.stack ?? '').split('\n').slice(1).filter(line => line.includes('<cell-'));
        error.stack = `Error: ${message}${frames.length ? '\n' + frames.join('\n') : ''}`;
        reject(error);
      },
      cell: cell?.id,
    });
    try {
      port.postMessage({ t: 'rpc', rid, path: apiPath, args, cell: cell?.id });
    } catch (error) {
      pending.get(rid)?.reject(`${apiPath}: arguments must be plain data (${(error as Error).message})`);
      pending.delete(rid);
    }
  });
}

// ── API ────────────────────────────────────────────────────────────────────

const HANDLE = '__cmHandle';
interface HandleSpec { kind: 'bash' | 'agent'; id?: string; label: string }

function defineHandleMeta(target: object, spec: HandleSpec): void {
  Object.defineProperty(target, HANDLE, { value: spec, enumerable: false });
}

let bashSeq = 0;

function makeBashHandle(started: Promise<{ id: string }>, cmd: string, id?: string): any {
  const spec: HandleSpec = { kind: 'bash', label: cmd, id };
  started.then(info => { spec.id = info.id; }, () => {});
  const withId = <T>(fn: (id: string) => Promise<T>) => started.then(info => fn(info.id));
  const handle: any = {
    cmd,
    get id() { return spec.id; },
    poll: () => withId(id => rpc('bash.poll', [id])),
    tail: (n = 20) => withId(id => rpc('bash.tail', [id, n])),
    output: () => withId(id => rpc('bash.output', [id])),
    kill: () => withId(id => rpc('bash.kill', [id])),
    wait: () => withId(id => rpc('bash.wait', [id])),
    then: (onFulfilled?: any, onRejected?: any) => handle.wait().then(onFulfilled, onRejected),
    catch: (onRejected?: any) => handle.wait().catch(onRejected),
  };
  defineHandleMeta(handle, spec);
  Object.defineProperty(handle, util.inspect.custom, {
    value: () => `BashHandle(${spec.id ?? 'starting'}: ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd})`,
    enumerable: false,
  });
  return handle;
}

function makeAgentHandle(started: Promise<{ id: string }>, label: string): any {
  const spec: HandleSpec = { kind: 'agent', label };
  started.then(info => { spec.id = info.id; }, () => {});
  const withId = <T>(fn: (id: string) => Promise<T>) => started.then(info => fn(info.id));
  const handle: any = {
    label,
    get id() { return spec.id; },
    status: () => withId(id => rpc('agents.status', [id])),
    log: () => withId(id => rpc('agents.log', [id])),
    cancel: () => withId(id => rpc('agents.cancel', [id])),
    steer: (message: string) => withId(id => rpc('agents.steer', [id, message])),
    wait: () => withId(id => rpc('agents.wait', [id])),
    then: (onFulfilled?: any, onRejected?: any) => handle.wait().then(onFulfilled, onRejected),
    catch: (onRejected?: any) => handle.wait().catch(onRejected),
  };
  defineHandleMeta(handle, spec);
  Object.defineProperty(handle, util.inspect.custom, {
    value: () => `AgentHandle(${spec.id ?? 'starting'}: ${label})`,
    enumerable: false,
  });
  return handle;
}

function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

const call = (apiPath: string) => (...args: unknown[]) => rpc(apiPath, args);

const skills = new Proxy(Object.create(null), {
  get(_target, name) {
    if (typeof name !== 'string') return undefined;
    if (name === 'then') return undefined; // not a thenable
    return (args?: unknown) => rpc('skills', [name, args ?? {}]);
  },
  has: () => true,
  ownKeys: () => [],
});

const api: Record<string, unknown> = {
  bash: (cmd: unknown, opts?: unknown) => {
    if (typeof cmd !== 'string' || !cmd.trim()) throw new TypeError('bash(cmd) needs a command string');
    const id = `b${++bashSeq}`;
    return makeBashHandle(quiet(rpc('bash.start', [cmd, opts ?? {}, id])), cmd, id);
  },
  read: call('read'),
  write: call('write'),
  patch: call('patch'),
  search: call('search'),
  glob: call('glob'),
  web: Object.freeze({ search: call('web.search'), fetch: call('web.fetch') }),
  memory: Object.freeze({ search: call('memory.search'), add: call('memory.add') }),
  agents: Object.freeze({
    spawn: (prompt: unknown, opts?: { name?: string }) => {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('agents.spawn(prompt) needs a task string');
      return makeAgentHandle(quiet(rpc('agents.spawn', [prompt, opts ?? {}])), opts?.name || prompt.slice(0, 40));
    },
    list: call('agents.list'),
  }),
  mcp: Object.freeze({ searchTools: call('mcp.searchTools'), call: call('mcp.call') }),
  send: call('send'),
  sendFile: call('sendFile'),
  ask: call('ask'),
  tools: call('tools'),
  skills,
  print: (...args: unknown[]) => kernelConsole.log(...args),
  require: workspaceRequire,
  WORKSPACE: workspace,
  __cm_import: kernelImport,
};
for (const [name, value] of Object.entries(api)) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

// Everything present now is kernel/Node baseline, not a user variable.
const baseline = new Set<string>(Object.getOwnPropertyNames(globalThis));
const API_NAMES = new Set(Object.keys(api));
const topLevelFunctions = new Set<string>();

function userVarNames(): string[] {
  return Object.getOwnPropertyNames(globalThis)
    .filter(name => !baseline.has(name) && !name.startsWith('__cm_'))
    .sort();
}

// ── formatting ─────────────────────────────────────────────────────────────

function formatThrown(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return inspect(error, { depth: 2 });
}

type Shifts = Array<[number, number, number, number]>;

/** Source text and column shifts of recent cells, for tracebacks into old cells. */
const cellSources = new Map<number, { source: string; shifts: Shifts; lines: number }>();

function mapColumn(shifts: Shifts, line: number, column: number): number {
  let generated = column - 1;
  let acc = 0;
  for (const [shiftLine, origCol, inserted, removed] of shifts) {
    if (shiftLine !== line) continue;
    const start = origCol + acc;
    if (generated < start) break;
    if (generated < start + inserted) return origCol + 1;
    acc += inserted - removed;
  }
  generated -= acc;
  return Math.max(1, generated + 1);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return `Uncaught ${inspect(error, { depth: 2 })}`;
  const header = `${error.name}: ${error.message}`;
  let snippet = '';
  const frames: string[] = [];
  for (const raw of (error.stack ?? '').split('\n')) {
    if (!/^\s+at /.test(raw) || !raw.includes('<cell-')) continue;
    const mapped = raw.replace(/<cell-(\d+)>:(\d+):(\d+)/, (_m, cellNo: string, lineNo: string, col: string) => {
      const info = cellSources.get(Number(cellNo));
      const line = Number(lineNo);
      // The IIFE's closing line is not user code.
      if (info && line > info.lines) return `<cell-${cellNo}>`;
      const column = info ? mapColumn(info.shifts, line, Number(col)) : Number(col);
      if (!snippet && info) {
        const text = info.source.split('\n')[line - 1];
        if (text !== undefined) snippet = `\n  ${line} | ${text.length > 200 ? text.slice(0, 200) + '…' : text}`;
      }
      return `<cell-${cellNo}>:${line}:${column}`;
    }).replace(/^\s+at (async )?/, '    at ');
    if (/<cell-\d+>$/.test(mapped)) continue;
    frames.push(mapped);
    if (frames.length >= 8) break;
  }
  return `${header}${frames.length ? '\n' + frames.join('\n') : ''}${snippet}`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return inspect(value, { depth: 3, maxArrayLength: 200, maxStringLength: OUTPUT_CAP, breakLength: 120, colors: false });
}

function cap(text: string): string {
  const buffer = new CappedText(OUTPUT_CAP);
  buffer.push(text);
  return buffer.toString();
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const handle = (value as Record<string, unknown>)?.[HANDLE] as HandleSpec | undefined;
  if (handle) return handle.kind === 'bash' ? `BashHandle(${handle.id ?? '?'})` : `AgentHandle(${handle.id ?? '?'})`;
  switch (typeof value) {
    case 'string': return `string (${value.length} chars)`;
    case 'number':
    case 'boolean':
    case 'bigint': return `${typeof value} = ${String(value).slice(0, 40)}`;
    case 'symbol': return 'symbol';
    case 'function': return /^class[\s{]/.test(fnToString.call(value)) ? 'class' : 'function';
    default: break;
  }
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${(value as Uint8Array).length ?? value.byteLength})`;
  if (value instanceof Date) return 'Date';
  if (value instanceof Error) return value.name;
  if (value instanceof Promise) return 'Promise';
  const name = (value as object).constructor?.name || 'Object';
  return `${name}{${Object.keys(value as object).length} keys}`;
}

// ── exec ───────────────────────────────────────────────────────────────────

interface ExecMessage {
  t: 'exec';
  id: number;
  n: number;
  code: string;
  source: string;
  shifts: Shifts;
  hasValue: boolean;
  timeoutMs: number;
  functionNames: string[];
}

const INTERRUPT = Symbol('interrupt');
const cells = new Map<number, Cell>();

async function runCell(msg: ExecMessage): Promise<void> {
  let abort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { abort = reject; });
  aborted.catch(() => {});
  const cell: Cell = {
    id: msg.id,
    n: msg.n,
    out: new CappedText(OUTPUT_CAP),
    err: new CappedText(OUTPUT_CAP),
    done: false,
    cancelled: false,
    timers: new Set(),
    intervals: new Set(),
    abort,
    aborted,
  };
  cells.set(cell.id, cell);
  running = cell;
  const bg = background.length > 0 ? background.toString() : '';
  background = new CappedText(OUTPUT_CAP);

  for (const name of msg.functionNames) topLevelFunctions.add(name);
  cellSources.set(msg.n, { source: msg.source, shifts: msg.shifts, lines: msg.source.split('\n').length });
  if (cellSources.size > 500) cellSources.delete(cellSources.keys().next().value as number);

  let value: string | undefined;
  let error: string | undefined;
  let interrupted = false;
  try {
    const script = new vm.Script(msg.code, {
      filename: `<cell-${msg.n}>`,
      importModuleDynamically: (vm as any).constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    } as vm.ScriptOptions);
    const result = await als.run(cell, async () => {
      const promise = script.runInThisContext({ timeout: msg.timeoutMs, displayErrors: false }) as Promise<{ __v: unknown } | undefined>;
      let outcome = await Promise.race([promise, aborted]);
      if (msg.hasValue && outcome && typeof outcome === 'object' && '__v' in outcome) {
        let v = outcome.__v;
        if (v instanceof Promise) v = await Promise.race([v, aborted]);
        outcome = { __v: v };
      }
      return outcome;
    });
    if (msg.hasValue && result && result.__v !== undefined) value = cap(formatValue(result.__v));
  } catch (thrown) {
    if (thrown === INTERRUPT || cell.cancelled) interrupted = true;
    else error = cap(formatError(thrown));
  } finally {
    cell.done = true;
    running = null;
    cells.delete(cell.id);
  }
  port.postMessage({
    t: 'done',
    id: msg.id,
    stdout: cell.out.toString(),
    stderr: cell.err.toString(),
    value,
    error,
    interrupted,
    background: bg,
  });
}

function interrupt(id: number): void {
  const cell = cells.get(id) ?? (running?.id === id ? running : null);
  if (!cell) return;
  cell.cancelled = true;
  for (const handle of cell.timers) realClearTimeout(handle);
  for (const handle of cell.intervals) realClearInterval(handle);
  for (const [rid, entry] of pending) {
    if (entry.cell === id) {
      pending.delete(rid);
      entry.reject('interrupted');
    }
  }
  cell.abort(INTERRUPT);
}

// ── snapshot / restore ─────────────────────────────────────────────────────

interface SnapshotEntry {
  name: string;
  kind: 'value' | 'source' | 'handle';
  data?: Uint8Array;
  source?: string;
  handle?: HandleSpec;
  proto?: string;
  summary: string;
}

function snapshot(): { entries: SnapshotEntry[]; skipped: Array<{ name: string; reason: string }> } {
  const entries: SnapshotEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let total = 0;
  for (const name of userVarNames()) {
    let value: unknown;
    try {
      value = (globalThis as Record<string, unknown>)[name];
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message });
      continue;
    }
    const summary = describe(value);
    const handle = value && typeof value === 'object' ? (value as Record<string, unknown>)[HANDLE] as HandleSpec | undefined : undefined;
    if (handle) {
      if (handle.id) entries.push({ name, kind: 'handle', handle: { ...handle }, summary });
      else skipped.push({ name, reason: 'handle not started' });
      continue;
    }
    if (typeof value === 'function') {
      const source = fnToString.call(value);
      if (!topLevelFunctions.has(name) || source.includes('[native code]')) {
        skipped.push({ name, reason: 'function is not a top-level declaration' });
      } else {
        entries.push({ name, kind: 'source', source, summary });
      }
      continue;
    }
    try {
      const data = v8.serialize(value);
      if (data.length > MAX_VAR_BYTES) {
        skipped.push({ name, reason: `too large (${data.length} bytes)` });
        continue;
      }
      if (total + data.length > MAX_SNAPSHOT_BYTES) {
        skipped.push({ name, reason: 'snapshot size budget exhausted' });
        continue;
      }
      total += data.length;
      let proto: string | undefined;
      const ctor = value && typeof value === 'object' ? Object.getPrototypeOf(value)?.constructor : undefined;
      if (ctor && typeof ctor.name === 'string' && topLevelFunctions.has(ctor.name)) proto = ctor.name;
      entries.push({ name, kind: 'value', data: new Uint8Array(data), proto, summary });
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message.split('\n')[0] });
    }
  }
  return { entries, skipped };
}

function restore(entries: SnapshotEntry[]): { restored: string[]; failed: Array<{ name: string; reason: string }> } {
  const restored: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const g = globalThis as Record<string, unknown>;
  const order = { source: 0, value: 1, handle: 2 } as const;
  const withProto: Array<{ name: string; proto: string }> = [];
  for (const entry of [...entries].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (API_NAMES.has(entry.name)) continue;
    try {
      if (entry.kind === 'value' && entry.data) {
        g[entry.name] = v8.deserialize(Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength));
        if (entry.proto) withProto.push({ name: entry.name, proto: entry.proto });
      } else if (entry.kind === 'source' && entry.source) {
        g[entry.name] = vm.runInThisContext(`(${entry.source}\n)`, { filename: `<restore:${entry.name}>` });
        topLevelFunctions.add(entry.name);
      } else if (entry.kind === 'handle' && entry.handle?.id) {
        const started = Promise.resolve({ id: entry.handle.id });
        if (entry.handle.kind === 'bash') {
          const seq = Number(/^b(\d+)$/.exec(entry.handle.id)?.[1] ?? 0);
          if (seq > bashSeq) bashSeq = seq;
          g[entry.name] = makeBashHandle(started, entry.handle.label, entry.handle.id);
        } else {
          g[entry.name] = makeAgentHandle(started, entry.handle.label);
        }
      } else {
        throw new Error('empty snapshot entry');
      }
      restored.push(entry.name);
    } catch (error) {
      failed.push({ name: entry.name, reason: (error as Error).message.split('\n')[0] });
    }
  }
  for (const { name, proto } of withProto) {
    const ctor = g[proto];
    const value = g[name];
    if (typeof ctor === 'function' && value && typeof value === 'object') {
      try { Object.setPrototypeOf(value, ctor.prototype); } catch { /* keep plain object */ }
    }
  }
  return { restored, failed };
}

// ── message loop ───────────────────────────────────────────────────────────

port.on('message', (msg: any) => {
  switch (msg?.t) {
    case 'exec':
      void runCell(msg as ExecMessage);
      break;
    case 'interrupt':
      interrupt(msg.id);
      break;
    case 'rpc-result': {
      const entry = pending.get(msg.rid);
      if (!entry) break;
      pending.delete(msg.rid);
      if (msg.ok) {
        let value = msg.value;
        if (msg.json && typeof value === 'string') {
          try { value = JSONparse(value); } catch { /* keep string */ }
        }
        entry.resolve(value);
      } else {
        entry.reject(String(msg.error ?? 'tool call failed'));
      }
      break;
    }
    case 'vars':
      port.postMessage({
        t: 'vars-result',
        rid: msg.rid,
        vars: userVarNames().map(name => {
          let summary: string;
          try { summary = describe((globalThis as Record<string, unknown>)[name]); } catch { summary = '?'; }
          return { name, summary };
        }),
      });
      break;
    case 'snapshot':
      port.postMessage({ t: 'snapshot-result', rid: msg.rid, ...snapshot() });
      break;
    case 'restore':
      port.postMessage({ t: 'restore-result', rid: msg.rid, ...restore(msg.entries ?? []) });
      break;
    default:
      break;
  }
});

port.postMessage({ t: 'ready' });
