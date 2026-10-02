/**
 * Code-mode prompts.
 *
 * Byte-stable by construction: no timestamps, no session data, tools sorted
 * by name, schemas rendered deterministically. Same registry → same bytes,
 * so the provider cache holds for the whole session.
 */

import type { SkillRegistry } from '../skills/registry.js';
import { coveredTools, registryCatalog, resolveApiTool, type ApiName, type ToolCatalog } from './api.js';

export const CODE_TOOL_NAME = 'exec';
export const EXECUTE_CODE_TOOL_NAME = 'execute_code';

/** Rough budget: ~6k tokens ≈ 24k chars. */
const DEFAULT_MAX_CHARS = 24_000;

interface ApiDoc {
  api: ApiName | null;
  lines: string[];
}

const CORE_API: ApiDoc[] = [
  { api: null, lines: ['// Files and search'] },
  { api: 'read', lines: ['read(path: string, opts?: {offset?: number, limit?: number}): Promise<string>  // file text; offset is the 1-based first line'] },
  { api: 'write', lines: ['write(path: string, content: string): Promise<string>  // create or overwrite a file'] },
  { api: 'patch', lines: ['patch(path: string, old: string, new: string, opts?: {replaceAll?: boolean}): Promise<string>  // replace an exact snippet (must be unique unless replaceAll)'] },
  { api: 'search', lines: ['search(pattern: string, opts?: {glob?: string, path?: string, context?: number, max?: number}): Promise<Array<{file: string, line: number, text: string}>>  // regex over file contents (max default 200)'] },
  { api: 'glob', lines: ['glob(pattern: string, opts?: {path?: string}): Promise<string[]>  // paths matching e.g. "src/**/*.ts"'] },
  { api: null, lines: ['// Shell'] },
  {
    api: 'bash',
    lines: [
      'bash(cmd: string, opts?: {cwd?: string, timeout?: number}): BashHandle  // starts now and returns at once (NOT a promise)',
      '  await h  → {exitCode: number | null, ok: boolean, output: string}  // wait for it to finish',
      '  h.poll(): Promise<{running: boolean, exitCode?: number | null}>;  h.tail(n = 20): Promise<string>;  h.output(): Promise<string>;  h.kill(): Promise<string>;  h.id: string',
    ],
  },
  { api: null, lines: ['// Web'] },
  { api: 'web.search', lines: ['web.search(query: string, opts?: {count?: number, freshness?: string}): Promise<any>  // web results'] },
  { api: 'web.fetch', lines: ['web.fetch(url: string, opts?: {maxLength?: number}): Promise<string>  // page text'] },
  { api: null, lines: ['// Memory'] },
  { api: 'memory.search', lines: ['memory.search(query: string, opts?: {limit?: number}): Promise<any>  // the user\'s long-term memory'] },
  { api: 'memory.add', lines: ['memory.add(text: string | object): Promise<any>  // save a durable fact (declarative, not an order to yourself)'] },
  { api: null, lines: ['// Sub-agents'] },
  {
    api: 'agents.spawn',
    lines: [
      'agents.spawn(prompt: string, opts?: {name?: string, model_tier?: "fast" | "standard" | "capable", skills?: string[], context?: string}): AgentHandle  // starts a child agent, returns at once',
      '  await a → final report (a self-report: verify it);  a.status();  a.log();  a.cancel();  a.steer(message: string);  a.id: string',
    ],
  },
  { api: 'agents.list', lines: ['agents.list(): Promise<any>  // your running and finished children'] },
  { api: null, lines: ['// MCP servers'] },
  { api: 'mcp.searchTools', lines: ['mcp.searchTools(query: string, opts?: {server?: string}): Promise<any>  // find MCP tools and their schemas'] },
  { api: 'mcp.call', lines: ['mcp.call(name: string /* "server.tool" */, args?: object): Promise<any>'] },
  { api: null, lines: ['// The user'] },
  { api: 'send', lines: ['send(text: string): Promise<string>  // message the user now (progress, partial results)'] },
  { api: 'sendFile', lines: ['sendFile(path: string, caption?: string): Promise<string>  // deliver a file under output/'] },
  { api: 'ask', lines: ['ask(question: string, options?: string[]): Promise<any>  // ask the user; prefer acting when the answer is guessable'] },
];

const ALWAYS_API = [
  '// Kernel',
  'print(...values): void  // same as console.log',
  'tools(): Promise<Array<{name: string, description: string, params: string[]}>>  // every callable tool',
  'require(id) / await import(id)  // Node built-ins and workspace packages',
];

function schemaType(prop: Record<string, any> | undefined): string {
  if (!prop) return 'any';
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.length <= 6) {
    return prop.enum.map((value: unknown) => JSON.stringify(value)).join(' | ');
  }
  switch (prop.type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return `${schemaType(prop.items)}[]`;
    case 'object': return 'object';
    default: return 'any';
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? flat;
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + '…' : sentence;
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `skills.${name}` : `skills[${JSON.stringify(name)}]`;
}

function skillSignature(tool: ReturnType<ToolCatalog['list']>[number], detail: 'full' | 'params' | 'name'): string {
  const key = propertyKey(tool.name);
  if (detail === 'name') return key;
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const params = Object.keys(props)
    .sort((a, b) => Number(required.has(b)) - Number(required.has(a)) || (a < b ? -1 : a > b ? 1 : 0))
    .map(name => `${name}${required.has(name) ? '' : '?'}: ${schemaType(props[name])}`);
  const signature = `${key}({${params.join(', ')}})`;
  return detail === 'full' && tool.description ? `${signature}  // ${oneLine(tool.description, 100)}` : signature;
}

function asCatalog(source: SkillRegistry | ToolCatalog): ToolCatalog {
  return 'has' in source && 'list' in source && typeof (source as ToolCatalog).list === 'function' && !('getSkill' in source)
    ? source as ToolCatalog
    : registryCatalog(source as SkillRegistry);
}

/** Core API lines available with this catalog, in fixed order. */
function coreApiLines(catalog: ToolCatalog): string[] {
  const lines: string[] = [];
  let pendingHeader: string | null = null;
  for (const doc of CORE_API) {
    if (doc.api === null) {
      pendingHeader = doc.lines[0];
      continue;
    }
    if (!resolveApiTool(catalog, doc.api)) continue;
    if (pendingHeader) {
      lines.push(pendingHeader);
      pendingHeader = null;
    }
    lines.push(...doc.lines);
  }
  lines.push(...ALWAYS_API);
  return lines;
}

function skillLines(catalog: ToolCatalog, hidden: string[], detail: 'full' | 'params' | 'name'): string[] {
  const covered = coveredTools(catalog);
  const rest = catalog.list().filter(tool => !covered.has(tool.name) && !hidden.includes(tool.name));
  if (rest.length === 0) return [];
  const header = '// Every other tool: skills.<name>(args) → parsed result (throws on failure)';
  if (detail === 'name') return [header, rest.map(tool => propertyKey(tool.name)).join(', ')];
  return [header, ...rest.map(tool => skillSignature(tool, detail))];
}

const RULES = `## How to work in the kernel
- Assign read/search/fetch results to named variables, then print only the slice you need (\`print(src.slice(0, 800))\`, \`hits.length\`, \`hits.slice(0, 10)\`). Never print whole files or long lists.
- Build edit strings from slices you inspected: copy \`old\` exactly from a variable (e.g. a line from \`src.split('\\n')\`), never retype it from memory.
- Do many actions per cell: read several files, loop, filter, compute, write the results and check them in one cell (up to ~40 tool calls per cell is fine). Use Promise.all for independent reads.
- Use bash() to run programs (tests, builds, scripts, git). Do loops, parsing and math in JavaScript, not in shell pipelines.
- bash() returns a handle immediately. \`await h\` for short commands. For long ones (> a few minutes) start them, end your turn, and you will be woken by a \`[bash-done <id> exit=<code>]\` message. Never sleep or poll in a loop.
- Variables, functions and handles persist across cells and across context compaction. Reuse them instead of re-reading. Do not reuse API names (read, bash, search…) as variable names.
- A cell's output is its printed text, stderr, and the value of its last expression. Each is capped at 64k characters. Errors show \`<cell-N>:line\` positions.
- Tool failures throw: wrap them in try/catch when failure is expected, otherwise let the error show and fix the cause.
- Messages that start with \`[kind: …]\` or \`[bash-done …]\`/\`[kernel-state]\` come from the harness, not from the user.`;

export interface CodeModePromptOptions {
  /** Tool name the model calls (default `exec`). */
  toolName?: string;
  /** Tools never listed (the code tool itself is always hidden). */
  hiddenTools?: string[];
  maxChars?: number;
}

/**
 * System-prompt section for AGENT_MODE=code: the whole API as TypeScript
 * signatures with one-line meanings, plus Prime-style usage rules.
 */
export function buildCodeModePrompt(source: SkillRegistry | ToolCatalog, options: CodeModePromptOptions = {}): string {
  const catalog = asCatalog(source);
  const toolName = options.toolName ?? CODE_TOOL_NAME;
  const hidden = [CODE_TOOL_NAME, EXECUTE_CODE_TOOL_NAME, ...(options.hiddenTools ?? [])];
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const intro = `# Code mode
You act by calling the single tool \`${toolName}\` with JavaScript (Node.js). Each call runs one cell in your persistent kernel: top-level \`await\` works, and top-level variables, functions and classes stay defined in later cells. All tools are async functions in the kernel; call them from code, never as separate tool calls.`;
  const core = coreApiLines(catalog);
  for (const detail of ['full', 'params', 'name'] as const) {
    const api = [...core, ...skillLines(catalog, hidden, detail)];
    const text = `${intro}\n\n## Kernel API\n\`\`\`ts\n${api.join('\n')}\n\`\`\`\n\n${RULES}\n`;
    if (text.length <= maxChars || detail === 'name') return text;
  }
  return '';
}

/**
 * Tool description for the Hermes-style middle ground: normal tools stay,
 * and `execute_code` is added for multi-call work. The compact API lives in
 * the description so tool mode needs no system-prompt change.
 */
export function buildExecuteCodeDescription(source: SkillRegistry | ToolCatalog): string {
  const catalog = asCatalog(source);
  const hidden = [CODE_TOOL_NAME, EXECUTE_CODE_TOOL_NAME];
  const core = coreApiLines(catalog).filter(line => !line.startsWith('//'));
  const covered = coveredTools(catalog);
  const others = catalog.list()
    .filter(tool => !covered.has(tool.name) && !hidden.includes(tool.name))
    .map(tool => tool.name);
  return [
    'Run JavaScript (Node.js, top-level await) that calls tools as async functions, for multi-call work: loops over files, batch reads, filtering, computing, then writing results. Only what you print (console.log/print) and errors come back, so print just the slice you need. Variables persist between calls.',
    'API:',
    ...core,
    others.length ? `skills.<name>(args) for any other tool: ${others.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/** Line for the compaction summary prompt. */
export const CODE_MODE_COMPACTION_NOTE =
  'Kernel variables persist after this summary. Record the names of the variables worth reusing (and what they hold) in the summary instead of copying their contents.';
