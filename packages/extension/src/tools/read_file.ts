import { z } from 'zod';
import { EditorManager, TextEditorResult } from './text_editor';

export const readFileSchema = z.object({
  path: z.string().describe('File path to read'),
  view_range: z.array(z.number()).length(2).optional()
    .describe('Optional [start, end] line numbers (1-indexed, -1 for end)'),
});

type ReadFileParams = z.infer<typeof readFileSchema>;

export async function readFileTool(params: ReadFileParams): Promise<TextEditorResult> {
  console.log('readFileTool: Starting with params:', params);
  const editor = EditorManager.getInstance();
  const viewRange = params.view_range ? [params.view_range[0], params.view_range[1]] as [number, number] : undefined;
  return await editor.viewFile(params.path, viewRange);
}
