import { z } from 'zod';
import { EditorManager, TextEditorResult } from './text_editor';

export const readFileSchema = z.object({
  path: z.string({
    required_error: 'path is required. Pass the absolute path to the file you want to read (e.g., "/Users/you/project/src/foo.ts"). Workspace-root-relative paths are also accepted. Never omit this — there is no implicit "current file".',
  }).min(1, 'path must not be empty.')
    .describe('REQUIRED absolute path (or workspace-relative path) to the file to read. There is no implicit current file — always pass this.'),
  view_range: z.array(z.number()).length(2).optional()
    .describe('Optional [startLine, endLine] (1-indexed; use -1 for endLine to read through end of file).'),
});

type ReadFileParams = z.infer<typeof readFileSchema>;

export async function readFileTool(params: ReadFileParams): Promise<TextEditorResult> {
  console.log('readFileTool: Starting with params:', params);
  const editor = EditorManager.getInstance();
  const viewRange = params.view_range ? [params.view_range[0], params.view_range[1]] as [number, number] : undefined;
  return await editor.viewFile(params.path, viewRange);
}
