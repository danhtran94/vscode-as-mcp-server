import { z } from 'zod';
import { EditorManager, TextEditorResult } from './text_editor';

export const writeFileSchema = z.object({
  command: z.enum(['str_replace', 'create', 'insert'], {
    required_error: 'command is required. Pick one of: "str_replace" (replace text), "create" (new file), "insert" (insert at line).',
  }),
  path: z.string({
    required_error: 'path is required. Pass the absolute path to the file you want to modify (e.g., "/Users/you/project/src/foo.ts"). Workspace-root-relative paths are also accepted. Never omit this — there is no implicit "current file".',
  }).min(1, 'path must not be empty.')
    .describe('REQUIRED absolute path (or workspace-relative path) to the file being modified. There is no implicit current file — always pass this.'),
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

type WriteFileParams = z.infer<typeof writeFileSchema>;

export async function writeFileTool(params: WriteFileParams): Promise<TextEditorResult> {
  console.log('writeFileTool: Starting with params:', params);
  const editor = EditorManager.getInstance();

  switch (params.command) {
    case 'str_replace': {
      if (!params.old_str || !params.new_str) {
        return {
          content: [{ type: 'text', text: 'old_str and new_str parameters are required' }],
          isError: true,
        };
      }
      return await editor.replaceText(params.path, params.old_str, params.new_str, params.skip_dialog);
    }
    case 'create': {
      if (!params.file_text) {
        return {
          content: [{ type: 'text', text: 'file_text parameter is required' }],
          isError: true,
        };
      }
      return await editor.createFile(params.path, params.file_text, params.skip_dialog);
    }
    case 'insert': {
      if (params.insert_line === undefined || !params.new_str) {
        return {
          content: [{ type: 'text', text: 'insert_line and new_str parameters are required' }],
          isError: true,
        };
      }
      return await editor.insertText(params.path, params.insert_line, params.new_str, params.skip_dialog);
    }
    default:
      return {
        content: [{ type: 'text', text: 'Invalid write command' }],
        isError: true,
      };
  }
}
