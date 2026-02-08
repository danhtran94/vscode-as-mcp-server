# Installation Guide

## 1. Install the VSCode Extension

Install from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=acomagu.vscode-as-mcp-server).

Once installed, check the status bar (bottom-right) for the MCP server indicator.

## 2. Configure Your MCP Client

### Option A: Standalone Binary (Recommended)

Download the prebuilt binary from the releases page or [build it yourself](BUILD.md), then add to your MCP client config:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "/path/to/vscode-as-mcp-server"
    }
  }
}
```

### Option B: npx

No download needed — requires Node.js >= 18:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "npx",
      "args": ["vscode-as-mcp-server"]
    }
  }
}
```

### Custom Server URL

If the extension runs on a non-default port:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "/path/to/vscode-as-mcp-server",
      "args": ["--server-url", "http://localhost:12345"]
    }
  }
}
```

## 3. Verify

1. Open a project in VSCode.
2. Confirm the MCP server icon appears in the status bar.
3. Start a conversation in your MCP client (e.g. Claude Desktop) — it should have access to VSCode tools like `execute_command`, `text_editor`, `code_checker`, etc.

## Troubleshooting

- **Status bar shows nothing**: Click the status bar area and select "MCP Server: Start Server" from the command palette.
- **Relay can't connect**: Ensure VSCode is open and the extension is active. Default server URL is `http://localhost:60100`.
- **Tools not showing up**: Restart your MCP client. The relay caches the tool list and updates every 30 seconds.
