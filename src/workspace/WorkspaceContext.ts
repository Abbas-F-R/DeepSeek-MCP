import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';

/**
 * Every request that touches the filesystem must be bound to an explicit
 * project root. The backend is spawned once per project, but a tool call may
 * still name a different one, so `process.cwd()` alone is never a safe answer.
 */
export interface WorkspaceRef {
  /** Absolute, real (symlink-resolved) project root */
  root: string;
  /** Stable short identifier derived from the root path */
  slug: string;
  /** Directory name of the root */
  name: string;
}

/**
 * Global (per-machine) state directory, used only for the cross-project index.
 * DEEPSEEK_MCP_STATE_DIR redirects it — tests rely on that to stay out of $HOME.
 */
export const GLOBAL_STATE_DIR = process.env.DEEPSEEK_MCP_STATE_DIR
  ? path.resolve(process.env.DEEPSEEK_MCP_STATE_DIR)
  : path.join(os.homedir(), '.deepseek-mcp');

/** Per-project state directory name, created inside the project root. */
export const PROJECT_STATE_DIRNAME = '.agent';

const ROOT_MARKERS = ['.git', 'package.json', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', '.sln'];
const MAX_WALK_UP = 8;

const workspaceCache = new Map<string, WorkspaceRef>();

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Walk up from `start` looking for a project-root marker. Used only when the
 * root was inferred (cwd), never when the caller passed one explicitly —
 * an explicit root is always taken literally.
 */
function walkUpToProjectRoot(start: string): string {
  let current = start;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    for (const marker of ROOT_MARKERS) {
      if (marker === '.sln') {
        try {
          if (fs.readdirSync(current).some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) return current;
        } catch {
          /* unreadable directory — keep walking */
        }
        continue;
      }
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

export function slugForRoot(root: string): string {
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 6);
  const base = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'workspace';
  return `${base}-${hash}`;
}

/**
 * Resolve the project root for a call.
 *
 * Precedence: explicit argument > PROJECT_ROOT env > MCP_WORKSPACE_ROOT env > cwd.
 * The inferred (cwd) case additionally walks up to the nearest project marker.
 */
export function resolveWorkspace(explicitRoot?: string): WorkspaceRef {
  const explicit = explicitRoot?.trim();
  let root: string;

  if (explicit) {
    const expanded = explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : explicit;
    root = path.resolve(expanded);
    if (!isDirectory(root)) {
      throw new Error(
        `Workspace root '${explicit}' does not exist or is not a directory. Pass an absolute path to an existing project directory.`
      );
    }
  } else {
    const envRoot = process.env.PROJECT_ROOT || process.env.MCP_WORKSPACE_ROOT || process.env.CLAUDE_PROJECT_DIR || process.env.WORKSPACE_ROOT;
    const base = envRoot && isDirectory(path.resolve(envRoot)) ? path.resolve(envRoot) : process.cwd();
    root = envRoot ? base : walkUpToProjectRoot(base);
  }

  root = realpath(root);

  const cached = workspaceCache.get(root);
  if (cached) return cached;

  const ref: WorkspaceRef = { root, slug: slugForRoot(root), name: path.basename(root) };
  workspaceCache.set(root, ref);
  logger.info(`[Workspace] Bound request to root '${root}' (slug: ${ref.slug})`);
  return ref;
}

/** Absolute path of the per-project state directory. */
export function projectStateDir(root: string): string {
  return path.join(root, PROJECT_STATE_DIRNAME);
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Resolve a caller-supplied path against the workspace root and refuse
 * anything that escapes it. Relative paths are joined to the root — they are
 * NOT resolved against process.cwd(), which is the whole point.
 *
 * Set ALLOW_OUTSIDE_WORKSPACE=1 to disable the containment check.
 */
export function safeResolve(root: string, target: string | undefined): string {
  const raw = (target ?? '.').trim() || '.';
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);

  if (process.env.ALLOW_OUTSIDE_WORKSPACE === '1') return resolved;

  const normalizedRoot = root.endsWith(path.sep) ? root.slice(0, -1) : root;
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    // Compare real paths too, so a symlinked root still matches.
    const realResolved = realpath(path.dirname(resolved)) + path.sep + path.basename(resolved);
    if (realResolved !== normalizedRoot && !realResolved.startsWith(normalizedRoot + path.sep)) {
      throw new Error(
        `Path '${raw}' resolves outside the workspace root '${normalizedRoot}'. Workspace tools may only touch files inside the bound project.`
      );
    }
  }
  return resolved;
}

/** Path relative to the workspace root, for compact reporting. */
export function relativeToRoot(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel === '' ? '.' : rel;
}
