import { z } from 'zod';
import { EditorManager, TextEditorResult } from './text_editor';

export const writeFileSchema = z.object({
  command: z.enum(['str_replace', 'create', 'insert']),
  path: z.string().describe('File path to operate on'),
  old_str: z.string().optional()
    .describe('Text to replace (required for str_replace command)'),
  new_str: z.string().optional()
    .describe('New text to insert (required for str_replace and insert commands)'),
  file_text: z.string().optional()
    .describe('Content for new file (required for create command)'),
  insert_line: z.number().optional()
    .describe('Line number to insert after (required for insert command)'),
  skip_dialog: z.boolean().optional()
    .describe('Skip confirmation dialog (for testing only)'),
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
