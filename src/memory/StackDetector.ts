import fs from 'fs';
import path from 'path';

export interface ModuleStack {
  /** Path relative to the project root; '.' for the root itself. */
  dir: string;
  language?: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  codingStyle?: string;
}

export interface DetectedStack {
  /** Every module found, root first. Empty when nothing is recognisable. */
  modules: ModuleStack[];
  /** Rolled-up view of the whole project, for one-line summaries. */
  language?: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  codingStyle?: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'coverage',
]);

/** How deep below the root we look for module manifests. */
const MAX_DEPTH = 3;

/**
 * Detect a project's stack, one entry per module.
 *
 * A single-package repo yields one module ('.'); a monorepo like
 * `dashboard/ + server/` yields one per package. Scanning only the root — the
 * old behaviour — reported nothing at all for repos whose manifests all live
 * one level down.
 */
export function detectStack(root: string): DetectedStack {
  const found: ModuleStack[] = [];
  walk(root, root, 0, found);

  const modules = collapseNested(found);
  // Root first, then alphabetically, so output is stable across runs.
  modules.sort((a, b) => (a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir.localeCompare(b.dir)));

  const rollup = rollUp(modules);
  return { modules, ...rollup };
}

/**
 * Fold a module into its parent when both speak the same language.
 *
 * A .NET solution directory contains a .csproj per project, and a workspace root
 * contains a package.json per package — listing every one of them describes the
 * build system rather than the codebase. The child's extra detail (its test
 * framework, usually) is merged upward so nothing is lost.
 */
function collapseNested(modules: ModuleStack[]): ModuleStack[] {
  const sorted = [...modules].sort((a, b) => a.dir.length - b.dir.length);
  const kept: ModuleStack[] = [];

  for (const module of sorted) {
    const parent = kept.find(
      (candidate) =>
        candidate.language === module.language &&
        (candidate.dir === '.' || module.dir.startsWith(`${candidate.dir}/`))
    );

    if (!parent) {
      kept.push({ ...module });
      continue;
    }

    parent.framework = parent.framework || module.framework;
    parent.packageManager = parent.packageManager || module.packageManager;
    parent.testFramework = parent.testFramework || module.testFramework;
    parent.codingStyle = parent.codingStyle || module.codingStyle;
  }

  return kept;
}

function walk(root: string, dir: string, depth: number, out: ModuleStack[]): void {
  const detected = detectDir(dir);
  if (detected) {
    const rel = path.relative(root, dir) || '.';
    out.push({ dir: rel, ...detected });
    // A recognised module still gets descended into: a repo root may hold a
    // package.json and still contain independent sub-packages.
  }

  if (depth >= MAX_DEPTH) return;

  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.name.startsWith('.') || SKIP_DIRS.has(child.name)) continue;
    walk(root, path.join(dir, child.name), depth + 1, out);
  }
}

/** Stack facts for one directory, or undefined when it holds no manifest. */
function detectDir(dir: string): Omit<ModuleStack, 'dir'> | undefined {
  const has = (p: string) => fs.existsSync(path.join(dir, p));

  if (has('package.json')) return detectNode(dir, has);
  if (has('pyproject.toml') || has('requirements.txt')) return detectPython(dir, has);
  if (has('go.mod')) return detectGo(dir);
  if (has('Cargo.toml')) {
    return { language: 'Rust', codingStyle: 'Idiomatic Rust, Result-based error handling' };
  }
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    return { language: 'Java/Kotlin', framework: 'Spring Boot / JVM' };
  }
  if (has('composer.json')) return { language: 'PHP', framework: detectPhpFramework(dir) };
  if (has('Gemfile')) return { language: 'Ruby', framework: has('config/routes.rb') ? 'Rails' : undefined };
  if (has('pubspec.yaml')) return { language: 'Dart', framework: 'Flutter' };

  const dotnet = detectDotnet(dir);
  if (dotnet) return dotnet;

  return undefined;
}

function detectNode(dir: string, has: (p: string) => boolean): Omit<ModuleStack, 'dir'> {
  const stack: Omit<ModuleStack, 'dir'> = {
    language: has('tsconfig.json') ? 'TypeScript' : 'JavaScript',
  };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (deps['@nestjs/core']) stack.framework = 'NestJS';
    else if (deps.next) stack.framework = 'Next.js';
    else if (deps.nuxt) stack.framework = 'Nuxt';
    else if (deps['@angular/core']) stack.framework = 'Angular';
    else if (deps.express) stack.framework = 'Express.js';
    else if (deps.fastify) stack.framework = 'Fastify';
    else if (deps.hono) stack.framework = 'Hono';
    else if (deps.svelte) stack.framework = 'Svelte';
    else if (deps.react) stack.framework = deps.vite ? 'React + Vite' : 'React';
    else if (deps.vue) stack.framework = deps.vite ? 'Vue + Vite' : 'Vue';
    else stack.framework = 'Node.js';

    if (deps.vitest) stack.testFramework = 'Vitest';
    else if (deps.jest) stack.testFramework = 'Jest';
    else if (deps.mocha) stack.testFramework = 'Mocha';
    else if (deps['@playwright/test']) stack.testFramework = 'Playwright';

    stack.codingStyle =
      pkg.type === 'module' ? 'ES Modules, async/await, strict error handling' : 'CommonJS, async/await';
  } catch {
    stack.framework = 'Node.js';
  }

  if (has('pnpm-lock.yaml')) stack.packageManager = 'pnpm';
  else if (has('yarn.lock')) stack.packageManager = 'yarn';
  else if (has('bun.lockb') || has('bun.lock')) stack.packageManager = 'bun';
  else if (has('package-lock.json')) stack.packageManager = 'npm';

  return stack;
}

function detectPython(dir: string, has: (p: string) => boolean): Omit<ModuleStack, 'dir'> {
  const text =
    (has('pyproject.toml') ? safeRead(path.join(dir, 'pyproject.toml')) : '') +
    safeRead(path.join(dir, 'requirements.txt'));

  const stack: Omit<ModuleStack, 'dir'> = { language: 'Python', codingStyle: 'PEP 8, type hints' };
  if (/fastapi/i.test(text)) stack.framework = 'FastAPI';
  else if (/django/i.test(text)) stack.framework = 'Django';
  else if (/flask/i.test(text)) stack.framework = 'Flask';
  if (/pytest/i.test(text)) stack.testFramework = 'pytest';
  if (/\bpoetry\b/i.test(text)) stack.packageManager = 'poetry';
  else if (has('uv.lock')) stack.packageManager = 'uv';
  return stack;
}

function detectGo(dir: string): Omit<ModuleStack, 'dir'> {
  const mod = safeRead(path.join(dir, 'go.mod'));
  let framework = 'Go standard library';
  if (/gin-gonic/.test(mod)) framework = 'Gin';
  else if (/labstack\/echo/.test(mod)) framework = 'Echo';
  else if (/gofiber/.test(mod)) framework = 'Fiber';
  return { language: 'Go', framework, codingStyle: 'Idiomatic Go, explicit error returns' };
}

function detectDotnet(dir: string): Omit<ModuleStack, 'dir'> | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  if (!names.some((f) => f.endsWith('.csproj') || f.endsWith('.sln') || f.endsWith('.fsproj'))) return undefined;

  const stack: Omit<ModuleStack, 'dir'> = {
    language: 'C# (.NET)',
    framework: 'ASP.NET Core / .NET',
    codingStyle: 'PascalCase members, async/Task, Clean Architecture',
  };

  const projectText = names
    .filter((f) => f.endsWith('.csproj'))
    .map((f) => safeRead(path.join(dir, f)))
    .join('\n');
  if (/xunit/i.test(projectText)) stack.testFramework = 'xUnit';
  else if (/nunit/i.test(projectText)) stack.testFramework = 'NUnit';
  else if (/MSTest/i.test(projectText)) stack.testFramework = 'MSTest';

  return stack;
}

function detectPhpFramework(dir: string): string | undefined {
  const text = safeRead(path.join(dir, 'composer.json'));
  if (/laravel/i.test(text)) return 'Laravel';
  if (/symfony/i.test(text)) return 'Symfony';
  return undefined;
}

/**
 * Collapse the module list into project-level fields. The root module wins when
 * it exists; otherwise the first module supplies each missing field, so a
 * two-package repo still reports something useful in one line.
 */
function rollUp(modules: ModuleStack[]): Omit<DetectedStack, 'modules'> {
  const result: Omit<DetectedStack, 'modules'> = {};
  const keys = ['language', 'framework', 'packageManager', 'testFramework', 'codingStyle'] as const;

  for (const key of keys) {
    const values = modules.map((m) => m[key]).filter((v): v is string => Boolean(v));
    if (values.length === 0) continue;
    const unique = [...new Set(values)];
    result[key] = unique.length === 1 ? unique[0] : unique.slice(0, 3).join(' + ');
  }

  return result;
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}
