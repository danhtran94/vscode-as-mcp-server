import * as vscode from 'vscode';
import { BidiHttpTransport } from './bidi-http-transport';
import { registerVSCodeCommands } from './commands';
import { createMcpServer, extensionDisplayName } from './mcp-server';
import { DIFF_VIEW_URI_SCHEME } from './utils/DiffViewProvider';

// Status bar item that displays the MCP Server status
let serverStatusBarItem: vscode.StatusBarItem;
let transport: BidiHttpTransport;

// Update the status bar to reflect the current server status.
// The auto-accept-edits mode is surfaced as an inline suffix ("· ⚡ auto-accept") so the user
// has a constant visual reminder that edit confirmations are being skipped.
function updateServerStatusBar(status: 'running' | 'stopped' | 'starting' | 'tool_list_updated') {
  if (!serverStatusBarItem) {
    return;
  }

  switch (status) {
    case 'running':
      serverStatusBarItem.text = '$(server) MCP Server';
      serverStatusBarItem.tooltip = 'MCP Server is running';
      serverStatusBarItem.command = 'mcpServer.stopServer';
      break;
    case 'starting':
      serverStatusBarItem.text = '$(sync~spin) MCP Server';
      serverStatusBarItem.tooltip = 'Starting...';
      serverStatusBarItem.command = undefined;
      break;
    case 'tool_list_updated':
      serverStatusBarItem.text = '$(warning) MCP Server';
      serverStatusBarItem.tooltip = 'Tool list updated - Restart MCP Client';
      serverStatusBarItem.command = 'mcpServer.stopServer';
      break;
    case 'stopped':
    default:
      serverStatusBarItem.text = '$(circle-slash) MCP Server';
      serverStatusBarItem.tooltip = 'MCP Server is not running';
      serverStatusBarItem.command = 'mcpServer.toggleActiveStatus';
      break;
  }

  // Append the auto-accept indicator after the base state text/tooltip.
  const autoAccept = vscode.workspace.getConfiguration('mcpServer').get<boolean>('autoAcceptEdits', false);
  if (autoAccept) {
    serverStatusBarItem.text += ' $(zap) auto-accept';
    serverStatusBarItem.tooltip = `${serverStatusBarItem.tooltip ?? ''}\nAuto-accept edits: ON — file-edit tools apply without confirmation. Run "MCP Server: Toggle Auto-Accept Edits" to disable.`;
    serverStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    serverStatusBarItem.backgroundColor = undefined;
  }

  serverStatusBarItem.show();
}

export const activate = async (context: vscode.ExtensionContext) => {
  console.log('LMLMLM', vscode.lm.tools);

  // Create the output channel for logging
  const outputChannel = vscode.window.createOutputChannel(extensionDisplayName);
  outputChannel.appendLine(`Activating ${extensionDisplayName}...`);

  // Initialize the MCP server instance
  const mcpServer = createMcpServer(outputChannel);

  // Create status bar item
  serverStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(serverStatusBarItem);

  // Server start function
  async function startServer(port: number) {
    outputChannel.appendLine(`DEBUG: Starting MCP Server on port ${port}...`);
    transport = new BidiHttpTransport(port, outputChannel);
    // Wire up the server status-change event handler
    transport.onServerStatusChanged = (status) => {
      updateServerStatusBar(status);
    };

    await mcpServer.connect(transport); // connect calls transport.start().
    updateServerStatusBar(transport.serverStatus);
  }

  // Register Diff View Provider for file comparison functionality
  const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return Buffer.from(uri.query, "base64").toString("utf-8");
    }
  })();

  // Register the DiffViewProvider under the mcp-diff URI scheme
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
  );

  // Start server if configured to do so
  const mcpConfig = vscode.workspace.getConfiguration('mcpServer');
  const port = mcpConfig.get<number>('port', 60100);
  try {
    await startServer(port);
    outputChannel.appendLine(`MCP Server started on port ${port}.`);
  } catch (err) {
    outputChannel.appendLine(`Failed to start MCP Server: ${err}`);
  }

  // Register VSCode commands
  registerVSCodeCommands(context, mcpServer, outputChannel, startServer, transport);

  // Re-render the status bar whenever the user flips mcpServer.autoAcceptEdits so the
  // inline indicator stays in sync with the setting without waiting for a server status change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mcpServer.autoAcceptEdits')) {
        updateServerStatusBar(transport?.serverStatus ?? 'stopped');
      }
    })
  );

  outputChannel.appendLine(`${extensionDisplayName} activated.`);
};

export function deactivate() {
  // Clean-up is managed by the disposables added in the activate method.
}
