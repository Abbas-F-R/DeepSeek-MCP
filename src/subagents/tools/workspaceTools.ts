import fs from 'fs';
import path from 'path';
import { logger } from '../../logging/logger.js';
import { relativeToRoot, safeResolve } from '../../workspace/WorkspaceContext.js';
import {
  MAX_READ_BYTES,
  MAX_SEARCH_BYTES,
  isIgnored,
  isSecret,
  loadIgnoreRules,
  globToRegExp,
  secretRefusal,
} from './ignore.js';
import { claimFile, claimRefusal } from '../../orchestrator/claims.js';

export type SubagentToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'list_directory'
  | 'search_files'
  | 'spawn_agent';

/** What a running subagent asks for when it delegates part of its own work. */
export interface SpawnRequest {
  role?: string;
  task: string;
  context?: string;
  maxSteps?: number;
  allowedTools?: SubagentToolName[];
}

export interface SpawnOutcome {
  taskId: string;
  content: string;
  sessionId: string;
  tokens: number;
  touchedFiles: string[];
}

/**
 * Present only when a subagent is executing as part of a run.
 *
 * It is what turns a lone subagent into a node of a graph: it identifies the
 * task for file claims, and carries the callback that lets the task delegate.
 * A plain `agent` call has none of this and behaves exactly as before.
 */
export interface OrchestrationContext {
  runId: string;
  taskId: string;
  depth: number;
  allowSpawn: boolean;
  maxDepth: number;
  spawn: (request: SpawnRequest) => Promise<SpawnOutcome>;
}

/** Everything a workspace tool needs to stay inside the right project. */
export interface WorkspaceToolContext {
  root: string;
  /** Files written or edited during the run, relative to root. */
  touchedFiles: string[];
  orchestration?: OrchestrationContext;
}

export interface WorkspaceToolDefinition {
  name: SubagentToolName;
  description: string;
  parameters: any;
  execute: (args: any, ctx: WorkspaceToolContext) => Promise<string>;
}

const MAX_FILE_CHARS = 80_000;
const MAX_SEARCH_HITS = 60;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.mp4', '.mp3', '.woff', '.woff2', '.ttf', '.eot', '.class', '.dll', '.exe', '.so', '.dylib',
]);

function track(ctx: WorkspaceToolContext, filePath: string): void {
  const rel = relativeToRoot(ctx.root, filePath);
  if (!ctx.touchedFiles.includes(rel)) ctx.touchedFiles.push(rel);
}

/**
 * Resolve a caller-supplied path and refuse it if it names a credential file.
 *
 * Every tool goes through this, reads and writes alike: a subagent must not be
 * able to post your keys to a model provider, and it must not be able to
 * rewrite the file they live in either.
 */
/**
 * Accept the shorthands a model is likely to reach for.
 *
 * A bare extension (`.md`) is the form the previous suffix-matching filter took,
 * and models still write it; a bare name (`*.ts`) should match at any depth.
 * Anything containing a slash is treated as a real path glob and left alone.
 */
function normalizeGlob(glob: string): string {
  const pattern = glob.trim();
  if (pattern.includes('/')) return pattern;
  if (pattern.startsWith('.') && !pattern.includes('*')) return `**/*${pattern}`;
  return `**/${pattern}`;
}

function resolveSafePath(ctx: WorkspaceToolContext, target: string): { filePath: string; refusal?: string } {
  const filePath = safeResolve(ctx.root, target);
  const relative = relativeToRoot(ctx.root, filePath);
  if (isSecret(relative)) {
    logger.warn(`[WorkspaceTool] Refused credential path '${relative}'`);
    return { filePath, refusal: secretRefusal(relative) };
  }
  return { filePath };
}

/**
 * Take ownership of a file before changing it, when running inside a run.
 *
 * Parallel tasks writing the same file is the one way this plugin can silently
 * destroy work: the loser's edit vanishes with no error. Claiming turns that
 * into a refusal the model can read and route around.
 */
function claimGuard(ctx: WorkspaceToolContext, filePath: string): string | undefined {
  if (!ctx.orchestration) return undefined;
  const relative = relativeToRoot(ctx.root, filePath);
  const claim = claimFile(relative, { runId: ctx.orchestration.runId, taskId: ctx.orchestration.taskId });
  if (claim.ok) return undefined;
  logger.warn(`[WorkspaceTool] '${relative}' is claimed by ${claim.heldBy.taskId}`);
  return claimRefusal(relative, claim.heldBy);
}

/**
 * Write through a temporary file and rename over the target.
 *
 * `rename` is atomic within a filesystem, so a reader — including a parallel
 * subagent — sees either the old file or the new one, never a half-written
 * one, and a crash mid-write cannot truncate source code.
 */
function writeAtomic(filePath: string, content: string): void {
  const temp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(temp, content, 'utf-8');
    fs.renameSync(temp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
}

export const WORKSPACE_TOOLS: Record<SubagentToolName, WorkspaceToolDefinition> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a file, or a range of its lines. Path is relative to the project root. Output is line-numbered as "N| text" — the numbers are for citing file:line and must NOT be included when passing text to edit_file. Use offset and limit instead of reading a whole large file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        offset: { type: 'number', description: 'First line to return, 1-based. Defaults to the start of the file.' },
        limit: { type: 'number', description: 'How many lines to return from offset. Defaults to the whole file.' },
      },
      required: ['path'],
    },
    execute: async (args: { path: string; offset?: number; limit?: number }, ctx) => {
      try {
        const { filePath, refusal } = resolveSafePath(ctx, args.path);
        if (refusal) return refusal;
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return `Error: '${args.path}' is a directory. Use list_directory.`;

        // Checked before reading, not after: the old code pulled the whole file
        // into memory and only then truncated it.
        if (stat.size > MAX_READ_BYTES) {
          return (
            `Error: '${args.path}' is ${(stat.size / 1_000_000).toFixed(1)} MB, past the ${MAX_READ_BYTES / 1_000_000} MB read limit. ` +
            `Use search_files to find the part you need.`
          );
        }

        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const total = lines.length;

        const start = Math.max(1, Math.floor(args.offset ?? 1));
        if (start > total) {
          return `Error: '${args.path}' has ${total} lines; offset ${start} is past the end.`;
        }
        const count = args.limit && args.limit > 0 ? Math.floor(args.limit) : total - start + 1;
        const end = Math.min(total, start + count - 1);

        const width = String(end).length;
        const selected: string[] = [];
        let chars = 0;
        let stoppedAt = end;

        for (let i = start; i <= end; i++) {
          const rendered = `${String(i).padStart(width)}| ${lines[i - 1]}`;
          // Budget the slice as it is built, so a range of very long lines
          // cannot blow past the cap the way reading first and cutting after did.
          if (chars + rendered.length > MAX_FILE_CHARS) {
            stoppedAt = i - 1;
            break;
          }
          selected.push(rendered);
          chars += rendered.length + 1;
        }

        // Tell the agent exactly what it has, so it can ask for the next range
        // instead of guessing or re-reading the whole file.
        const header =
          stoppedAt < end
            ? `[${args.path} lines ${start}-${stoppedAt} of ${total} — stopped at the size cap]`
            : start === 1 && end === total
              ? `[${args.path}, ${total} lines]`
              : `[${args.path} lines ${start}-${end} of ${total}]`;

        logger.info(`[WorkspaceTool] read_file '${relativeToRoot(ctx.root, filePath)}' lines ${start}-${stoppedAt}/${total}`);
        return `${header}\n${selected.join('\n')}`;
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
        const { filePath, refusal } = resolveSafePath(ctx, args.path);
        if (refusal) return refusal;
        const claimed = claimGuard(ctx, filePath);
        if (claimed) return claimed;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const existed = fs.existsSync(filePath);
        writeAtomic(filePath, args.content);
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
    description:
      'Replace an exact text block in an existing file. Path is relative to the project root. The target must be the file\'s own text — strip the "N| " line-number prefix that read_file adds for display.',
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
        const { filePath, refusal } = resolveSafePath(ctx, args.path);
        if (refusal) return refusal;
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;
        const claimed = claimGuard(ctx, filePath);
        if (claimed) return claimed;

        const original = fs.readFileSync(filePath, 'utf-8');
        const occurrences = original.split(args.target).length - 1;
        if (occurrences === 0) return `Error: target text not found in '${args.path}'. Read the file first and match exactly.`;
        if (occurrences > 1) return `Error: target text appears ${occurrences} times in '${args.path}'. Include more surrounding context so it is unique.`;

        writeAtomic(filePath, original.replace(args.target, args.replacement));
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
        const { filePath, refusal } = resolveSafePath(ctx, args.path);
        if (refusal) return refusal;
        if (!fs.existsSync(filePath)) return `Error: file not found: '${args.path}'`;
        if (fs.statSync(filePath).isDirectory()) return `Error: '${args.path}' is a directory. Directory deletion is not permitted.`;
        const claimed = claimGuard(ctx, filePath);
        if (claimed) return claimed;
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
        recursive: { type: 'boolean', description: 'List nested files too (depth 3, ignored paths skipped)' },
      },
    },
    execute: async (args: { path?: string; recursive?: boolean }, ctx) => {
      try {
        const dirPath = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(dirPath)) return `Error: directory not found: '${args.path || '.'}'`;

        const rules = loadIgnoreRules(ctx.root);
        const lines: string[] = [];
        const walk = (dir: string, depth: number) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const relative = relativeToRoot(ctx.root, full);
            if (isIgnored(rules, relative, entry.isDirectory())) continue;
            // Credential files are not even listed: their names alone tell a
            // subagent what to go looking for.
            if (isSecret(relative)) continue;
            lines.push(`${entry.isDirectory() ? 'dir  ' : 'file '} ${relative}`);
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
        file_glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. "*.ts", "**/*.test.ts", "src/**". Scoping the search is much faster than filtering the results.',
        },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; path?: string; regex?: boolean; file_glob?: string }, ctx) => {
      try {
        const rootDir = safeResolve(ctx.root, args.path);
        if (!fs.existsSync(rootDir)) return `Error: directory not found: '${args.path || '.'}'`;

        // A real glob, not a suffix test: "**/*.test.ts" and "src/**" used to
        // match nothing, so agents had no way to narrow a search.
        let globRe: RegExp | undefined;
        if (args.file_glob) {
          try {
            globRe = globToRegExp(normalizeGlob(args.file_glob));
          } catch (err: any) {
            return `Error: invalid file_glob '${args.file_glob}': ${err.message}`;
          }
        }

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

        const rules = loadIgnoreRules(ctx.root);
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
            const full = path.join(dir, entry.name);
            const relative = relativeToRoot(ctx.root, full);
            // Dot-directories used to be skipped wholesale, which hid .github,
            // .claude and friends. Only the ignore rules decide now.
            if (isIgnored(rules, relative, entry.isDirectory()) || isSecret(relative)) continue;
            if (entry.isDirectory()) {
              walk(full);
              continue;
            }
            if (!entry.isFile()) continue;
            if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            if (globRe && !globRe.test(relative)) continue;

            // Grepping a huge file costs far more than any match it could return.
            try {
              if (fs.statSync(full).size > MAX_SEARCH_BYTES) continue;
            } catch {
              continue;
            }

            let content: string;
            try {
              content = fs.readFileSync(full, 'utf-8');
            } catch {
              continue;
            }

            // Walk the buffer by newline rather than splitting it. Splitting
            // allocated an array of every line in every candidate file, which
            // is pure garbage on a repo-wide search that matches almost nothing.
            let lineNumber = 1;
            let from = 0;
            while (from <= content.length && hits.length < MAX_SEARCH_HITS) {
              let to = content.indexOf('\n', from);
              if (to === -1) to = content.length;
              const line = content.slice(from, to);
              if (matcher(line)) {
                hits.push(`${relative}:${lineNumber}: ${line.trim().slice(0, 200)}`);
              }
              from = to + 1;
              lineNumber++;
              if (to === content.length) break;
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

  spawn_agent: {
    name: 'spawn_agent',
    description:
      'Delegate one self-contained piece of your task to another subagent and wait for its answer. Use it when a step needs different permissions than you hold (a read-only role needing code written) or when it is large enough to be worth its own context. Only the delegate\'s final answer comes back to you, not its file reads. Give it everything it needs in one shot — it cannot ask you questions. Roles: explore, scout, general, coder, security, sql.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete, self-contained task for the delegate' },
        role: {
          type: 'string',
          enum: ['explore', 'scout', 'general', 'coder', 'security', 'sql'],
          description: 'Which kind of subagent to delegate to (default: general)',
        },
        context: { type: 'string', description: 'Facts the delegate needs that are not on disk' },
        max_steps: { type: 'number', description: 'Tool round trips the delegate may take (default 8)' },
      },
      required: ['task'],
    },
    execute: async (args: { task: string; role?: string; context?: string; max_steps?: number }, ctx) => {
      const orchestration = ctx.orchestration;
      if (!orchestration) {
        return 'Error: delegation is only available to a task running inside an orchestrated run.';
      }
      if (!orchestration.allowSpawn) {
        return (
          `Error: this task may not delegate. ` +
          (orchestration.depth >= orchestration.maxDepth
            ? `Delegation depth ${orchestration.maxDepth} is already reached.`
            : `Its plan entry did not set allowSpawn.`) +
          ` Do the work yourself, or report what still needs doing.`
        );
      }
      if (!args.task || !args.task.trim()) return 'Error: "task" is required — say exactly what the delegate must do.';

      try {
        const outcome = await orchestration.spawn({
          role: args.role,
          task: args.task,
          context: args.context,
          maxSteps: args.max_steps,
        });
        // Its touched files are reported back so the parent knows what changed
        // underneath it without having to go looking.
        const files = outcome.touchedFiles.length ? `\nfiles: ${outcome.touchedFiles.join(', ')}` : '';
        return `[${outcome.taskId} · ${args.role || 'general'} · ${outcome.tokens} tok]${files}\n${outcome.content}`;
      } catch (err: any) {
        return `Error: delegation failed: ${err.message}. Continue without it, and say in your answer what could not be delegated.`;
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
