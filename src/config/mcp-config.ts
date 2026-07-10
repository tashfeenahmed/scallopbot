/**
 * MCP Server Configuration
 *
 * Loads MCP server definitions from ~/.smartbot/mcp.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface MCPServerConfig {
  name: string;
  command: string;      // e.g., "npx"
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
  if (
    typeof server.command !== 'string' ||
    !server.command.trim() ||
    server.command.length > MAX_COMMAND_CHARS ||
    server.command.includes('\0')
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
