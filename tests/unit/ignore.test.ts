import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, Sandbox } from '../helpers/sandbox.js';
import { clearIgnoreCache, isIgnored, isSecret, loadIgnoreRules } from '../../src/subagents/tools/ignore.js';
import { WORKSPACE_TOOLS, WorkspaceToolContext } from '../../src/subagents/tools/workspaceTools.js';

describe('credential files', () => {
  test('the usual secret files are refused', () => {
    for (const file of [
      '.env',
      '.env.local',
      '.env.production',
      'server/.env',
      'certs/server.pem',
      'app.key',
      '.ssh/id_rsa',
      'id_ed25519',
      '.npmrc',
      '.netrc',
      '.git-credentials',
      'config/credentials',
      'gcp/service-account-prod.json',
      'secrets.yaml',
      'config/secrets.json',
      'infra/terraform.tfstate',
      'keystore.jks',
    ]) {
      assert.equal(isSecret(file), true, `${file} should be refused`);
    }
  });

  test('templates and public keys are not secrets', () => {
    for (const file of [
      '.env.example',
      '.env.sample',
      '.env.template',
      'id_rsa.pub',
      'src/environment.ts',
      'docs/env.md',
      'keys.ts',
      'monkey.js',
    ]) {
      assert.equal(isSecret(file), false, `${file} should be readable`);
    }
  });
});

describe('ignore rules', () => {
  const sandboxes: Sandbox[] = [];
  const make = (extra?: Record<string, string>) => {
    const sandbox = createSandbox('node-ts', extra);
    sandboxes.push(sandbox);
    clearIgnoreCache(sandbox.root);
    return sandbox;
  };

  after(() => {
    for (const sandbox of sandboxes) sandbox.cleanup();
    clearIgnoreCache();
  });

  test('build output and dependencies are skipped by default', () => {
    const rules = loadIgnoreRules(make().root);
    for (const p of ['node_modules/react/index.js', 'dist/bundle.js', 'src/../build/out.js', '.venv/lib/x.py', 'coverage/lcov.info']) {
      assert.equal(isIgnored(rules, p), true, `${p} should be ignored`);
    }
    assert.equal(isIgnored(rules, 'src/server.ts'), false);
  });

  test('.gitignore entries are honoured', () => {
    const sandbox = make({ '.gitignore': 'generated/\n*.log\n//root-only.txt\n'.replace('//', '/') });
    const rules = loadIgnoreRules(sandbox.root);

    assert.equal(isIgnored(rules, 'generated/api.ts', false), true);
    assert.equal(isIgnored(rules, 'logs/debug.log'), true);
    assert.equal(isIgnored(rules, 'root-only.txt'), true);
    assert.equal(isIgnored(rules, 'src/index.ts'), false);
  });

  test('.agentignore adds rules on top of .gitignore', () => {
    const sandbox = make({ '.gitignore': 'dist/\n', '.agentignore': 'fixtures/**\ndocs/*.md\n' });
    const rules = loadIgnoreRules(sandbox.root);

    assert.equal(isIgnored(rules, 'fixtures/big/data.json'), true);
    assert.equal(isIgnored(rules, 'docs/readme.md'), true);
    assert.equal(isIgnored(rules, 'docs/nested/deep.md'), false, 'a single star does not cross directories');
  });

  test('a negation re-includes a path', () => {
    const sandbox = make({ '.agentignore': '*.generated.ts\n!keep.generated.ts\n' });
    const rules = loadIgnoreRules(sandbox.root);

    assert.equal(isIgnored(rules, 'src/api.generated.ts'), true);
    assert.equal(isIgnored(rules, 'src/keep.generated.ts'), false);
  });

  test('dot-directories are no longer hidden wholesale', () => {
    const rules = loadIgnoreRules(make().root);
    assert.equal(isIgnored(rules, '.github/workflows/ci.yml'), false);
    assert.equal(isIgnored(rules, '.claude/skills/x.md'), false);
    assert.equal(isIgnored(rules, '.git/config'), true);
  });
});

describe('the tools enforce it', () => {
  const sandboxes: Sandbox[] = [];
  const make = (extra?: Record<string, string>) => {
    const sandbox = createSandbox('node-ts', extra);
    sandboxes.push(sandbox);
    clearIgnoreCache(sandbox.root);
    return sandbox;
  };
  const ctx = (sandbox: Sandbox): WorkspaceToolContext => ({ root: sandbox.root, touchedFiles: [] });

  after(() => {
    for (const sandbox of sandboxes) sandbox.cleanup();
    clearIgnoreCache();
  });

  test('read_file refuses a credential file', async () => {
    const sandbox = make({ '.env': 'DEEPSEEK_API_KEY=sk-super-secret-value\n' });
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: '.env' }, ctx(sandbox));

    assert.match(out, /credential file/);
    assert.doesNotMatch(out, /sk-super-secret-value/, 'the value must never appear in tool output');
  });

  test('write, edit and delete refuse it too', async () => {
    const sandbox = make({ '.env': 'KEY=1\n' });

    const written = await WORKSPACE_TOOLS.write_file.execute({ path: '.env', content: 'KEY=2' }, ctx(sandbox));
    assert.match(written, /credential file/);
    assert.equal(sandbox.read('.env'), 'KEY=1\n', 'the file must be untouched');

    const edited = await WORKSPACE_TOOLS.edit_file.execute(
      { path: '.env', target: 'KEY=1', replacement: 'KEY=2' },
      ctx(sandbox)
    );
    assert.match(edited, /credential file/);

    const deleted = await WORKSPACE_TOOLS.delete_file.execute({ path: '.env' }, ctx(sandbox));
    assert.match(deleted, /credential file/);
    assert.ok(sandbox.exists('.env'));
  });

  test('a template beside a secret is still readable', async () => {
    const sandbox = make({ '.env': 'KEY=1\n', '.env.example': 'KEY=your_key_here\n' });
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: '.env.example' }, ctx(sandbox));
    assert.match(out, /your_key_here/);
  });

  test('list_directory hides both ignored paths and secrets', async () => {
    const sandbox = make({ '.env': 'KEY=1\n', 'dist/bundle.js': 'x', 'src/keep.ts': 'y' });
    const out = await WORKSPACE_TOOLS.list_directory.execute({ path: '.', recursive: true }, ctx(sandbox));

    assert.doesNotMatch(out, /\.env/, 'even the name of a credential file is withheld');
    assert.doesNotMatch(out, /dist/);
    assert.match(out, /src\/keep\.ts/);
  });

  test('search_files never returns a line from a secret', async () => {
    const sandbox = make({ '.env': 'DEEPSEEK_API_KEY=sk-leak-me\n', 'src/note.ts': '// DEEPSEEK_API_KEY is read from env\n' });
    const out = await WORKSPACE_TOOLS.search_files.execute({ query: 'DEEPSEEK_API_KEY' }, ctx(sandbox));

    assert.doesNotMatch(out, /sk-leak-me/);
    assert.match(out, /src\/note\.ts/, 'ordinary references are still found');
  });

  test('an oversized file is refused before it is read into memory', async () => {
    const sandbox = make({ 'huge.txt': 'x'.repeat(2_100_000) });
    const out = await WORKSPACE_TOOLS.read_file.execute({ path: 'huge.txt' }, ctx(sandbox));

    assert.match(out, /past the 2 MB read limit/);
    assert.match(out, /search_files/, 'the refusal should say what to do instead');
  });

  test('search skips files too large to be worth grepping', async () => {
    const sandbox = make({ 'big.csv': `${'a,b,c\n'.repeat(200_000)}needle\n`, 'src/small.ts': 'needle\n' });
    const out = await WORKSPACE_TOOLS.search_files.execute({ query: 'needle' }, ctx(sandbox));

    assert.doesNotMatch(out, /big\.csv/);
    assert.match(out, /src\/small\.ts/);
  });
});
