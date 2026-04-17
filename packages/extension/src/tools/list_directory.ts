import * as ignore from 'ignore';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';

// Zod schema definition
export const listDirectorySchema = z.object({
  path: z.string().describe('Directory path to list'),
  depth: z.number().int().min(1).optional().describe('Maximum depth for traversal (default: unlimited)'),
  include_hidden: z.boolean().optional().describe('Include hidden files/directories (default: false)'),
});

type ListDirectoryParams = z.infer<typeof listDirectorySchema>;

interface ListDirectoryResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown; // Index signature required by the MCP Server callback contract
}

interface TreeNode {
  name: string;
  isDirectory: boolean;
  children: TreeNode[];
}

/**
 * Tool that renders a directory tree.
 * Respects .gitignore patterns when listing the target directory.
 */
export async function listDirectoryTool(params: ListDirectoryParams): Promise<ListDirectoryResult> {
  try {
    const resolvedPath = resolvePath(params.path);
    const uri = vscode.Uri.file(resolvedPath);

    try {
      const stats = await vscode.workspace.fs.stat(uri);
      if (!(stats.type & vscode.FileType.Directory)) {
        return {
          content: [{ type: 'text', text: `${resolvedPath} is not a directory` }],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: 'Directory is empty or does not exist' }],
        isError: true,
      };
    }

    // Load .gitignore patterns
    const ignorePatterns = await loadGitignorePatterns(resolvedPath);
    const ig = ignore.default().add(ignorePatterns);

    // Build the directory tree
    const tree = await buildDirectoryTree(
      resolvedPath,
      path.basename(resolvedPath),
      1,
      params.depth || Number.MAX_SAFE_INTEGER,
      params.include_hidden || false,
      ig
    );

    // Render the tree as display text
    const treeText = generateTreeText(tree);

    return {
      content: [{ type: 'text', text: treeText }],
      isError: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `Failed to list directory: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Resolve a directory path.
 * @param dirPath Path to resolve (absolute or workspace-relative).
 * @returns Absolute path.
 */
function resolvePath(dirPath: string): string {
  if (path.isAbsolute(dirPath)) {
    return dirPath;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    return path.join(workspaceRoot, dirPath);
  }

  return path.resolve(dirPath);
}

/**
 * Load .gitignore patterns from the directory and its ancestors.
 * @param dirPath Directory path to start from.
 * @returns Collected array of gitignore patterns.
 */
async function loadGitignorePatterns(dirPath: string): Promise<string[]> {
  const patterns: string[] = [];

  try {
    // Walk up from the given directory looking for .gitignore files
    let currentDir = dirPath;

    while (currentDir) {
      const gitignorePath = path.join(currentDir, '.gitignore');
      const uri = vscode.Uri.file(gitignorePath);

      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(content).toString('utf-8').split('\n');

        const validPatterns = lines.filter(line => {
          const trimmed = line.trim();
          return trimmed && !trimmed.startsWith('#');
        });

        patterns.push(...validPatterns);
      } catch {
        // .gitignore doesn't exist at this level — ignore
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return patterns;
  } catch (error) {
    console.error('Error loading .gitignore patterns:', error);
    return [];
  }
}

/**
 * Build a directory tree.
 * @param fullPath Absolute path of the directory to scan.
 * @param nodeName Name used for the current tree node.
 * @param currentDepth Current recursion depth.
 * @param maxDepth Maximum recursion depth.
 * @param includeHidden Whether to include dotfiles.
 * @param ignorer Gitignore pattern checker.
 * @returns Root tree node for the scanned directory.
 */
async function buildDirectoryTree(
  fullPath: string,
  nodeName: string,
  currentDepth: number,
  maxDepth: number,
  includeHidden: boolean,
  ignorer: ignore.Ignore
): Promise<TreeNode> {
  const uri = vscode.Uri.file(fullPath);
  const root: TreeNode = {
    name: nodeName,
    isDirectory: true,
    children: [],
  };

  if (currentDepth > maxDepth) {
    return root;
  }

  try {
    // Read directory entries
    const entries = await vscode.workspace.fs.readDirectory(uri);

    // Sort by name, directories first
    const sortedEntries = entries.sort((a, b) => {
      const aIsDir = !!(a[1] & vscode.FileType.Directory);
      const bIsDir = !!(b[1] & vscode.FileType.Directory);

      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;

      return a[0].localeCompare(b[0]);
    });

    for (const [name, type] of sortedEntries) {
      // Skip hidden files unless explicitly requested
      if (!includeHidden && name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(fullPath, name);
      const relativePath = path.relative(path.dirname(fullPath), entryPath);

      // Skip entries matched by .gitignore patterns
      if (ignorer.ignores(relativePath)) {
        continue;
      }

      const isDirectory = !!(type & vscode.FileType.Directory);

      if (isDirectory) {
        // Recurse into subdirectory
        const childNode = await buildDirectoryTree(
          entryPath,
          name,
          currentDepth + 1,
          maxDepth,
          includeHidden,
          ignorer
        );
        root.children.push(childNode);
      } else {
        // Append leaf file node
        root.children.push({
          name,
          isDirectory: false,
          children: [],
        });
      }
    }

    return root;
  } catch (error) {
    console.error(`Error reading directory ${fullPath}:`, error);
    return root;
  }
}

/**
 * Render a tree node as indented text.
 * @param node Current tree node.
 * @param prefix Line prefix accumulated from parent frames.
 * @param isLast Whether this node is the last child of its parent.
 * @returns Rendered tree text.
 */
function generateTreeText(node: TreeNode, prefix = '', isLast = true): string {
  let result = prefix;

  if (prefix !== '') {
    result += isLast ? '└── ' : '├── ';
  }

  result += `${node.name}${node.isDirectory ? '/' : ''}\n`;

  if (node.children.length > 0) {
    const newPrefix = prefix + (isLast ? '    ' : '│   ');

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLastChild = i === node.children.length - 1;
      result += generateTreeText(child, newPrefix, isLastChild);
    }
  }

  return result;
}
