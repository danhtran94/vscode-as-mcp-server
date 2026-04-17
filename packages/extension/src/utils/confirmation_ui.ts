import * as vscode from 'vscode';
import { StatusBarManager } from './StatusBarManager';

/**
 * Utility class that shows a confirmation UI based on user settings.
 */
export class ConfirmationUI {
  // Singleton StatusBarManager instance
  private static statusBarManager: StatusBarManager | null = null;

  /**
   * Get or lazily initialize the StatusBarManager instance.
   */
  private static getStatusBarManager(): StatusBarManager {
    if (!this.statusBarManager) {
      this.statusBarManager = new StatusBarManager();
    }
    return this.statusBarManager;
  }

  /**
   * Show a pre-execution confirmation UI driven by user settings.
   * @param message Confirmation message.
   * @param detail Extra detail (e.g., the command being confirmed).
   * @param approveLabel Label for the approve button.
   * @param denyLabel Label for the deny button.
   * @param kind Origin of the confirmation — `"edit"` calls are eligible for auto-accept when the user has toggled
   *             `mcpServer.autoAcceptEdits`. `"shell"` (default) always prompts. Unspecified = `"shell"` to keep
   *             existing call sites fail-closed.
   * @returns `"Approve"` when approved; `"Deny"` or a free-text reason when denied.
   */
  static async confirm(
    message: string,
    detail: string,
    approveLabel: string,
    denyLabel: string,
    kind: 'edit' | 'shell' = 'shell'
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('mcpServer');

    // Edit-origin confirmations short-circuit when the user has enabled auto-accept-edits mode.
    if (kind === 'edit' && config.get<boolean>('autoAcceptEdits', false)) {
      console.log('[ConfirmationUI] Auto-accepting edit (mcpServer.autoAcceptEdits is on)');
      return 'Approve';
    }

    // Pick confirmation UI style from settings
    const confirmationUI = config.get<string>('confirmationUI', 'quickPick');

    console.log(`[ConfirmationUI] Using ${confirmationUI} UI for confirmation`);

    if (confirmationUI === 'quickPick') {
      return await this.showQuickPickConfirmation(message, detail, approveLabel, denyLabel);
    } else {
      return await this.showStatusBarConfirmation(message, detail, approveLabel, denyLabel);
    }
  }

  /**
   * Show a QuickPick-based confirmation UI.
   */
  private static async showQuickPickConfirmation(
    message: string,
    detail: string,
    approveLabel: string,
    denyLabel: string
  ): Promise<string> {
    // Create the QuickPick
    const quickPick = vscode.window.createQuickPick();

    quickPick.title = message;
    quickPick.placeholder = detail || '';

    quickPick.items = [
      { label: `$(check) Approve`, description: approveLabel },
      { label: `$(x) Deny`, description: denyLabel }
    ];
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = true;

    return new Promise<string>(async (resolve) => {
      quickPick.onDidAccept(async () => {
        const selection = quickPick.selectedItems[0];
        quickPick.hide();

        if (selection.label.includes("Approve")) {
          resolve("Approve");
        } else {
          // Show QuickInput for feedback if denied
          const inputBox = vscode.window.createInputBox();
          inputBox.title = "Feedback";
          inputBox.placeholder = "Add context for the agent (optional)";

          inputBox.onDidAccept(() => {
            const feedback = inputBox.value.trim();
            inputBox.hide();
            resolve(feedback || "Deny");
          });

          inputBox.onDidHide(() => {
            if (inputBox.value.trim() === "") {
              resolve("Deny");
            }
          });

          inputBox.show();
        }
      });

      quickPick.onDidHide(() => {
        // Handle dismissal of the QuickPick
        if (!quickPick.selectedItems || quickPick.selectedItems.length === 0) {
          resolve("Deny");
        }
      });

      quickPick.show();
    });
  }

  /**
   * Show a status-bar-based confirmation UI.
   */
  private static async showStatusBarConfirmation(
    message: string,
    detail: string,
    approveLabel: string,
    denyLabel: string
  ): Promise<string> {
    // Show the message to the user
    vscode.window.showInformationMessage(`${message} ${detail ? `- ${detail}` : ''}`);

    // Grab the StatusBarManager instance
    try {
      const statusBarManager = this.getStatusBarManager();

      // Use the StatusBarManager to wait for the user's choice
      console.log('[ConfirmationUI] Using StatusBarManager for confirmation');
      const approved = await statusBarManager.ask(approveLabel, denyLabel);
      statusBarManager.hide();

      // Return "Approve" if approved
      if (approved) {
        return "Approve";
      }

      // On denial, collect optional free-text feedback
      const inputBox = vscode.window.createInputBox();
      inputBox.title = "Feedback";
      inputBox.placeholder = "Add context for the agent (optional)";

      return new Promise<string>((resolve) => {
        inputBox.onDidAccept(() => {
          const feedback = inputBox.value.trim();
          inputBox.hide();
          resolve(feedback || "Deny");
        });

        inputBox.onDidHide(() => {
          if (inputBox.value.trim() === "") {
            resolve("Deny");
          }
        });

        inputBox.show();
      });
    } catch (error) {
      console.error('Error using StatusBarManager:', error);
      // Fall back to QuickPick on error
      console.log('[ConfirmationUI] Falling back to QuickPick confirmation');
      return await this.showQuickPickConfirmation(message, detail, approveLabel, denyLabel);
    }
  }
}
