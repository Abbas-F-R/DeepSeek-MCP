import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;

const { WORKSPACE_TOOLS, getOpenAIToolSchemas } = await import('../../src/subagents/tools/workspaceTools.js');
import type { WorkspaceToolContext } from '../../src/subagents/tools/workspaceTools.js';

describe('workspace tools', () => {
  let sandbox: Sandbox;
  let ctx: WorkspaceToolContext;

  beforeEach(() => {
    sandbox = createSandbox('node-ts');
    ctx = { root: sandbox.root, touchedFiles: [] };
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  test('read_file returns content for a relative path', async () => {
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: 'src/math.ts' }, ctx);
    assert.match(out, /export function sum/);
  });

  test('read_file numbers its lines so the agent can cite file:line', async () => {
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: 'src/math.ts' }, ctx);
    assert.match(out, /^\[src\/math\.ts, \d+ lines\]/);
    assert.match(out, /^\s*1\| export function sum/m);
  });

  test('read_file returns just the requested range', async () => {
    // The point of the range is not to read a whole file to see part of it.
    sandbox.write(
      'src/big.ts',
      `${Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}; // ordinary source`).join('\n')}\n`
    );

    const whole = await WORKSPACE_TOOLS.read_file.execute({ path: 'src/big.ts' }, ctx);
    const slice = await WORKSPACE_TOOLS.read_file.execute({ path: 'src/big.ts', offset: 100, limit: 5 }, ctx);

    assert.match(slice, /lines 100-104 of 401/);
    assert.match(slice, /100\| export const value99/);
    assert.doesNotMatch(slice, /^\s*1\| /m, 'lines before the offset are not included');
    assert.ok(slice.length < whole.length / 20, `a five-line range cost ${slice.length} of ${whole.length} chars`);
  });

  test('read_file rejects an offset past the end', async () => {
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: 'src/math.ts', offset: 9000 }, ctx);
    assert.match(out, /is past the end/);
  });

  test('read_file reports missing files and directories without throwing', async () => {
    assert.match(await WORKSPACE_TOOLS.read_file.execute({ path: 'src/nope.ts' }, ctx), /file not found/);
    assert.match(await WORKSPACE_TOOLS.read_file.execute({ path: 'src' }, ctx), /is a directory/);
  });

  test('write_file creates nested paths and tracks the file', async () => {
    const out = await WORKSPACE_TOOLS.write_file.execute(
      { path: 'src/services/user.ts', content: 'export const user = 1;\n' },
      ctx
    );
    assert.match(out, /Created 'src\/services\/user\.ts'/);
    assert.equal(sandbox.read('src/services/user.ts'), 'export const user = 1;\n');
    assert.deepEqual(ctx.touchedFiles, ['src/services/user.ts']);
  });

  test('write_file reports an overwrite distinctly', async () => {
    await WORKSPACE_TOOLS.write_file.execute({ path: 'a.ts', content: '1' }, ctx);
    const out = await WORKSPACE_TOOLS.write_file.execute({ path: 'a.ts', content: '2' }, ctx);
    assert.match(out, /^Overwrote/);
  });

  test('edit_file replaces a unique block', async () => {
    const out = await WORKSPACE_TOOLS.edit_file.execute(
      { path: 'src/math.ts', target: 'values.length - 1', replacement: 'values.length' },
      ctx
    );
    assert.match(out, /^Updated/);
    assert.match(sandbox.read('src/math.ts'), /i < values\.length;/);
  });

  test('edit_file refuses a missing or ambiguous target', async () => {
    assert.match(
      await WORKSPACE_TOOLS.edit_file.execute({ path: 'src/math.ts', target: 'nothing here', replacement: 'x' }, ctx),
      /target text not found/
    );

    sandbox.write('dup.ts', 'const a = 1;\nconst a = 1;\n');
    assert.match(
      await WORKSPACE_TOOLS.edit_file.execute({ path: 'dup.ts', target: 'const a = 1;', replacement: 'const b = 2;' }, ctx),
      /appears 2 times/
    );
  });

  test('delete_file removes files but refuses directories', async () => {
    assert.match(await WORKSPACE_TOOLS.delete_file.execute({ path: 'src/math.ts' }, ctx), /^Deleted/);
    assert.equal(sandbox.exists('src/math.ts'), false);
    assert.match(await WORKSPACE_TOOLS.delete_file.execute({ path: 'src' }, ctx), /is a directory/);
  });

  test('list_directory skips build output and can recurse', async () => {
    sandbox.write('node_modules/pkg/index.js', 'module.exports = {};');

    const flat = await WORKSPACE_TOOLS.list_directory.execute({}, ctx);
    assert.match(flat, /dir\s+src/);
    assert.doesNotMatch(flat, /node_modules/);

    const deep = await WORKSPACE_TOOLS.list_directory.execute({ recursive: true }, ctx);
    assert.match(deep, /src\/db\.ts/);
  });

  test('search_files returns path:line hits', async () => {
    const out = await WORKSPACE_TOOLS.search_files.execute({ query: 'findUserByName' }, ctx);
    assert.match(out, /src\/db\.ts:\d+:/);
    assert.match(out, /src\/server\.ts:\d+:/);
  });

  test('search_files supports regex and file filters', async () => {
    const regex = await WORKSPACE_TOOLS.search_files.execute({ query: 'export (const|function)', regex: true }, ctx);
    assert.match(regex, /src\/math\.ts/);

    // A bare extension is the shorthand models reach for, and what the old
    // suffix-matching filter accepted.
    const filtered = await WORKSPACE_TOOLS.search_files.execute({ query: 'Sandbox App', file_glob: '.md' }, ctx);
    assert.match(filtered, /README\.md/);
    assert.doesNotMatch(filtered, /\.ts:/);

    const starred = await WORKSPACE_TOOLS.search_files.execute({ query: 'export', file_glob: '*.ts' }, ctx);
    assert.match(starred, /src\/math\.ts/);

    // Path globs are the point of the change — these matched nothing before.
    const scoped = await WORKSPACE_TOOLS.search_files.execute({ query: 'export', file_glob: 'src/**' }, ctx);
    assert.match(scoped, /src\//);
    assert.doesNotMatch(scoped, /README\.md/);

    const nested = await WORKSPACE_TOOLS.search_files.execute({ query: 'export', file_glob: '**/*.ts' }, ctx);
    assert.match(nested, /src\/math\.ts/);

    const invalid = await WORKSPACE_TOOLS.search_files.execute({ query: '([unclosed', regex: true }, ctx);
    assert.match(invalid, /invalid regular expression/);
  });

  test('search_files reports no matches instead of failing', async () => {
    assert.match(await WORKSPACE_TOOLS.search_files.execute({ query: 'zzz-not-present' }, ctx), /No matches/);
  });

  describe('sandbox containment', () => {
    const escapes = ['../escape.txt', '../../../etc/hosts', '/etc/passwd', '~/.ssh/id_rsa'];

    test('every path-taking tool refuses to leave the root', async () => {
      for (const target of escapes) {
        assert.match(
          await WORKSPACE_TOOLS.read_file.execute({ path: target }, ctx),
          /outside the workspace root/,
          `read_file should refuse ${target}`
        );
        assert.match(
          await WORKSPACE_TOOLS.write_file.execute({ path: target, content: 'pwned' }, ctx),
          /outside the workspace root/,
          `write_file should refuse ${target}`
        );
        assert.match(
          await WORKSPACE_TOOLS.delete_file.execute({ path: target }, ctx),
          /outside the workspace root/,
          `delete_file should refuse ${target}`
        );
      }
      assert.deepEqual(ctx.touchedFiles, [], 'no file outside the root may be tracked as touched');
    });

    test('list_directory and search_files stay inside the root', async () => {
      assert.match(await WORKSPACE_TOOLS.list_directory.execute({ path: '/etc' }, ctx), /outside the workspace root/);
      assert.match(
        await WORKSPACE_TOOLS.search_files.execute({ query: 'root', path: '../..' }, ctx),
        /outside the workspace root/
      );
    });
  });

  test('tool schemas are emitted only for allowed tools', () => {
    const schemas = getOpenAIToolSchemas(['read_file', 'search_files']);
    assert.deepEqual(schemas.map((s: any) => s.function.name), ['read_file', 'search_files']);
    assert.equal(schemas[0].type, 'function');
  });
});
