import fs from 'fs';
import path from 'path';
import { logger } from '../../logging/logger.js';
import { relativeToRoot, safeResolve } from '../../workspace/WorkspaceContext.js';

export type SubagentToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'list_directory'
  | 'search_files';

/** Everything a workspace tool needs to stay inside the right project. */
export interface WorkspaceToolContext {
  root: string;
  /** Files written or edited during the run, relative to root. */
  touchedFiles: string[];
}

export interface WorkspaceToolDefinition {
  name: SubagentToolName;
  description: string;
  parameters: any;
  execute: (args: any, ctx: WorkspaceToolContext) => Promise<string>;
}

const MAX_FILE_CHARS = 80_000;
const MAX_SEARCH_HITS = 60;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', 'vendor', 'target', '__pycache__', 'bin', 'obj']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.mp4', '.mp3', '.woff', '.woff2', '.ttf', '.eot', '.class', '.dll', '.exe', '.so', '.dylib',
]);

function track(ctx: WorkspaceToolContext, filePath: string): void {
  const rel = relativeToRoot(ctx.root, filePath);
  if (!ctx.touchedFiles.includes(rel)) ctx.touchedFiles.push(rel);
}

export const WORKSPACE_TOOLS: Record<SubagentToolName, WorkspaceToolDefinition> = {
  read_file: {
    name: 'read_file',
    description: 'Read a file. Path is relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
      },
      required: ['path'],
    },
    execute: async (args: { path: string }, ctx) => {
      try {
        const filePath = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;
        if (fs.statSync(filePath).isDirectory()) return `Error: '${args.path}' is a directory. Use list_directory.`;

        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > MAX_FILE_CHARS) {
          content = `${content.slice(0, MAX_FILE_CHARS)}\n\n...[truncated at ${MAX_FILE_CHARS} chars]`;
        }
        logger.info(`[WorkspaceTool] read_file '${relativeToRoot(ctx.root, filePath)}' (${content.length} chars)`);
        return content;
      } catch (err: any) {
        return `Error reading '${args.path}': ${err.message}`;
      }
    },
  },

  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file. Path is relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    execute: async (args: { path: string; content: string }, ctx) => {
      try {
        const filePath = safeResolve(ctx.root, args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const existed = fs.existsSync(filePath);
        fs.writeFileSync(filePath, args.content, 'utf-8');
        track(ctx, filePath);
        logger.info(`[WorkspaceTool] write_file '${relativeToRoot(ctx.root, filePath)}' (${args.content.length} bytes)`);
        return `${existed ? 'Overwrote' : 'Created'} '${relativeToRoot(ctx.root, filePath)}' (${args.content.length} bytes)`;
      } catch (err: any) {
        return `Error writing '${args.path}': ${err.message}`;
      }
    },
  },

  edit_file: {
    name: 'edit_file',
    description: 'Replace an exact text block in an existing file. Path is relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        target: { type: 'string', description: 'Exact text to find' },
        replacement: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'target', 'replacement'],
    },
    execute: async (args: { path: string; target: string; replacement: string }, ctx) => {
      try {
        const filePath = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;

        const original = fs.readFileSync(filePath, 'utf-8');
        const occurrences = original.split(args.target).length - 1;
        if (occurrences === 0) return `Error: target text not found in '${args.path}'. Read the file first and match exactly.`;
        if (occurrences > 1) return `Error: target text appears ${occurrences} times in '${args.path}'. Include more surrounding context so it is unique.`;

        fs.writeFileSync(filePath, original.replace(args.target, args.replacement), 'utf-8');
        track(ctx, filePath);
        logger.info(`[WorkspaceTool] edit_file '${relativeToRoot(ctx.root, filePath)}'`);
        return `Updated '${relativeToRoot(ctx.root, filePath)}'`;
      } catch (err: any) {
        return `Error editing '${args.path}': ${err.message}`;
      }
    },
  },

  delete_file: {
    name: 'delete_file',
    description: 'Delete a file inside the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
      },
      required: ['path'],
    },
    execute: async (args: { path: string }, ctx) => {
      try {
        const filePath = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;
        if (fs.statSync(filePath).isDirectory()) return `Error: '${args.path}' is a directory. Directory deletion is not permitted.`;
        fs.unlinkSync(filePath);
        track(ctx, filePath);
        logger.info(`[WorkspaceTool] delete_file '${relativeToRoot(ctx.root, filePath)}'`);
        return `Deleted '${relativeToRoot(ctx.root, filePath)}'`;
      } catch (err: any) {
        return `Error deleting '${args.path}': ${err.message}`;
      }
    },
  },

  list_directory: {
    name: 'list_directory',
    description: 'List entries of a directory inside the project root. Default is the root itself.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the project root (default ".")' },
        recursive: { type: 'boolean', description: 'List nested files too (depth 3, build dirs skipped)' },
      },
    },
    execute: async (args: { path?: string; recursive?: boolean }, ctx) => {
      try {
        const dirPath = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(dirPath)) return `Error: directory not found: '${args.path || '.'}'`;

        const lines: string[] = [];
        const walk = (dir: string, depth: number) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            lines.push(`${entry.isDirectory() ? 'dir  ' : 'file '} ${relativeToRoot(ctx.root, full)}`);
            if (entry.isDirectory() && args.recursive && depth < 3) walk(full, depth + 1);
          }
        };
        walk(dirPath, 1);

        logger.info(`[WorkspaceTool] list_directory '${relativeToRoot(ctx.root, dirPath)}' (${lines.length} entries)`);
        return lines.length ? lines.join('\n') : `(empty directory '${args.path || '.'}')`;
      } catch (err: any) {
        return `Error listing '${args.path || '.'}': ${err.message}`;
      }
    },
  },

  search_files: {
    name: 'search_files',
    description: 'Search file contents for a string or regex inside the project root. Returns path:line matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find' },
        path: { type: 'string', description: 'Directory to search, relative to the project root (default ".")' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression' },
        file_glob: { type: 'string', description: 'Only search files whose name ends with this suffix (e.g. ".ts")' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; path?: string; regex?: boolean; file_glob?: string }, ctx) => {
      try {
        const rootDir = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(rootDir)) return `Error: directory not found: '${args.path || '.'}'`;

        let matcher: (line: string) => boolean;
        if (args.regex) {
          let re: RegExp;
          try {
            re = new RegExp(args.query, 'i');
          } catch (err: any) {
            return `Error: invalid regular expression '${args.query}': ${err.message}`;
          }
          matcher = (line) => re.test(line);
        } else {
          const needle = args.query.toLowerCase();
          matcher = (line) => line.toLowerCase().includes(needle);
        }

        const hits: string[] = [];
        const walk = (dir: string) => {
          if (hits.length >= MAX_SEARCH_HITS) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (hits.length >= MAX_SEARCH_HITS) return;
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
              continue;
            }
            if (!entry.isFile()) continue;
            if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            if (args.file_glob && !entry.name.endsWith(args.file_glob.replace(/^\*/, ''))) continue;

            let content: string;
            try {
              content = fs.readFileSync(full, 'utf-8');
            } catch {
              continue;
            }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
              if (matcher(lines[i])) {
                hits.push(`${relativeToRoot(ctx.root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              }
            }
          }
        };
        walk(rootDir);

        logger.info(`[WorkspaceTool] search_files '${args.query}' -> ${hits.length} hits`);
        if (hits.length === 0) return `No matches for '${args.query}'`;
        const capped = hits.length >= MAX_SEARCH_HITS ? `\n...[capped at ${MAX_SEARCH_HITS} matches]` : '';
        return `${hits.join('\n')}${capped}`;
      } catch (err: any) {
        return `Error searching: ${err.message}`;
      }
    },
  },
};

export function getOpenAIToolSchemas(allowedToolNames: SubagentToolName[]): any[] {
  return allowedToolNames
    .filter((name) => WORKSPACE_TOOLS[name])
    .map((name) => {
      const tool = WORKSPACE_TOOLS[name];
      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      };
    });
}
