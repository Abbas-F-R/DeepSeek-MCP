import fs from 'fs';
import path from 'path';

export interface DetectedStack {
  language?: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  codingStyle?: string;
}

/** Best-effort static detection of a project's stack from its manifests. */
export function detectStack(root: string): DetectedStack {
  const stack: DetectedStack = {};
  const has = (p: string) => fs.existsSync(path.join(root, p));

  if (has('package.json')) {
    stack.language = has('tsconfig.json') ? 'TypeScript' : 'JavaScript';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (deps['@nestjs/core']) stack.framework = 'NestJS';
      else if (deps.next) stack.framework = 'Next.js';
      else if (deps.nuxt) stack.framework = 'Nuxt';
      else if (deps['@angular/core']) stack.framework = 'Angular';
      else if (deps.express) stack.framework = 'Express.js';
      else if (deps.fastify) stack.framework = 'Fastify';
      else if (deps.react) stack.framework = 'React';
      else if (deps.vue) stack.framework = 'Vue';
      else stack.framework = 'Node.js';

      if (deps.vitest) stack.testFramework = 'Vitest';
      else if (deps.jest) stack.testFramework = 'Jest';
      else if (deps.mocha) stack.testFramework = 'Mocha';

      stack.codingStyle = pkg.type === 'module' ? 'ES Modules, async/await, strict error handling' : 'CommonJS, async/await';
    } catch {
      stack.framework = 'Node.js';
    }

    if (has('pnpm-lock.yaml')) stack.packageManager = 'pnpm';
    else if (has('yarn.lock')) stack.packageManager = 'yarn';
    else if (has('bun.lockb')) stack.packageManager = 'bun';
    else if (has('package-lock.json')) stack.packageManager = 'npm';
    return stack;
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    stack.language = 'Python';
    const text = (has('pyproject.toml') ? safeRead(path.join(root, 'pyproject.toml')) : '') + safeRead(path.join(root, 'requirements.txt'));
    if (/fastapi/i.test(text)) stack.framework = 'FastAPI';
    else if (/django/i.test(text)) stack.framework = 'Django';
    else if (/flask/i.test(text)) stack.framework = 'Flask';
    if (/pytest/i.test(text)) stack.testFramework = 'pytest';
    stack.codingStyle = 'PEP 8, type hints';
    return stack;
  }

  if (has('go.mod')) {
    stack.language = 'Go';
    const mod = safeRead(path.join(root, 'go.mod'));
    if (/gin-gonic/.test(mod)) stack.framework = 'Gin';
    else if (/labstack\/echo/.test(mod)) stack.framework = 'Echo';
    else stack.framework = 'Go standard library';
    stack.codingStyle = 'Idiomatic Go, explicit error returns';
    return stack;
  }

  if (has('Cargo.toml')) {
    stack.language = 'Rust';
    stack.codingStyle = 'Idiomatic Rust, Result-based error handling';
    return stack;
  }

  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    stack.language = 'Java/Kotlin';
    stack.framework = 'Spring Boot / JVM';
    return stack;
  }

  try {
    if (fs.readdirSync(root).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
      stack.language = 'C# (.NET)';
      stack.framework = 'ASP.NET Core / .NET';
      stack.codingStyle = 'PascalCase members, async/Task, Clean Architecture';
      return stack;
    }
  } catch {
    /* unreadable root */
  }

  return stack;
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}
