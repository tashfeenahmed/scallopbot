/**
 * MCP Server Configuration
 *
 * Loads MCP server definitions from ~/.smartbot/mcp.json. A server is either
 * local stdio (`command`) or remote (`url` + `transport` "http" | "sse").
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type MCPRemoteTransport = 'http' | 'sse';

export interface MCPServerConfig {
  name: string;
  /** Local stdio server executable. Exactly one of `command` or `url` is required. */
  command?: string;     // e.g., "/opt/mcp/bin/server"
  /** Remote server endpoint (Streamable HTTP endpoint, or legacy SSE stream URL). */
  url?: string;
  /** Remote transport: "http" (Streamable HTTP, default) or legacy "sse". */
  transport?: MCPRemoteTransport;
  /**
   * Extra HTTP headers for remote servers. Values may reference environment
   * variables as `${MCP_NAME}`; resolved values are redacted from all output.
   */
  headers?: Record<string, string>;
  /** Shorthand for `Authorization: Bearer <token>`; may also use `${MCP_NAME}`. */
  bearerToken?: string;
  args?: string[];      // e.g., ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env?: Record<string, string>;
  description?: string;
  /** Per-request startup/call timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Exact tools the model may call. Use ["*"] only for deliberate full access. */
  allowedTools?: string[];
}

interface MCPConfigFile {
  servers: MCPServerConfig[];
}

const CONFIG_PATH = path.join(os.homedir(), '.smartbot', 'mcp.json');
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVERS = 64;
const MAX_COMMAND_CHARS = 4_096;
const MAX_ARGS = 128;
const MAX_ARG_CHARS = 8_192;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_CHARS = 16_384;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_ALLOWED_TOOLS = 256;
const MAX_URL_CHARS = 2_048;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE_CHARS = 8_192;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
// Hop-by-hop / framing headers the client controls itself.
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
]);

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Remote MCP endpoints must be https, except loopback/private-network hosts
 * where plain http is common (a server on the same Pi or LAN).
 */
export function isAllowedMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS || /[\0\s]/.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackOrPrivateHost(parsed.hostname);
}

function isHeaderValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_HEADER_VALUE_CHARS && !/[\0\r\n]/.test(value);
}
const MAX_TOOL_NAME_CHARS = 256;
const MIN_TIMEOUT_MS = 1_000;
// Keep the inner MCP timeout below the outer skill-executor default so the
// wrapper normally gets a chance to tear down its process group cleanly.
const MAX_TIMEOUT_MS = 60_000;

function isAllowedToolName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_TOOL_NAME_CHARS &&
    !/[\0\r\n]/.test(value);
}

function isValidServer(value: unknown, names: Set<string>): value is MCPServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  if (typeof server.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(server.name)) return false;
  if (names.has(server.name)) return false;
  const hasCommand = server.command !== undefined;
  const hasUrl = server.url !== undefined;
  if (hasCommand === hasUrl) return false; // exactly one transport family
  if (hasCommand && (
    typeof server.command !== 'string' ||
    !server.command.trim() ||
    server.command.length > MAX_COMMAND_CHARS ||
    server.command.includes('\0')
  )) return false;
  if (hasUrl && !isAllowedMcpUrl(server.url)) return false;
  if (!hasUrl && (
    server.transport !== undefined || server.headers !== undefined || server.bearerToken !== undefined
  )) return false;
  if (hasUrl && (server.args !== undefined || server.env !== undefined)) return false;
  if (server.transport !== undefined && server.transport !== 'http' && server.transport !== 'sse') return false;
  if (server.headers !== undefined && (
    !server.headers || typeof server.headers !== 'object' || Array.isArray(server.headers) ||
    Object.keys(server.headers).length > MAX_HEADERS ||
    !Object.entries(server.headers).every(([key, headerValue]) =>
      HEADER_NAME_RE.test(key) && !RESERVED_HEADERS.has(key.toLowerCase()) && isHeaderValue(headerValue))
  )) return false;
  if (server.bearerToken !== undefined && (!isHeaderValue(server.bearerToken) || !server.bearerToken)) return false;
  if (
    server.bearerToken !== undefined && server.headers &&
    Object.keys(server.headers).some(key => key.toLowerCase() === 'authorization')
  ) return false;
  if (server.args !== undefined && (
    !Array.isArray(server.args) ||
    server.args.length > MAX_ARGS ||
    !server.args.every(arg =>
      typeof arg === 'string' && arg.length <= MAX_ARG_CHARS && !arg.includes('\0'))
  )) return false;
  if (server.env !== undefined && (
    !server.env || typeof server.env !== 'object' || Array.isArray(server.env) ||
    Object.keys(server.env).length > MAX_ENV_VARS ||
    !Object.entries(server.env).every(([key, envValue]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      typeof envValue === 'string' &&
      envValue.length <= MAX_ENV_VALUE_CHARS &&
      !envValue.includes('\0'))
  )) return false;
  if (
    server.description !== undefined &&
    (typeof server.description !== 'string' || server.description.length > MAX_DESCRIPTION_CHARS)
  ) return false;
  if (server.timeoutMs !== undefined && (
    !Number.isInteger(server.timeoutMs) ||
    (server.timeoutMs as number) < MIN_TIMEOUT_MS ||
    (server.timeoutMs as number) > MAX_TIMEOUT_MS
  )) return false;
  if (server.allowedTools !== undefined && (
    !Array.isArray(server.allowedTools) ||
    server.allowedTools.length > MAX_ALLOWED_TOOLS ||
    !server.allowedTools.every(isAllowedToolName) ||
    new Set(server.allowedTools).size !== server.allowedTools.length ||
    (server.allowedTools.includes('*') && server.allowedTools.length !== 1)
  )) return false;
  names.add(server.name);
  return true;
}

function validateServers(servers: unknown): MCPServerConfig[] | null {
  if (!Array.isArray(servers) || servers.length > MAX_SERVERS) return null;
  const names = new Set<string>();
  const valid: MCPServerConfig[] = [];
  for (const server of servers) {
    if (!isValidServer(server, names)) return null;
    valid.push(server);
  }
  return valid;
}

/**
 * Load MCP server configurations from ~/.smartbot/mcp.json.
 * Returns an empty array if the file doesn't exist or is invalid.
 */
export function loadMCPConfig(configPath?: string): MCPServerConfig[] {
  const filePath = configPath || CONFIG_PATH;

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const fileStat = fs.statSync(filePath);
    if (fileStat.size > MAX_CONFIG_BYTES || !fileStat.isFile()) return [];
    if (process.platform !== 'win32') {
      // MCP configs contain executable commands and often credentials. Refuse
      // group/world-accessible files instead of silently running them.
      if ((fileStat.mode & 0o077) !== 0) return [];
      if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) return [];
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const config: MCPConfigFile = JSON.parse(raw);

    return validateServers(config.servers) ?? [];
  } catch {
    return [];
  }
}

/**
 * Save MCP server configurations to ~/.smartbot/mcp.json.
 */
export function saveMCPConfig(servers: MCPServerConfig[], configPath?: string): void {
  const filePath = configPath || CONFIG_PATH;
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const validated = validateServers(servers);
  if (!validated) throw new Error('Invalid MCP server configuration');
  const config: MCPConfigFile = { servers: validated };
  const serialized = JSON.stringify(config, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error(`MCP configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  fs.writeFileSync(filePath, serialized, { encoding: 'utf-8', mode: 0o600 });
  // writeFile preserves an existing file's mode, so enforce owner-only access
  // after every update as well as at creation time.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some platforms/filesystems do not implement POSIX modes.
  }
}

/**
 * Check if any MCP servers are configured.
 */
export function hasMCPConfig(configPath?: string): boolean {
  return loadMCPConfig(configPath).length > 0;
}

const ENV_REFERENCE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve the outbound HTTP headers for a remote MCP server. `${NAME}` inside
 * a header value (or `bearerToken`) is replaced with that environment
 * variable; an unset/empty reference fails closed. Error messages name the
 * variable, never a value.
 */
export function resolveMcpHeaders(
  server: MCPServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolve = (raw: string, label: string): string =>
    raw.replace(ENV_REFERENCE_RE, (_match, name: string) => {
      const value = env[name];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`MCP server "${server.name}" ${label} references unset environment variable ${name}`);
      }
      if (/[\0\r\n]/.test(value)) {
        throw new Error(`MCP server "${server.name}" ${label} environment variable ${name} contains invalid characters`);
      }
      return value;
    });
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    headers[key] = resolve(value, `header ${key}`);
  }
  if (server.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${resolve(server.bearerToken, 'bearerToken')}`;
  }
  return headers;
}
