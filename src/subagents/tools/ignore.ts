import fs from 'fs';
import path from 'path';
import { logger } from '../../logging/logger.js';

/**
 * What a subagent is allowed to look at.
 *
 * Two separate questions, deliberately not merged:
 *
 *   - Is it a *secret*? Then no tool may touch it, ever, and no configuration
 *     can permit it. Anything a subagent reads is sent verbatim to a model API,
 *     so reading `.env` means posting your keys to a third party.
 *   - Is it *noise*? Build output, dependencies, caches. Skipped by the tools
 *     that walk the tree, and configurable per project, because one repo's
 *     noise is another's source.
 */

/** Files whose contents are credentials. Never readable, never writable. */
const SECRET_PATTERNS: RegExp[] = [
  // .env and its variants, but not the committed templates.
  /(^|\/)\.env(\.[^/]*)?$/,
  // Private keys and certificates.
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  // Package-registry and network credentials.
  /(^|\/)\.(npmrc|pypirc|netrc|htpasswd|git-credentials)$/,
  // Cloud and service credentials.
  /(^|\/)(credentials|service-account.*\.json|gha-creds-.*\.json)$/i,
  /(^|\/)\.(aws|ssh|gnupg)(\/|$)/,
  // Conventional secret files.
  /(^|\/)secrets?\.(ya?ml|json|toml|ini)$/i,
  /\.secrets?$/i,
  // Terraform state embeds provider credentials in plain text.
  /(^|\/)terraform\.tfstate(\.backup)?$/,
];

/** Templates that share a secret file's name but hold no secret. */
const SECRET_EXCEPTIONS: RegExp[] = [
  /(^|\/)\.env\.(example|sample|template|dist|schema)$/i,
  /\.pub$/,
];

/** Directories that are output or dependencies in essentially every project. */
export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.tox',
  '.gradle',
  '.terraform',
  'Pods',
  'DerivedData',
  '.idea',
  '.agent',
]);

/** Files too large to be worth a model's attention, whatever they contain. */
export const MAX_READ_BYTES = 2_000_000;
/** Files skipped when grepping — scanning them costs more than they can return. */
export const MAX_SEARCH_BYTES = 1_000_000;

export interface IgnoreRules {
  /** Compiled `.agentignore` / `.gitignore` matchers, in file order. */
  patterns: Array<{ re: RegExp; negated: boolean; dirOnly: boolean }>;
  dirs: Set<string>;
}

const cache = new Map<string, IgnoreRules>();

/**
 * True when the path is a credential file.
 *
 * Checked before every read, write, edit and delete. Not configurable: a
 * project that could opt out of this would be one keystroke from leaking its
 * own keys to a model provider.
 */
export function isSecret(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (SECRET_EXCEPTIONS.some((re) => re.test(normalized))) return false;
  return SECRET_PATTERNS.some((re) => re.test(normalized));
}

/** Human-readable refusal, safe to hand back to the model. */
export function secretRefusal(relativePath: string): string {
  return (
    `Error: '${relativePath}' looks like a credential file, so it is not readable or writable. ` +
    `Anything read here would be sent to the model provider. If you need a value from it, ask the user.`
  );
}

/**
 * Load ignore rules for a project.
 *
 * `.agentignore` is the project's own list; `.gitignore` is honoured too,
 * because a file the repo does not track is almost never one the agent should
 * be reading. Both use gitignore syntax.
 */
export function loadIgnoreRules(root: string): IgnoreRules {
  const cached = cache.get(root);
  if (cached) return cached;

  const rules: IgnoreRules = { patterns: [], dirs: new Set(DEFAULT_IGNORED_DIRS) };

  for (const name of ['.gitignore', '.agentignore']) {
    const file = path.join(root, name);
    let text: string;
    try {
      if (!fs.existsSync(file)) continue;
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const negated = line.startsWith('!');
      const body = negated ? line.slice(1) : line;
      const dirOnly = body.endsWith('/');
      const pattern = dirOnly ? body.slice(0, -1) : body;
      if (!pattern) continue;

      // A bare name with no slash is a plain directory rule we can match fast.
      if (!negated && dirOnly && !pattern.includes('/') && !/[*?[\]]/.test(pattern)) {
        rules.dirs.add(pattern);
        continue;
      }

      try {
        rules.patterns.push({ re: globToRegExp(pattern), negated, dirOnly });
      } catch (err: any) {
        logger.warn(`[Ignore] Skipping unparseable rule '${line}' in ${name}: ${err.message}`);
      }
    }
  }

  cache.set(root, rules);
  return rules;
}

/** Forget cached rules for a root. Used by tests, and after editing a rules file. */
export function clearIgnoreCache(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}

/**
 * True when a path should be skipped while walking the tree.
 *
 * Later rules win, and a negation re-includes, matching gitignore semantics.
 */
export function isIgnored(rules: IgnoreRules, relativePath: string, isDirectory = false): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (!normalized || normalized === '.') return false;

  for (const segment of normalized.split('/')) {
    if (rules.dirs.has(segment)) return true;
  }

  let ignored = false;
  for (const rule of rules.patterns) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.re.test(normalized)) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Translate a gitignore pattern into a regular expression.
 *
 * Covers the syntax that appears in real ignore files: `*` within a segment,
 * `**` across segments, `?`, character classes, leading `/` for anchoring, and
 * an unanchored pattern matching at any depth.
 */
export function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (char === '*') {
      if (body[i + 1] === '*') {
        // `**/` spans directories; a trailing `**` matches everything below.
        i++;
        if (body[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    if (char === '[') {
      const close = body.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        continue;
      }
      out += body.slice(i, close + 1);
      i = close;
      continue;
    }

    out += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }

  // Anchored patterns match from the root; the rest match at any depth. Either
  // way a directory match also covers everything inside it.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${out}(?:/.*)?$`);
}
