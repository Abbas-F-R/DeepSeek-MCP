import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;

const { resolveWorkspace, safeResolve, slugForRoot, relativeToRoot } = await import('../../src/workspace/WorkspaceContext.js');

describe('WorkspaceContext', () => {
  let sandbox: Sandbox;

  before(() => {
    sandbox = createSandbox('node-ts');
  });

  after(() => {
    sandbox.cleanup();
    state.cleanup();
  });

  test('resolves an explicit root', () => {
    const workspace = resolveWorkspace(sandbox.root);
    assert.equal(workspace.root, sandbox.root);
    assert.equal(workspace.name, path.basename(sandbox.root));
    assert.match(workspace.slug, /-[0-9a-f]{6}$/);
  });

  test('rejects a root that does not exist', () => {
    assert.throws(() => resolveWorkspace(path.join(sandbox.root, 'nope')), /does not exist/);
  });

  test('slugs are stable per root and differ across roots', () => {
    const other = createSandbox('empty');
    try {
      assert.equal(slugForRoot(sandbox.root), slugForRoot(sandbox.root));
      assert.notEqual(slugForRoot(sandbox.root), slugForRoot(other.root));
    } finally {
      other.cleanup();
    }
  });

  test('walks up to the project root when nothing is passed', () => {
    const nested = path.join(sandbox.root, 'src');
    const previousCwd = process.cwd();
    try {
      process.chdir(nested);
      assert.equal(resolveWorkspace().root, sandbox.root);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('PROJECT_ROOT wins over the working directory', () => {
    const previous = process.env.PROJECT_ROOT;
    const previousCwd = process.cwd();
    try {
      process.env.PROJECT_ROOT = sandbox.root;
      process.chdir('/tmp');
      assert.equal(resolveWorkspace().root, sandbox.root);
    } finally {
      process.chdir(previousCwd);
      if (previous === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = previous;
    }
  });

  describe('safeResolve', () => {
    test('joins relative paths to the root, not to process.cwd()', () => {
      assert.equal(safeResolve(sandbox.root, 'src/server.ts'), path.join(sandbox.root, 'src/server.ts'));
      assert.equal(safeResolve(sandbox.root, '.'), sandbox.root);
      assert.equal(safeResolve(sandbox.root, undefined), sandbox.root);
    });

    test('refuses traversal above the root', () => {
      assert.throws(() => safeResolve(sandbox.root, '../../../etc/hosts'), /outside the workspace root/);
      assert.throws(() => safeResolve(sandbox.root, 'src/../../escape.txt'), /outside the workspace root/);
    });

    test('refuses absolute paths outside the root', () => {
      assert.throws(() => safeResolve(sandbox.root, '/etc/passwd'), /outside the workspace root/);
      assert.throws(() => safeResolve(sandbox.root, '~/.ssh/id_rsa'), /outside the workspace root/);
    });

    test('accepts absolute paths inside the root', () => {
      const inside = path.join(sandbox.root, 'src/db.ts');
      assert.equal(safeResolve(sandbox.root, inside), inside);
    });

    test('a sibling directory sharing the root prefix is still outside', () => {
      assert.throws(() => safeResolve(sandbox.root, `${sandbox.root}-evil/secrets.txt`), /outside the workspace root/);
    });

    test('ALLOW_OUTSIDE_WORKSPACE=1 disables the check', () => {
      process.env.ALLOW_OUTSIDE_WORKSPACE = '1';
      try {
        assert.equal(safeResolve(sandbox.root, '/etc/hosts'), '/etc/hosts');
      } finally {
        delete process.env.ALLOW_OUTSIDE_WORKSPACE;
      }
    });
  });

  test('relativeToRoot reports paths relative to the project', () => {
    assert.equal(relativeToRoot(sandbox.root, path.join(sandbox.root, 'src/db.ts')), 'src/db.ts');
    assert.equal(relativeToRoot(sandbox.root, sandbox.root), '.');
  });
});
