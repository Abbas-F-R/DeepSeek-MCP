import fs from 'fs';
import path from 'path';
import { PACKAGE_ROOT } from '../config/index.js';
import { resolveWorkspace } from '../workspace/WorkspaceContext.js';

const SERVER_KEY = 'deepseek-subagents';

export type InstallMode = 'local' | 'portable';

interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function readPackageField<T>(field: string): T | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return pkg[field] as T;
  } catch {
    return undefined;
  }
}

/** `git+https://github.com/user/repo.git` -> `github:user/repo` for npx. */
function gitSpecifier(): string | undefined {
  const repository = readPackageField<{ url?: string } | string>('repository');
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = url?.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return match ? `github:${match[1]}/${match[2]}` : undefined;
}

/**
 * The project root is never written into `.mcp.json`. The server is launched
 * with the project directory as its cwd and detects the root from there, so the
 * config carries no path that could be stale, wrong, or specific to one machine.
 *
 * `local` pins this machine's checkout of the server — fastest, not shareable.
 * `portable` fetches the server with npx and takes the API key from the
 * environment through `${VAR}` expansion, so the file is safe to commit.
 */
function buildServerEntry(mode: InstallMode): ServerEntry {
  if (mode === 'portable') {
    const specifier = gitSpecifier();
    if (!specifier) {
      throw new Error('No GitHub repository is set in package.json, so a portable config cannot be generated.');
    }
    return {
      command: 'npx',
      args: ['-y', specifier],
      env: { DEEPSEEK_API_KEY: '${DEEPSEEK_API_KEY}' },
    };
  }

  return {
    command: 'node',
    args: [path.join(PACKAGE_ROOT, 'dist', 'index.js')],
  };
}

/**
 * Wire this MCP server into another project: writes/merges `.mcp.json`, drops
 * the skill file in place, and gitignores the session transcripts. Each project
 * gets its own stdio server process whose cwd is that project, which is what
 * keeps workspaces from bleeding into each other.
 */
export function installIntoProject(targetDir?: string, mode: InstallMode = 'local'): void {
  const workspace = resolveWorkspace(targetDir || process.cwd());
  const root = workspace.root;

  if (mode === 'local' && !fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'index.js'))) {
    console.error(`Build output missing. Run "npm run build" in ${PACKAGE_ROOT} first.`);
    process.exit(1);
  }
  if (root === PACKAGE_ROOT) {
    console.error('Refusing to install the server into its own source directory. Pass a target project path.');
    process.exit(1);
  }

  let entry: ServerEntry;
  try {
    entry = buildServerEntry(mode);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  // 1. .mcp.json
  const mcpFile = path.join(root, '.mcp.json');
  let mcpConfig: any = { mcpServers: {} };
  if (fs.existsSync(mcpFile)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
      mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    } catch (err: any) {
      console.error(`Existing .mcp.json is not valid JSON (${err.message}). Fix or remove it, then re-run.`);
      process.exit(1);
    }
  }
  mcpConfig.mcpServers[SERVER_KEY] = entry;
  fs.writeFileSync(mcpFile, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf-8');

  // 2. Skill file
  const skillSource = path.join(PACKAGE_ROOT, 'SKILL.md');
  const skillTarget = path.join(root, '.claude', 'skills', SERVER_KEY, 'SKILL.md');
  if (fs.existsSync(skillSource)) {
    fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
    fs.copyFileSync(skillSource, skillTarget);
  }

  // 3. Keep session transcripts out of git; project.json and chats are worth committing.
  const gitignore = path.join(root, '.gitignore');
  const ignoreLine = '.agent/sessions/';
  if (fs.existsSync(gitignore)) {
    const current = fs.readFileSync(gitignore, 'utf-8');
    if (!current.includes(ignoreLine)) {
      fs.appendFileSync(gitignore, `${current.endsWith('\n') ? '' : '\n'}${ignoreLine}\n`, 'utf-8');
    }
  } else {
    fs.writeFileSync(gitignore, `${ignoreLine}\n`, 'utf-8');
  }

  console.log(`Installed ${SERVER_KEY} into ${root} (${mode} mode)`);
  console.log(`  .mcp.json          -> ${entry.command} ${entry.args.join(' ')}`);
  if (fs.existsSync(skillTarget)) console.log(`  ${path.relative(root, skillTarget)}`);
  console.log(`  .gitignore         -> ${ignoreLine}`);
  console.log(`  project root       -> detected from the server's cwd, not written to the config`);

  if (mode === 'portable') {
    console.log('\nThis config is safe to commit. Everyone who clones the project needs:');
    console.log('  export DEEPSEEK_API_KEY=...   (in their own shell profile)');
    console.log('\nTo point at a local checkout instead of npx, replace the entry with:');
    console.log('  "command": "node", "args": ["${DEEPSEEK_MCP_HOME}/dist/index.js"]');
  } else {
    console.log('\nThe server path is absolute for this machine. Use --portable before committing it.');
  }
  console.log('\nRestart Claude Code in that project, then call memory{action:"brief"} to start.');
}
