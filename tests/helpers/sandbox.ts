import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export type FixturePreset = 'node-ts' | 'python' | 'empty';

/**
 * A throwaway project directory. Agents get pointed at one of these instead of
 * a real repo, so a misbehaving subagent can only damage a temp folder.
 */
export interface Sandbox {
  root: string;
  /** Absolute path inside the sandbox. */
  path(relative: string): string;
  write(relative: string, content: string): string;
  read(relative: string): string;
  exists(relative: string): boolean;
  /** Every file under the sandbox, relative, excluding .agent state. */
  tree(): string[];
  cleanup(): void;
}

const SANDBOX_PARENT = path.join(os.tmpdir(), 'deepseek-mcp-tests');

const FIXTURES: Record<FixturePreset, Record<string, string>> = {
  'node-ts': {
    'package.json': JSON.stringify(
      {
        name: 'sandbox-app',
        type: 'module',
        dependencies: { express: '^5.0.0' },
        devDependencies: { typescript: '^5.7.0', vitest: '^2.0.0' },
      },
      null,
      2
    ),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true } }, null, 2),
    'README.md': '# Sandbox App\n\nA tiny Express app used as an agent test fixture.\n',
    'src/db.ts': `import { Pool } from 'pg';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Deliberately vulnerable: string-concatenated SQL, for the security agent to find.
export async function findUserByName(name: string) {
  const result = await pool.query('SELECT * FROM users WHERE name = ' + "'" + name + "'");
  return result.rows[0];
}
`,
    'src/server.ts': `import express from 'express';
import { findUserByName } from './db.js';

export const app = express();

app.get('/users/:name', async (req, res) => {
  const user = await findUserByName(req.params.name);
  res.json(user);
});
`,
    'src/math.ts': `export function sum(values: number[]): number {
  let total = 0;
  // Off-by-one: the last element is never added.
  for (let i = 0; i < values.length - 1; i++) {
    total += values[i];
  }
  return total;
}
`,
  },
  python: {
    'pyproject.toml': '[project]\nname = "sandbox-api"\ndependencies = ["fastapi", "pytest"]\n',
    'app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n',
  },
  empty: {
    'README.md': '# Empty sandbox\n',
  },
};

export function createSandbox(preset: FixturePreset = 'node-ts', extraFiles: Record<string, string> = {}): Sandbox {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(ensureParent(), `${preset}-`))
  );

  const files = { ...FIXTURES[preset], ...extraFiles };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }

  const sandbox: Sandbox = {
    root,
    path: (relative) => path.join(root, relative),
    write(relative, content) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf-8');
      return target;
    },
    read: (relative) => fs.readFileSync(path.join(root, relative), 'utf-8'),
    exists: (relative) => fs.existsSync(path.join(root, relative)),
    tree() {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.agent') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(root, full));
        }
      };
      walk(root);
      return out.sort();
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  return sandbox;
}

/** Isolated stand-in for ~/.deepseek-mcp so tests never touch the real index. */
export function createStateDir(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(ensureParent(), 'state-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ensureParent(): string {
  fs.mkdirSync(SANDBOX_PARENT, { recursive: true });
  return SANDBOX_PARENT;
}
