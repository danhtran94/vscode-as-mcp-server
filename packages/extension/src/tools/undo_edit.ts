import { z } from 'zod';
import { EditorManager, TextEditorResult } from './text_editor';

export const undoEditSchema = z.object({});

export async function undoEditTool(): Promise<TextEditorResult> {
  console.log('undoEditTool: Starting');
  const editor = EditorManager.getInstance();
  return await editor.undoEdit();
}
