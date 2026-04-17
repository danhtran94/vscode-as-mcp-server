import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { DiffViewProvider } from '../utils/DiffViewProvider';
import { ConfirmationUI } from '../utils/confirmation_ui';

// Zod schema definition
export const textEditorSchema = z.object({
  command: z.enum(['view', 'str_replace', 'create', 'insert', 'undo_edit'], {
    required_error: 'command is required. Pick one of: "view", "str_replace", "create", "insert", "undo_edit".',
  }),
  path: z.string({
    required_error: 'path is required. Pass the absolute path to the target file (e.g., "/Users/you/project/src/foo.ts"). Workspace-root-relative paths are also accepted. Never omit this — there is no implicit "current file".',
  }).min(1, 'path must not be empty.')
    .describe('REQUIRED absolute path (or workspace-relative path) to the target file. There is no implicit current file — always pass this.'),
  view_range: z.array(z.number()).length(2).optional()
    .describe('For command="view": optional [startLine, endLine] (1-indexed; use -1 for endLine to read through end of file).'),
  old_str: z.string().optional()
    .describe('Text to replace (REQUIRED when command="str_replace"). Must match exactly, including whitespace.'),
  new_str: z.string().optional()
    .describe('New text (REQUIRED when command="str_replace" or command="insert").'),
  file_text: z.string().optional()
    .describe('Full file content (REQUIRED when command="create").'),
  insert_line: z.number().optional()
    .describe('0-indexed line number to insert AFTER (REQUIRED when command="insert").'),
  skip_dialog: z.boolean().optional()
    .describe('Skip the confirmation dialog. For tests only — do not set this in normal tool calls.'),
});

type TextEditorParams = z.infer<typeof textEditorSchema>;

export interface TextEditorResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

// Manages backups and diff-view presentation
export class EditorManager {
  private static instance: EditorManager;
  private diffViewProvider: DiffViewProvider;

  private constructor() {
    console.log('EditorManager: Initializing...');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    this.diffViewProvider = new DiffViewProvider(workspaceRoot);
  }

  static getInstance(): EditorManager {
    if (!EditorManager.instance) {
      EditorManager.instance = new EditorManager();
    }
    return EditorManager.instance;
  }

  // Resolve a path (absolute or workspace-relative)
  private resolvePath(filePath: string): string {
    console.log('EditorManager: Resolving path:', filePath);
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      return path.join(workspaceRoot, filePath);
    }

    return path.resolve(filePath);
  }

  // Get the file URI
  private getFileUri(filePath: string): vscode.Uri {
    const resolvedPath = this.resolvePath(filePath);
    console.log('EditorManager: Getting file URI:', resolvedPath);
    return vscode.Uri.file(resolvedPath);
  }

  // Show the confirmation prompt
  private async showPersistentConfirmation(message: string, approveLabel: string, denyLabel: string): Promise<{ approved: boolean; feedback?: string }> {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        throw new Error('No active text editor');
      }

      console.log(`[EditorManager] Using ConfirmationUI for confirmation`);

      // Delegate to ConfirmationUI for the actual prompt.
      // kind: 'edit' allows mcpServer.autoAcceptEdits to short-circuit this prompt.
      const result = await ConfirmationUI.confirm(message, "", approveLabel, denyLabel, 'edit');
      if (result === "Approve") {
        return { approved: true };
      } else {
        // Anything other than literal "Deny" is treated as free-text user feedback
        return { approved: false, feedback: result !== "Deny" ? result : undefined };
      }
    } catch (error) {
      console.error('Error showing confirmation:', error);
      return { approved: false };
    }
  }

  // Ensure the parent directory exists
  private async ensureParentDirectory(filePath: string): Promise<void> {
    console.log('EditorManager: Ensuring parent directory exists:', filePath);
    const uri = this.getFileUri(filePath);
    const parentDir = path.dirname(uri.fsPath);
    const parentUri = vscode.Uri.file(parentDir);

    try {
      await vscode.workspace.fs.stat(parentUri);
    } catch {
      // Parent directory doesn't exist — create it
      console.log('EditorManager: Creating parent directory:', parentDir);
      await vscode.workspace.fs.createDirectory(parentUri);
    }
  }

  async viewFile(filePath: string, viewRange?: [number, number]): Promise<TextEditorResult> {
    console.log('EditorManager: Viewing file:', filePath);
    try {
      const uri = this.getFileUri(filePath);

      try {
        const stat = await vscode.workspace.fs.stat(uri);

        // Check if the path is a directory
        if (stat.type === vscode.FileType.Directory) {
          console.log('EditorManager: Path is a directory, listing contents:', uri.fsPath);

          try {
            const entries = await vscode.workspace.fs.readDirectory(uri);

            // Sort entries: directories first, then files, both alphabetically
            entries.sort((a, b) => {
              const aIsDir = a[1] & vscode.FileType.Directory;
              const bIsDir = b[1] & vscode.FileType.Directory;

              if (aIsDir && !bIsDir) return -1;
              if (!aIsDir && bIsDir) return 1;
              return a[0].localeCompare(b[0]);
            });

            // Format the directory listing
            const lines = [`Directory listing for: ${uri.fsPath}`, ''];

            for (const [name, type] of entries) {
              const isDir = type & vscode.FileType.Directory;
              const isSymlink = type & vscode.FileType.SymbolicLink;

              let prefix = '';
              let suffix = '';

              if (isDir) {
                prefix = 'd ';
                suffix = '/';
              } else if (isSymlink) {
                prefix = 'l ';
                suffix = '@';
              } else {
                prefix = '- ';
              }

              lines.push(`${prefix}${name}${suffix}`);
            }

            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              isError: false,
            };
          } catch (dirError) {
            const errorMessage = dirError instanceof Error ? dirError.message : 'Unknown directory reading error occurred';
            return {
              content: [{ type: 'text', text: `Error reading directory: ${errorMessage}` }],
              isError: true,
            };
          }
        }
      } catch {
        return {
          content: [{ type: 'text', text: `File does not exist at path: ${uri.fsPath}` }],
          isError: true,
        };
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      let content: string;

      if (viewRange) {
        const [start, end] = viewRange;
        const startLine = Math.max(0, start - 1); // 1-indexed to 0-indexed
        const endLine = end === -1 ? doc.lineCount : end;
        const range = new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, 0)
        );
        content = doc.getText(range);
      } else {
        content = doc.getText();
      }

      return {
        content: [{ type: 'text', text: content }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: 'text', text: `Error reading file: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  async replaceText(filePath: string, oldStr: string, newStr: string, skipDialog?: boolean): Promise<TextEditorResult> {
    console.log('EditorManager: Replacing text in file:', filePath);
    try {
      const uri = this.getFileUri(filePath);

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return {
          content: [{ type: 'text', text: `File does not exist at path: ${uri.fsPath}` }],
          isError: true,
        };
      }

      // Perform the replacement
      console.log('EditorManager: Reading file content');
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      if (!content.includes(oldStr)) {
        return {
          content: [{ type: 'text', text: `Text to replace '${oldStr}' not found in the file` }],
          isError: true,
        };
      }
      const newContent = content.replaceAll(oldStr, newStr);
      console.log('EditorManager: Text replacement - Old:', oldStr, 'New:', newStr);

      console.log('EditorManager: Content length - Original:', content.length, 'New:', newContent.length);

      // IMPORTANT: set editType BEFORE calling open()
      this.diffViewProvider.editType = 'modify';

      // Open the file via DiffViewProvider
      console.log('EditorManager: Opening file in DiffViewProvider');
      if (!this.diffViewProvider.isEditing) {
        await this.diffViewProvider.open(uri.fsPath);
      }

      // Apply the change
      console.log('EditorManager: Updating content in DiffViewProvider');
      await this.diffViewProvider.update(newContent, true);
      await this.diffViewProvider.scrollToFirstDiff();

      // Skip the confirmation dialog during tests
      console.log('EditorManager: Checking approval');
      let confirmResult;
      if (skipDialog) {
        confirmResult = { approved: true };
      } else {
        confirmResult = await this.showPersistentConfirmation(
          'Do you want to apply these changes?',
          'Apply Changes',
          'Discard Changes'
        );
      }

      if (!confirmResult.approved) {
        console.log('EditorManager: Changes rejected');
        await this.diffViewProvider.revertChanges();

        // Include the user's feedback in the rejection message if provided
        const feedbackMessage = confirmResult.feedback
          ? `Changes were rejected by the user with feedback: ${confirmResult.feedback}`
          : 'Changes were rejected by the user';

        return {
          content: [{ type: 'text', text: feedbackMessage }],
          isError: true
        };
      }

      console.log('EditorManager: Saving changes');
      const { newProblemsMessage, userEdits, userFeedback } = await this.diffViewProvider.saveChanges();

      // Format the response content to include feedback when present
      const feedbackText = userFeedback ? `\nUser feedback: ${userFeedback}` : '';

      if (userEdits) {
        return {
          content: [{
            type: 'text',
            text: `User modified the changes. Please review the updated content.${newProblemsMessage || ''}${feedbackText}`
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Text replacement completed successfully${newProblemsMessage || ''}${feedbackText}`
        }],
      };
    } catch (error) {
      console.error('EditorManager: Error in replaceText:', error);
      await this.diffViewProvider.revertChanges();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: 'text', text: `Error replacing text: ${errorMessage}` }],
        isError: true,
      };
    } finally {
      await this.diffViewProvider.reset();
    }
  }

  async createFile(filePath: string, fileText: string, skipDialog?: boolean): Promise<TextEditorResult> {
    console.log('EditorManager: Creating file:', filePath);
    try {
      const uri = this.getFileUri(filePath);

      try {
        await vscode.workspace.fs.stat(uri);
        return {
          content: [{ type: 'text', text: 'File already exists' }],
          isError: true,
        };
      } catch {
        // File doesn't exist — continue with creation
      }

      // Create the parent directory if needed
      console.log('EditorManager: Creating parent directory');
      await this.ensureParentDirectory(filePath);

      // IMPORTANT: set editType BEFORE calling open()
      this.diffViewProvider.editType = 'create';

      console.log('EditorManager: Opening file in DiffViewProvider');
      if (!this.diffViewProvider.isEditing) {
        await this.diffViewProvider.open(uri.fsPath);
      }

      console.log('EditorManager: Updating content in DiffViewProvider');
      console.log('EditorManager: File text length:', fileText.length);
      await this.diffViewProvider.update(fileText, true);
      await this.diffViewProvider.scrollToFirstDiff();

      // Skip the confirmation dialog during tests
      console.log('EditorManager: Checking approval');
      let confirmResult;
      if (skipDialog) {
        confirmResult = { approved: true };
      } else {
        confirmResult = await this.showPersistentConfirmation(
          'Do you want to create this file?',
          'Apply Changes',
          'Discard Changes'
        );
      }

      if (!confirmResult.approved) {
        console.log('EditorManager: File creation cancelled');
        await this.diffViewProvider.revertChanges();

        // Include the user's feedback in the rejection message if provided
        const feedbackMessage = confirmResult.feedback
          ? `File creation was cancelled by the user with feedback: ${confirmResult.feedback}`
          : 'File creation was cancelled by the user';

        return {
          content: [{ type: 'text', text: feedbackMessage }],
          isError: true,
        };
      }

      console.log('EditorManager: Saving changes');
      const { newProblemsMessage, userEdits, userFeedback } = await this.diffViewProvider.saveChanges();

      // Format the response content to include feedback when present
      const feedbackText = userFeedback ? `\nUser feedback: ${userFeedback}` : '';

      if (userEdits) {
        return {
          content: [{
            type: 'text',
            text: `User modified the new file content. Please review the changes.${newProblemsMessage || ''}${feedbackText}`
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `File created successfully${newProblemsMessage || ''}${feedbackText}`
        }],
      };
    } catch (error) {
      console.error('EditorManager: Error in createFile:', error);
      await this.diffViewProvider.revertChanges();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: 'text', text: `Error creating file: ${errorMessage}` }],
        isError: true,
      };
    } finally {
      await this.diffViewProvider.reset();
    }
  }

  async insertText(filePath: string, insertLine: number, newStr: string, skipDialog?: boolean): Promise<TextEditorResult> {
    console.log('EditorManager: Inserting text in file:', filePath);
    try {
      const uri = this.getFileUri(filePath);

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return {
          content: [{ type: 'text', text: `File does not exist at path: ${uri.fsPath}` }],
          isError: true,
        };
      }

      // IMPORTANT: set editType BEFORE calling open()
      this.diffViewProvider.editType = 'modify';

      console.log('EditorManager: Opening file in DiffViewProvider');
      if (!this.diffViewProvider.isEditing) {
        await this.diffViewProvider.open(uri.fsPath);
      }

      console.log('EditorManager: Reading file content');
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      const lines = content.split('\n');
      const lineIndex = Math.max(0, insertLine); // 0-based index
      lines.splice(lineIndex, 0, newStr);
      const newContent = lines.join('\n');

      console.log('EditorManager: Updating content in DiffViewProvider');
      console.log('EditorManager: Content length - Original:', content.length, 'New:', newContent.length);
      await this.diffViewProvider.update(newContent, true);
      await this.diffViewProvider.scrollToFirstDiff();

      // Skip the confirmation dialog during tests
      console.log('EditorManager: Checking approval');
      let confirmResult;
      if (skipDialog) {
        confirmResult = { approved: true };
      } else {
        confirmResult = await this.showPersistentConfirmation(
          'Do you want to insert this text?',
          'Apply Changes',
          'Discard Changes'
        );
      }

      if (!confirmResult.approved) {
        console.log('EditorManager: Text insertion cancelled');
        await this.diffViewProvider.revertChanges();

        // Include the user's feedback in the rejection message if provided
        const feedbackMessage = confirmResult.feedback
          ? `Text insertion was cancelled by the user with feedback: ${confirmResult.feedback}`
          : 'Text insertion was cancelled by the user';

        return {
          content: [{ type: 'text', text: feedbackMessage }],
          isError: true,
        };
      }

      console.log('EditorManager: Saving changes');
      const { newProblemsMessage, userEdits, userFeedback } = await this.diffViewProvider.saveChanges();

      // Format the response content to include feedback when present
      const feedbackText = userFeedback ? `\nUser feedback: ${userFeedback}` : '';

      if (userEdits) {
        return {
          content: [{
            type: 'text',
            text: `User modified the inserted content. Please review the changes.${newProblemsMessage || ''}${feedbackText}`
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Text insertion completed successfully${newProblemsMessage || ''}${feedbackText}`
        }],
      };
    } catch (error) {
      console.error('EditorManager: Error in insertText:', error);
      await this.diffViewProvider.revertChanges();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: 'text', text: `Error inserting text: ${errorMessage}` }],
        isError: true,
      };
    } finally {
      await this.diffViewProvider.reset();
    }
  }

  async undoEdit(): Promise<TextEditorResult> {
    console.log('EditorManager: Undoing edit');
    try {
      if (!this.diffViewProvider.isEditing) {
        return {
          content: [{ type: 'text', text: 'No active edit session to undo' }],
          isError: true,
        };
      }

      await this.diffViewProvider.revertChanges();
      return {
        content: [{ type: 'text', text: 'Undo completed successfully' }],
      };
    } catch (error) {
      console.error('EditorManager: Error in undoEdit:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: 'text', text: `Error undoing changes: ${errorMessage}` }],
        isError: true,
      };
    } finally {
      await this.diffViewProvider.reset();
    }
  }
}

// Main tool handler — a thin dispatcher kept for backward compatibility
export async function textEditorTool(params: TextEditorParams): Promise<TextEditorResult> {
  console.log('textEditorTool: Starting with params:', params);

  switch (params.command) {
    case 'view': {
      const { readFileTool } = await import('./read_file');
      const viewRange = params.view_range ? [params.view_range[0], params.view_range[1]] as [number, number] : undefined;
      return await readFileTool({ path: params.path, view_range: viewRange });
    }
    case 'str_replace':
    case 'create':
    case 'insert': {
      const { writeFileTool } = await import('./write_file');
      return await writeFileTool({
        command: params.command,
        path: params.path,
        old_str: params.old_str,
        new_str: params.new_str,
        file_text: params.file_text,
        insert_line: params.insert_line,
        skip_dialog: params.skip_dialog,
      });
    }
    case 'undo_edit': {
      const { undoEditTool } = await import('./undo_edit');
      return await undoEditTool();
    }
    default:
      return {
        content: [{ type: 'text', text: 'Invalid command' }],
        isError: true,
      };
  }
}
