import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as vscode from 'vscode';

export interface ServerState {
  value: boolean;
}

import { BidiHttpTransport } from './bidi-http-transport';

export function registerVSCodeCommands(
  context: vscode.ExtensionContext,
  mcpServer: McpServer,
  outputChannel: vscode.OutputChannel,
  startServer: (port: number) => Promise<void>,
  transport?: BidiHttpTransport
) {
  // Register text editor action commands
  context.subscriptions.push(
    vscode.commands.registerCommand('textEditor.applyChanges', () => {
      vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      return true;
    }),
    vscode.commands.registerCommand('textEditor.cancelChanges', () => {
      vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      return false;
    })
  );
  // COMMAND PALETTE COMMAND: Stop the MCP Server
  context.subscriptions.push(
    vscode.commands.registerCommand('mcpServer.stopServer', () => {
      try {
        mcpServer.close();
        outputChannel.appendLine('MCP Server stopped.');
      } catch (err) {
        vscode.window.showWarningMessage('MCP Server is not running.');
        outputChannel.appendLine('Attempted to stop the MCP Server, but it is not running.');
        return;
      }
      mcpServer.close();
    }),
  );

  // COMMAND PALETTE COMMAND: Start the MCP Server
  context.subscriptions.push(
    vscode.commands.registerCommand('mcpServer.startServer', async () => {
      try {
        const port = vscode.workspace.getConfiguration('mcpServer').get<number>('port', 60100);
        await startServer(port);
        outputChannel.appendLine(`MCP Server started on port ${port}.`);
        vscode.window.showInformationMessage(`MCP Server started on port ${port}.`);
      } catch (err) {
        outputChannel.appendLine(`Failed to start MCP Server: ${err}`);
        vscode.window.showErrorMessage(`Failed to start MCP Server: ${err}`);
      }
    }),
  );

  // Request handover
  context.subscriptions.push(
    vscode.commands.registerCommand('mcpServer.toggleActiveStatus', async () => {
      if (!transport) {
        vscode.window.showWarningMessage('MCP Server is not running.');
        return;
      }

      try {
        const success = await transport.requestHandover();
        if (success) {
          outputChannel.appendLine('Handover request successful');
        } else {
          vscode.window.showErrorMessage('Failed to complete handover request.');
        }
      } catch (err) {
        outputChannel.appendLine(`Error requesting handover: ${err}`);
        vscode.window.showErrorMessage(`Failed to complete handover request: ${err}`);
      }
    })
  );

  // Toggle auto-accept-edits mode.
  // Flips the mcpServer.autoAcceptEdits setting (Global scope) so the choice persists across windows.
  context.subscriptions.push(
    vscode.commands.registerCommand('mcpServer.toggleAutoAcceptEdits', async () => {
      const config = vscode.workspace.getConfiguration('mcpServer');
      const current = config.get<boolean>('autoAcceptEdits', false);
      const next = !current;
      await config.update('autoAcceptEdits', next, vscode.ConfigurationTarget.Global);
      outputChannel.appendLine(`Auto-accept edits: ${next ? 'ON' : 'OFF'}`);
      vscode.window.showInformationMessage(
        next
          ? 'Auto-accept edits is ON — file-edit tools will apply changes without confirmation.'
          : 'Auto-accept edits is OFF — file-edit tools will prompt before applying changes.'
      );
    })
  );
}
