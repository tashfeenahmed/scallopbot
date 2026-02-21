---
name: mcp
description: "Access MCP (Model Context Protocol) tool servers. Use mcp to list available servers and tools, or invoke MCP tools by server and tool name."
user-invocable: false
disable-model-invocation: false
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [list, call]
      description: "Action to perform: 'list' to list available MCP servers/tools, 'call' to invoke a tool"
    server:
      type: string
      description: "MCP server name (required for 'call' action)"
    tool:
      type: string
      description: "Tool name to invoke (required for 'call' action)"
    args:
      type: object
      description: "Arguments to pass to the MCP tool (for 'call' action)"
  required: [action]
metadata:
  openclaw:
    emoji: "\U0001F50C"
    requires:
      bins: [npx]
---

# MCP (Model Context Protocol) Support

Access external MCP tool servers configured in `~/.smartbot/mcp.json`.

## Configuration

Create `~/.smartbot/mcp.json` with your MCP server definitions:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  ]
}
```

## Usage

```
# List available MCP servers and tools
mcp(action: "list")

# Call a specific tool
mcp(action: "call", server: "filesystem", tool: "read_file", args: { path: "/etc/hosts" })
```
