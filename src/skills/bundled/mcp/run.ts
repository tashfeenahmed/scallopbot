/**
 * MCP Skill Handler
 *
 * Invokes MCP (Model Context Protocol) tool servers via CLI bridge.
 * Reads server configuration from ~/.smartbot/mcp.json.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadMCPConfig, type MCPServerConfig } from '../../../config/mcp-config.js';

const execFileAsync = promisify(execFile);

interface MCPSkillInput {
  action: 'list' | 'call';
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

interface MCPSkillResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Main handler for MCP skill invocations.
 */
export async function handler(context: {
  args: Record<string, unknown>;
  workspace: string;
  sessionId: string;
  userId?: string;
}): Promise<MCPSkillResult> {
  const input = context.args as unknown as MCPSkillInput;

  if (input.action === 'list') {
    return listServers();
  }

  if (input.action === 'call') {
    if (!input.server || !input.tool) {
      return { success: false, error: 'Both "server" and "tool" are required for "call" action.' };
    }
    return callTool(input.server, input.tool, input.args || {});
  }

  return { success: false, error: `Unknown action: ${input.action}. Use "list" or "call".` };
}

/**
 * List all configured MCP servers.
 */
async function listServers(): Promise<MCPSkillResult> {
  try {
    const servers = loadMCPConfig();
    if (servers.length === 0) {
      return {
        success: true,
        output: 'No MCP servers configured. Create ~/.smartbot/mcp.json to add servers.\n\nExample:\n{\n  "servers": [\n    {\n      "name": "filesystem",\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n    }\n  ]\n}',
      };
    }

    const lines = servers.map(s => `- **${s.name}**: \`${s.command} ${(s.args || []).join(' ')}\``);
    return {
      success: true,
      output: `Configured MCP servers:\n${lines.join('\n')}`,
    };
  } catch (error) {
    return { success: false, error: `Failed to load MCP config: ${(error as Error).message}` };
  }
}

/**
 * Call a tool on an MCP server via subprocess.
 */
async function callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<MCPSkillResult> {
  try {
    const servers = loadMCPConfig();
    const server = servers.find(s => s.name === serverName);
    if (!server) {
      const available = servers.map(s => s.name).join(', ') || '(none)';
      return { success: false, error: `MCP server "${serverName}" not found. Available: ${available}` };
    }

    // Build the MCP tool call via the server command
    // We pass the tool name and arguments as JSON via stdin
    const toolCallPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });

    const env = { ...process.env, ...(server.env || {}) };
    const cmdArgs = [...(server.args || [])];

    const { stdout, stderr } = await execFileAsync(server.command, cmdArgs, {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    });

    if (stderr && !stdout) {
      return { success: false, error: stderr.slice(0, 2000) };
    }

    return {
      success: true,
      output: stdout.slice(0, 10000) || '(no output)',
    };
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errMsg = err.stderr?.slice(0, 1000) || err.message;
    return { success: false, error: `MCP call failed: ${errMsg}` };
  }
}
