/**
 * Host side of the kernel's tool API.
 *
 * Every function the model calls inside the kernel (`read`, `bash`,
 * `web.search`, `skills.x`…) arrives here as an RPC and is dispatched to the
 * REAL registered tools through one `callTool(name, args, ctx)` function, so
 * code mode reuses the skill registry, native handlers and script skills.
 */

import type { SkillRegistry } from '../skills/registry.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { RpcContext } from './kernel.js';

export interface ToolCallResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

/** Per-exec context forwarded to tool handlers (who is asking, which turn). */
export interface ToolCallContext {
  sessionId: string;
  workspace: string;
  userId?: string;
  userMessage?: string;
  signal?: AbortSignal;
}

export type CallTool = (name: string, args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolCallResult>;

export interface ToolCatalog {
  has(name: string): boolean;
  /** Model-visible executable tools (name, description, schema) in stable order. */
  list(): Array<{ name: string; description: string; inputSchema?: { properties?: Record<string, any>; required?: string[] } }>;
}

export class ToolUnavailableError extends Error {}

/** Catalog view of a SkillRegistry: available, executable, model-visible skills. */
export function registryCatalog(registry: SkillRegistry): ToolCatalog {
  const visible = () => registry.getExecutableSkills();
  return {
    has: (name) => {
      const skill = registry.getSkill(name);
      return !!skill && skill.available && skill.hasScripts;
    },
    list: () => visible()
      .map(skill => ({
        name: skill.name,
        description: skill.description,
        inputSchema: skill.frontmatter.inputSchema as { properties?: Record<string, any>; required?: string[] } | undefined,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * Default `callTool`: native handler when the skill has one, else the script
 * executor, unwrapping script JSON the same way the agent loop does.
 */
export function createRegistryCallTool(registry: SkillRegistry, executor?: SkillExecutor | null): CallTool {
  return async (name, args, ctx) => {
    const skill = registry.getSkill(name);
    if (!skill || !skill.available) throw new ToolUnavailableError(`no tool named "${name}" is registered`);
    if (skill.handler) {
      const result = await skill.handler({
        args,
        workspace: ctx.workspace,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        signal: ctx.signal,
        userMessage: ctx.userMessage,
      });
      return { success: result.success, output: result.output ?? '', error: result.error };
    }
    if (!skill.hasScripts || !executor) {
      throw new ToolUnavailableError(`"${name}" is documentation-only and cannot be called`);
    }
    const result = await executor.execute(skill, {
      skillName: name,
      args,
      cwd: ctx.workspace,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    let output = result.output ?? '';
    let error = result.error;
    let success = result.success;
    let exitCode = result.exitCode;
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'output' in parsed) {
        output = typeof parsed.output === 'string' ? parsed.output : parsed.output == null ? '' : JSON.stringify(parsed.output);
        if (parsed.error) error = String(parsed.error);
        if (typeof parsed.success === 'boolean') success = parsed.success;
        if (typeof parsed.exitCode === 'number') exitCode = parsed.exitCode;
      }
    } catch {
      // raw output
    }
    return { success, output, error, exitCode };
  };
}

// ── background shell ───────────────────────────────────────────────────────

export interface BashJobStatus {
  running: boolean;
  exitCode?: number | null;
}

export interface BashJobResult {
  exitCode: number | null;
  ok: boolean;
  output: string;
}

export interface ShellBackend {
  start(cmd: string, opts: { cwd?: string; timeout?: number }, ctx: ToolCallContext): Promise<{ id: string }>;
  poll(id: string): Promise<BashJobStatus>;
  tail(id: string, lines: number): Promise<string>;
  output(id: string): Promise<string>;
  kill(id: string): Promise<string>;
  wait(id: string, signal?: AbortSignal): Promise<BashJobResult>;
  /** Called once per job when it finishes (push-capable backends). */
  onDone?(listener: (id: string, result: BashJobResult, cmd: string) => void): void;
}

const DEFAULT_BASH_TIMEOUT_MS = 30 * 60_000;

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - Math.max(1, n))).join('\n');
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('interrupted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('interrupted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * Fallback when no `process` tool exists: the bash tool is awaited in the
 * background, so the handle returns at once but output appears only when the
 * command finishes (the script executor's own timeout still applies).
 */
export function createAwaitedBashShell(callTool: CallTool): ShellBackend {
  interface Job { cmd: string; done: boolean; result?: BashJobResult; promise: Promise<BashJobResult>; abort: AbortController }
  const jobs = new Map<string, Job>();
  const listeners: Array<(id: string, result: BashJobResult, cmd: string) => void> = [];
  let seq = 0;
  const get = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new Error(`unknown bash handle ${id}`);
    return job;
  };
  return {
    async start(cmd, opts, ctx) {
      const id = `b${++seq}`;
      const abort = new AbortController();
      const job: Job = { cmd, done: false, abort, promise: Promise.resolve(null as never) };
      job.promise = callTool('bash', {
        command: cmd,
        timeout: opts.timeout ?? DEFAULT_BASH_TIMEOUT_MS,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        max_output: 204_800,
      }, { ...ctx, signal: abort.signal })
        .then((res): BashJobResult => {
          const exitCode = typeof res.exitCode === 'number' ? res.exitCode : res.success ? 0 : 1;
          const output = [res.output, res.error && res.error !== res.output ? res.error : ''].filter(Boolean).join('\n');
          return { exitCode, ok: exitCode === 0, output };
        })
        .catch((error: unknown): BashJobResult => ({ exitCode: 1, ok: false, output: (error as Error).message }))
        .then(result => {
          job.done = true;
          job.result = result;
          for (const listener of listeners) listener(id, result, cmd);
          return result;
        });
      jobs.set(id, job);
      return { id };
    },
    async poll(id) {
      const job = get(id);
      return job.done ? { running: false, exitCode: job.result!.exitCode } : { running: true };
    },
    async tail(id, n) {
      const job = get(id);
      return job.done ? lastLines(job.result!.output, n) : '';
    },
    async output(id) {
      const job = get(id);
      return job.done ? job.result!.output : '';
    },
    async kill(id) {
      const job = get(id);
      if (job.done) return `already finished (exit ${job.result!.exitCode})`;
      job.abort.abort();
      return 'kill requested';
    },
    wait(id, signal) {
      return abortable(get(id).promise, signal);
    },
    onDone(listener) {
      listeners.push(listener);
    },
  };
}

/**
 * Adapter for a background-capable shell: `bash {command, background:true}`
 * returns a handle id, and a `process` tool answers
 * `{action: poll|log|kill|wait, id}`. Output parsing is tolerant (JSON or
 * text). Pass a custom ShellBackend in deps if the contract differs.
 */
export function createProcessToolShell(callTool: CallTool, ctxDefaults: () => ToolCallContext): ShellBackend {
  const cmds = new Map<string, string>();
  const run = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const res = await callTool('process', args, { ...ctxDefaults(), signal });
    if (!res.success) throw new Error(res.error || res.output || 'process tool failed');
    return res.output;
  };
  const parse = (text: string): Record<string, any> => {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') return value as Record<string, any>;
    } catch { /* text */ }
    const exit = text.match(/exit(?:[_ ]?code)?\s*[=:]\s*(-?\d+)/i);
    const running = /\b(running|in progress|still running)\b/i.test(text) && !exit;
    return { running, exitCode: exit ? Number(exit[1]) : undefined, output: text };
  };
  const statusOf = (info: Record<string, any>): BashJobStatus => {
    const exit = info.exitCode ?? info.exit_code ?? info.code;
    const running = typeof info.running === 'boolean'
      ? info.running
      : typeof info.status === 'string' ? /run/i.test(info.status) : exit === undefined || exit === null;
    return running ? { running: true } : { running: false, exitCode: typeof exit === 'number' ? exit : null };
  };
  const outputOf = (info: Record<string, any>, raw: string) =>
    typeof info.output === 'string' ? info.output : typeof info.log === 'string' ? info.log : raw;
  return {
    async start(cmd, opts, ctx) {
      const res = await callTool('bash', {
        command: cmd,
        background: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.timeout ? { timeout: opts.timeout } : {}),
      }, ctx);
      if (!res.success) throw new Error(res.error || res.output || 'bash failed to start');
      const info = parse(res.output);
      const id = String(info.id ?? info.handle ?? info.session_id ?? info.pid
        ?? res.output.match(/\b(?:id|handle|session|pid)\b["':=\s]+([\w.-]+)/i)?.[1] ?? '');
      if (!id) throw new Error(`could not read a handle id from bash output: ${res.output.slice(0, 200)}`);
      cmds.set(id, cmd);
      return { id };
    },
    async poll(id) {
      return statusOf(parse(await run({ action: 'poll', id })));
    },
    async tail(id, n) {
      const raw = await run({ action: 'log', id });
      return lastLines(outputOf(parse(raw), raw), n);
    },
    async output(id) {
      const raw = await run({ action: 'log', id });
      return outputOf(parse(raw), raw);
    },
    async kill(id) {
      return run({ action: 'kill', id });
    },
    async wait(id, signal) {
      const raw = await run({ action: 'wait', id }, signal);
      const info = parse(raw);
      const status = statusOf(info);
      const exitCode = status.running ? null : status.exitCode ?? null;
      return { exitCode, ok: exitCode === 0, output: outputOf(info, raw) };
    },
  };
}

// ── dispatcher ─────────────────────────────────────────────────────────────

export interface BackgroundEvent {
  type: 'bash-done';
  sessionId: string;
  id: string;
  command: string;
  exitCode: number | null;
  tail: string;
  /** Ready-to-inject message, e.g. `[bash-done b1 exit=0] npm test`. */
  text: string;
}

export interface KernelApiOptions {
  sessionId: string;
  workspace: string;
  callTool: CallTool;
  catalog: ToolCatalog;
  shell?: ShellBackend;
  /** Names never callable from the kernel (the code tool itself). */
  hiddenTools?: string[];
  /** A finished background job, reported while no cell is running. */
  onBashDone?: (event: BackgroundEvent) => void;
  /** Is a cell currently running? (bash-done during a cell becomes a note.) */
  isBusy?: () => boolean;
  /** Poll interval for backends without push completion (ms). */
  pollIntervalMs?: number;
  agentPollIntervalMs?: number;
}

/** Tool names behind each core API function, first available wins. */
export const API_TOOL_MAP = {
  read: ['read_file'],
  write: ['write_file'],
  patch: ['patch', 'edit_file'],
  search: ['grep', 'search_files'],
  glob: ['glob'],
  bash: ['bash'],
  'web.search': ['web_search'],
  'web.fetch': ['web_fetch', 'webfetch'],
  'memory.search': ['memory_search'],
  'memory.add': ['memory', 'core_memory', 'memory_add', 'remember'],
  'agents.spawn': ['spawn_agent'],
  'agents.list': ['check_agents'],
  'mcp.searchTools': ['tool_search', 'mcp'],
  'mcp.call': ['mcp'],
  send: ['send_message'],
  sendFile: ['send_file'],
  ask: ['question', 'ask_user', 'clarify'],
} as const satisfies Record<string, readonly string[]>;

export type ApiName = keyof typeof API_TOOL_MAP;

export function resolveApiTool(catalog: ToolCatalog, api: ApiName): string | undefined {
  return API_TOOL_MAP[api].find(name => catalog.has(name));
}

/** Tools reachable through a core API function (so skills.* lists the rest). */
export function coveredTools(catalog: ToolCatalog): Set<string> {
  const covered = new Set<string>();
  for (const api of Object.keys(API_TOOL_MAP) as ApiName[]) {
    const tool = resolveApiTool(catalog, api);
    if (tool) covered.add(tool);
  }
  if (catalog.has('process') && catalog.has('bash')) covered.add('process');
  if (catalog.has('spawn_agent')) covered.add('check_agents');
  return covered;
}

/** Parse JSON-looking text; otherwise return it unchanged. */
export function maybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** read_file prints `  12| text`; give the kernel raw text when every line has that gutter. */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const gutter = /^\s*\d+\s?[|│→\t] ?/;
  if (lines.length === 0 || !lines.every(line => gutter.test(line) || line === '')) return text;
  if (!lines.some(line => gutter.test(line))) return text;
  return lines.map(line => line.replace(gutter, '')).join('\n');
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
  context?: boolean;
}

export function parseSearchOutput(text: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const raw of text.split('\n')) {
    if (!raw || raw === '--' || raw === '(no matches)' || raw.startsWith('... (truncated')) continue;
    const hit = raw.match(/^(.+?):(\d+):\s?(.*)$/);
    if (hit) {
      matches.push({ file: hit[1], line: Number(hit[2]), text: hit[3] });
      continue;
    }
    const ctx = raw.match(/^(.+?)-(\d+)-\s?(.*)$/);
    if (ctx) matches.push({ file: ctx[1], line: Number(ctx[2]), text: ctx[3], context: true });
  }
  return matches;
}

function asObject(value: unknown, apiName: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${apiName}: options must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, apiName: string, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${apiName}: ${what} must be a string`);
  return value;
}

const AGENT_TERMINAL = /\b(succeeded|completed|complete|done|failed|cancelled|canceled|timed[_ ]?out|error)\b/i;

export class KernelApi {
  private readonly opts: KernelApiOptions;
  readonly shell: ShellBackend;
  private exec: Omit<ToolCallContext, 'signal' | 'sessionId' | 'workspace'> = {};
  /** Backend job id → watch entry (kernelId is the id the model sees). */
  private readonly watched = new Map<string, { cmd: string; kernelId: string; waited: boolean }>();
  /** Kernel handle id (h.id) → backend job id. */
  private readonly handleIds = new Map<string, string>();
  /** Jobs that finished during a cell without being awaited (yet): id → note. */
  private readonly finishedDuringCell = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: KernelApiOptions) {
    this.opts = opts;
    this.shell = opts.shell
      ?? (opts.catalog.has('process') && opts.catalog.has('bash')
        ? createProcessToolShell(opts.callTool, () => this.ctx())
        : createAwaitedBashShell(opts.callTool));
    this.shell.onDone?.((id, result, cmd) => this.jobFinished(id, result, cmd));
  }

  /** Who is running the current cell (user id, message) for tool handlers. */
  setExecContext(ctx: Omit<ToolCallContext, 'signal' | 'sessionId' | 'workspace'>): void {
    this.exec = { ...ctx };
  }

  private ctx(signal?: AbortSignal): ToolCallContext {
    return { sessionId: this.opts.sessionId, workspace: this.opts.workspace, ...this.exec, signal };
  }

  private tool(api: ApiName): string {
    const name = resolveApiTool(this.opts.catalog, api);
    if (!name) {
      throw new ToolUnavailableError(`${api}() is unavailable: no ${API_TOOL_MAP[api].map(n => `"${n}"`).join(' or ')} tool is registered`);
    }
    return name;
  }

  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.opts.callTool(name, args, this.ctx(signal));
    if (!result.success) {
      const detail = (result.error || result.output || 'failed with no output').trim();
      throw new Error(`${name}: ${detail.length > 4_000 ? detail.slice(0, 4_000) + '…' : detail}`);
    }
    return result.output ?? '';
  }

  dispatch = async (apiPath: string, args: unknown[], rpc: RpcContext): Promise<unknown> => {
    const signal = rpc.signal;
    switch (apiPath) {
      case 'read': {
        const file = requireString(args[0], 'read', 'path');
        const o = asObject(args[1], 'read');
        const out = await this.call(this.tool('read'), { path: file, ...(o.offset !== undefined ? { offset: o.offset } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) }, signal);
        return stripLineNumbers(out);
      }
      case 'write': {
        const file = requireString(args[0], 'write', 'path');
        const content = requireString(args[1], 'write', 'content');
        return this.call(this.tool('write'), { path: file, content, ...asObject(args[2], 'write') }, signal);
      }
      case 'patch': {
        const file = requireString(args[0], 'patch', 'path');
        const oldText = requireString(args[1], 'patch', 'old');
        const newText = requireString(args[2], 'patch', 'new');
        const o = asObject(args[3], 'patch');
        return this.call(this.tool('patch'), {
          path: file, old_string: oldText, new_string: newText,
          ...(o.replaceAll !== undefined || o.replace_all !== undefined ? { replace_all: Boolean(o.replaceAll ?? o.replace_all) } : {}),
        }, signal);
      }
      case 'search': {
        const pattern = requireString(args[0], 'search', 'pattern');
        const o = asObject(args[1], 'search');
        const out = await this.call(this.tool('search'), {
          pattern,
          ...(o.glob !== undefined ? { glob: o.glob } : {}),
          ...(o.path !== undefined ? { path: o.path } : {}),
          ...(o.context !== undefined ? { context: o.context } : {}),
          max_results: o.max ?? o.max_results ?? 200,
        }, signal);
        return parseSearchOutput(out);
      }
      case 'glob': {
        const pattern = requireString(args[0], 'glob', 'pattern');
        const o = asObject(args[1], 'glob');
        const out = await this.call(this.tool('glob'), { pattern, ...(o.path !== undefined ? { path: o.path } : {}) }, signal);
        return out.split('\n').map(line => line.trim()).filter(line => line && line !== '(no matches)' && !line.startsWith('... (truncated'));
      }
      case 'web.search': {
        const query = requireString(args[0], 'web.search', 'query');
        return maybeJson(await this.call(this.tool('web.search'), { query, ...asObject(args[1], 'web.search') }, signal));
      }
      case 'web.fetch': {
        const url = requireString(args[0], 'web.fetch', 'url');
        const o = asObject(args[1], 'web.fetch');
        return this.call(this.tool('web.fetch'), { url, ...(o.maxLength !== undefined ? { max_length: o.maxLength } : {}), ...o }, signal);
      }
      case 'memory.search': {
        const query = requireString(args[0], 'memory.search', 'query');
        return maybeJson(await this.call(this.tool('memory.search'), { query, ...asObject(args[1], 'memory.search') }, signal));
      }
      case 'memory.add': {
        const tool = this.tool('memory.add');
        const payload = typeof args[0] === 'string'
          ? { action: 'add', content: args[0], ...asObject(args[1], 'memory.add') }
          : asObject(args[0], 'memory.add');
        return maybeJson(await this.call(tool, payload, signal));
      }
      case 'agents.spawn': {
        const task = requireString(args[0], 'agents.spawn', 'prompt');
        const o = asObject(args[1], 'agents.spawn');
        const out = await this.call(this.tool('agents.spawn'), {
          task,
          ...(o.name !== undefined ? { label: o.name } : {}),
          ...(o.model_tier !== undefined || o.model !== undefined ? { model_tier: o.model_tier ?? o.model } : {}),
          ...(o.skills !== undefined ? { skills: Array.isArray(o.skills) ? o.skills.join(',') : o.skills } : {}),
          ...(o.context !== undefined ? { context: o.context } : {}),
          wait: false,
        }, signal);
        const parsed = maybeJson(out) as Record<string, unknown> | string;
        const id = typeof parsed === 'object' && parsed && (parsed.runId ?? parsed.run_id ?? parsed.id)
          ? String(parsed.runId ?? parsed.run_id ?? parsed.id)
          : String(out.match(/\(run:\s*([\w-]+)\)/)?.[1] ?? out.match(/\brun(?:_id|Id)?["':=\s]+([\w-]{6,})/i)?.[1] ?? '');
        if (!id) throw new Error(`spawn_agent did not return a run id: ${out.slice(0, 200)}`);
        return { id };
      }
      case 'agents.status':
        return maybeJson(await this.call('check_agents', { action: 'info', run_id: requireString(args[0], 'status', 'id') }, signal));
      case 'agents.log':
        return this.call('check_agents', { action: 'log', run_id: requireString(args[0], 'log', 'id') }, signal);
      case 'agents.cancel':
        return this.call('check_agents', { action: 'cancel', run_id: requireString(args[0], 'cancel', 'id') }, signal);
      case 'agents.steer':
        return this.call('check_agents', { action: 'steer', run_id: requireString(args[0], 'steer', 'id'), message: requireString(args[1], 'steer', 'message') }, signal);
      case 'agents.list':
        return maybeJson(await this.call(this.tool('agents.list'), { action: 'list' }, signal));
      case 'agents.wait':
        return this.waitForAgent(requireString(args[0], 'wait', 'id'), signal);
      case 'mcp.searchTools':
        return this.searchMcpTools(typeof args[0] === 'string' ? args[0] : '', asObject(args[1], 'mcp.searchTools'), signal);
      case 'mcp.call': {
        const name = requireString(args[0], 'mcp.call', 'name');
        let server: string;
        let tool: string;
        let toolArgs: unknown;
        if (typeof args[1] === 'string') {
          server = name;
          tool = args[1];
          toolArgs = args[2];
        } else {
          const split = name.match(/^([^./:]+)[./:](.+)$/);
          if (!split) throw new TypeError('mcp.call: name must be "server.tool" (or pass server, tool, args)');
          server = split[1];
          tool = split[2];
          toolArgs = args[1];
        }
        return maybeJson(await this.call(this.tool('mcp.call'), { action: 'call', server, tool, args: asObject(toolArgs, 'mcp.call') }, signal));
      }
      case 'send':
        return this.call(this.tool('send'), { message: requireString(args[0], 'send', 'text') }, signal);
      case 'sendFile': {
        const file = requireString(args[0], 'sendFile', 'path');
        return this.call(this.tool('sendFile'), { file_path: file, ...(typeof args[1] === 'string' ? { caption: args[1] } : {}) }, signal);
      }
      case 'ask': {
        const question = requireString(args[0], 'ask', 'question');
        return maybeJson(await this.call(this.tool('ask'), { question, ...(Array.isArray(args[1]) ? { options: args[1] } : {}) }, signal));
      }
      case 'tools':
        return this.opts.catalog.list()
          .filter(tool => !this.hidden(tool.name))
          .map(tool => ({ name: tool.name, description: tool.description, params: Object.keys(tool.inputSchema?.properties ?? {}) }));
      case 'skills': {
        const name = requireString(args[0], 'skills', 'name');
        if (this.hidden(name) || !this.opts.catalog.has(name)) {
          const available = this.opts.catalog.list().map(tool => tool.name).filter(tool => !this.hidden(tool));
          throw new ToolUnavailableError(`skills.${name}: no such tool. Available: ${available.join(', ')}`);
        }
        let toolArgs = args[1];
        if (typeof toolArgs === 'string') {
          // skills.x("text") → the tool's single required string parameter.
          const schema = this.opts.catalog.list().find(tool => tool.name === name)?.inputSchema;
          const first = schema?.required?.[0] ?? Object.keys(schema?.properties ?? {})[0];
          if (!first) throw new TypeError(`skills.${name}: pass an args object`);
          toolArgs = { [first]: toolArgs };
        }
        return maybeJson(await this.call(name, asObject(toolArgs, `skills.${name}`), signal));
      }
      case 'bash.start': {
        this.tool('bash');
        const cmd = requireString(args[0], 'bash', 'cmd');
        const o = asObject(args[1], 'bash');
        // Background jobs outlive the cell: no cell signal here.
        const started = await this.shell.start(cmd, {
          cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
          timeout: typeof o.timeout === 'number' ? o.timeout : undefined,
        }, this.ctx());
        // The kernel names the handle synchronously (h.id); map it to the backend's id.
        const kernelId = typeof args[2] === 'string' && args[2] ? args[2] : started.id;
        this.handleIds.set(kernelId, started.id);
        this.watch(started.id, kernelId, cmd);
        return { id: kernelId };
      }
      case 'bash.poll':
        return this.shell.poll(this.backendId(args[0]));
      case 'bash.tail':
        return this.shell.tail(this.backendId(args[0]), typeof args[1] === 'number' ? args[1] : 20);
      case 'bash.output':
        return this.shell.output(this.backendId(args[0]));
      case 'bash.kill':
        return this.shell.kill(this.backendId(args[0]));
      case 'bash.wait': {
        const id = this.backendId(args[0]);
        const entry = this.watched.get(id);
        if (entry) entry.waited = true;
        this.finishedDuringCell.delete(String(args[0]));
        return this.shell.wait(id, signal);
      }
      default:
        throw new Error(`unknown kernel API: ${apiPath}`);
    }
  };

  private hidden(name: string): boolean {
    return (this.opts.hiddenTools ?? []).includes(name);
  }

  // ── background job completion → [bash-done …] ─────────────────────────────

  private backendId(kernelId: unknown): string {
    const id = requireString(kernelId, 'bash handle', 'id');
    return this.handleIds.get(id) ?? id;
  }

  private watch(id: string, kernelId: string, cmd: string): void {
    this.watched.set(id, { cmd, kernelId, waited: false });
    if (!this.shell.onDone) this.ensurePolling();
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void (async () => {
        for (const [id, entry] of [...this.watched]) {
          try {
            const status = await this.shell.poll(id);
            if (!status.running) {
              const tail = await this.shell.tail(id, 20).catch(() => '');
              this.jobFinished(id, { exitCode: status.exitCode ?? null, ok: status.exitCode === 0, output: tail }, entry.cmd);
            }
          } catch {
            this.watched.delete(id);
          }
        }
        if (this.watched.size === 0 && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      })();
    }, this.opts.pollIntervalMs ?? 2_000);
    this.pollTimer.unref?.();
  }

  private jobFinished(backendId: string, result: BashJobResult, cmd: string): void {
    const entry = this.watched.get(backendId);
    this.watched.delete(backendId);
    if (!entry || entry.waited) return;
    const id = entry.kernelId;
    const shortCmd = cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
    const text = `[bash-done ${id} exit=${result.exitCode ?? '?'}] ${shortCmd}`;
    const tail = lastLines(result.output, 20);
    if (this.opts.isBusy?.() || !this.opts.onBashDone) {
      // The running (or next) cell may still await it; report at cell end if not.
      this.finishedDuringCell.set(id, `${text}${tail ? `\n${tail}` : ''}`);
      return;
    }
    this.opts.onBashDone({ type: 'bash-done', sessionId: this.opts.sessionId, id, command: cmd, exitCode: result.exitCode, tail, text });
  }

  /** Notes for the cell that just finished: background jobs done and never awaited. */
  drainNotes(): string[] {
    const notes = [...this.finishedDuringCell.values()];
    this.finishedDuringCell.clear();
    return notes;
  }

  private async waitForAgent(id: string, signal?: AbortSignal): Promise<unknown> {
    const interval = this.opts.agentPollIntervalMs ?? 3_000;
    for (;;) {
      if (signal?.aborted) throw new Error('interrupted');
      const out = await this.call('check_agents', { action: 'info', run_id: id }, signal);
      const info = maybeJson(out);
      const status = typeof info === 'object' && info ? String((info as Record<string, unknown>).status ?? '') : '';
      if (status ? AGENT_TERMINAL.test(status) && !/running|pending|queued/i.test(status) : (typeof info === 'object' && info && ('response' in info || 'result' in info))) {
        return info;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('interrupted')); }, { once: true });
      });
    }
  }

  private async searchMcpTools(query: string, o: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tool('mcp.searchTools');
    if (tool === 'tool_search') return maybeJson(await this.call('tool_search', { query, ...o }, signal));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const servers = typeof o.server === 'string'
      ? [o.server]
      : (await this.call('mcp', { action: 'list' }, signal))
          .split('\n')
          .map(line => line.match(/^- ([^\s—(]+)/)?.[1])
          .filter((name): name is string => !!name);
    const results: Array<{ server: string; tools: string }> = [];
    for (const server of servers) {
      let listing: string;
      try {
        listing = await this.call('mcp', { action: 'tools', server }, signal);
      } catch (error) {
        listing = `error: ${(error as Error).message}`;
      }
      const lower = listing.toLowerCase();
      if (terms.length === 0 || terms.some(term => lower.includes(term))) results.push({ server, tools: listing });
    }
    return results;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
