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
}

interface MCPConfigFile {
  servers: MCPServerConfig[];
}

const CONFIG_PATH = path.join(os.homedir(), '.smartbot', 'mcp.json');

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

    const raw = fs.readFileSync(filePath, 'utf-8');
    const config: MCPConfigFile = JSON.parse(raw);

    if (!config.servers || !Array.isArray(config.servers)) {
      return [];
    }

    // Validate each server entry
    return config.servers.filter(s =>
      typeof s.name === 'string' && s.name.length > 0 &&
      typeof s.command === 'string' && s.command.length > 0
    );
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

  const config: MCPConfigFile = { servers };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Check if any MCP servers are configured.
 */
export function hasMCPConfig(configPath?: string): boolean {
  return loadMCPConfig(configPath).length > 0;
}
