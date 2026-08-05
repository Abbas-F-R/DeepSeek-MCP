import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';
import { McpClient } from '../helpers/mcpClient.js';

/**
 * Protocol-level tests: they drive the built server over stdio exactly the way
 * Claude Code does. No DeepSeek calls are made here.
 */
describe('MCP server protocol', () => {
  const state = createStateDir();
  let sandbox: Sandbox;
  let client: McpClient;

  before(async () => {
    sandbox = createSandbox('node-ts');
    client = await McpClient.start({ projectRoot: sandbox.root, stateDir: state.dir });
  });

  after(() => {
    client.stop();
    sandbox.cleanup();
    state.cleanup();
  });

  test('advertises six tools', async () => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['agent', 'agent_control', 'analyze', 'generate', 'memory', 'review']);
  });

  test('the listed schema payload stays under 15k chars', async () => {
    const tools = await client.listTools();
    assert.ok(JSON.stringify(tools).length < 15_000);
  });

  test('an unknown tool is reported as an error, not a crash', async () => {
    const result = await client.call('does_not_exist', {});
    assert.equal(result.isError, true);
    assert.match(result.text, /unknown tool/);
  });

  test('memory brief describes the bound project', async () => {
    const brief = await client.callOk('memory', { action: 'brief' });
    assert.match(brief, new RegExp(`root: ${sandbox.root}`));
    assert.match(brief, /lang=TypeScript/);
    assert.match(brief, /framework=Express\.js/);
    assert.match(brief, /No threads yet/);
  });

  test('a chat thread can be opened, saved and read back', async () => {
    const started = await client.callOk('memory', { action: 'chat_start', title: 'Protocol thread', goal: 'test the wire' });
    const chatId = started.match(/chat (chat-[\w-]+)/)?.[1];
    assert.ok(chatId, 'chat_start must return a chat id');

    await client.callOk('memory', {
      action: 'chat_save',
      chat: chatId,
      summary: 'wired up',
      next_steps: ['verify persistence'],
      decisions: ['keep state in .agent/'],
    });

    const brief = await client.callOk('memory', { action: 'chat_get', chat: chatId });
    assert.match(brief, /State: wired up/);
    assert.match(brief, /verify persistence/);
    assert.match(brief, /keep state in \.agent\//);
  });

  test('rules added over the wire land in the project directive', async () => {
    await client.callOk('memory', { action: 'rule', rule: 'Prefer composition over inheritance' });
    const brief = await client.callOk('memory', { action: 'brief' });
    assert.match(brief, /Prefer composition over inheritance/);
  });

  test('legacy tool names still work and are not advertised', async () => {
    const tools = await client.listTools();
    assert.ok(!tools.some((t) => t.name === 'subagent_memory'));

    const legacy = await client.callOk('subagent_memory', { action: 'view' });
    assert.match(legacy, /Prefer composition over inheritance/);

    const legacyRule = await client.callOk('subagent_memory', { action: 'add_rule', custom_rule: 'Log with context' });
    assert.match(legacyRule, /Stored rule \[/);
  });

  test('review reads a path from the project instead of pasted content', async () => {
    // A bad model id makes the provider fail fast; the point is that the file
    // was located and read inside the sandbox before any API call.
    const result = await client.callOk('review', { kind: 'code', path: 'src/math.ts', model: 'invalid-model-for-test' });
    assert.match(result, /Task Failed/);
    assert.doesNotMatch(result, /Path not found/);
  });

  test('a missing path is reported clearly', async () => {
    const result = await client.call('review', { kind: 'code', path: 'src/ghost.ts' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Path not found in project/);
  });

  test('a path outside the project is refused', async () => {
    const result = await client.call('analyze', { kind: 'summarize', path: '../../../etc/hosts' });
    assert.equal(result.isError, true);
    assert.match(result.text, /outside the workspace root/);
  });

  test('review requires content or a path', async () => {
    const result = await client.call('review', { kind: 'code' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Provide either "content" or "path"/);
  });
});

describe('project isolation over the wire', () => {
  const state = createStateDir();
  let projectA: Sandbox;
  let projectB: Sandbox;
  let clientA: McpClient;
  let clientB: McpClient;

  before(async () => {
    projectA = createSandbox('node-ts');
    projectB = createSandbox('python');
    // B is launched from an unrelated cwd and bound only by PROJECT_ROOT,
    // exactly how --install wires a project up.
    clientA = await McpClient.start({ projectRoot: projectA.root, stateDir: state.dir });
    clientB = await McpClient.start({ projectRoot: projectB.root, cwd: '/tmp', stateDir: state.dir });
  });

  after(() => {
    clientA.stop();
    clientB.stop();
    projectA.cleanup();
    projectB.cleanup();
    state.cleanup();
  });

  test('each server detects its own stack', async () => {
    assert.match(await clientA.callOk('memory', { action: 'brief' }), /lang=TypeScript/);
    assert.match(await clientB.callOk('memory', { action: 'brief' }), /lang=Python/);
  });

  test('rules and chats do not cross between projects', async () => {
    await clientA.callOk('memory', { action: 'rule', rule: 'Only project A rule' });
    await clientA.callOk('memory', { action: 'chat_start', title: 'A thread' });

    const briefB = await clientB.callOk('memory', { action: 'brief' });
    assert.doesNotMatch(briefB, /Only project A rule/);
    assert.doesNotMatch(briefB, /A thread/);
    assert.match(await clientB.callOk('memory', { action: 'chat_list' }), /No chat threads/);
  });

  test('the machine-wide index knows both projects', async () => {
    const projects = await clientA.callOk('memory', { action: 'projects' });
    assert.match(projects, new RegExp(projectA.root));
    assert.match(projects, new RegExp(projectB.root));
  });
});

/**
 * .mcp.json carries no project path, so the server must find the root from the
 * working directory Claude Code launches it in.
 */
describe('root detection without PROJECT_ROOT', () => {
  const state = createStateDir();
  let sandbox: Sandbox;

  before(() => {
    sandbox = createSandbox('node-ts');
  });

  after(() => {
    sandbox.cleanup();
    state.cleanup();
  });

  test('the project directory as cwd is enough', async () => {
    const client = await McpClient.start({ cwd: sandbox.root, stateDir: state.dir, env: { PROJECT_ROOT: '' } });
    try {
      const brief = await client.callOk('memory', { action: 'brief' });
      assert.match(brief, new RegExp(`root: ${sandbox.root}`));
      assert.match(brief, /lang=TypeScript/);
    } finally {
      client.stop();
    }
  });

  test('a subdirectory walks up to the project root', async () => {
    const client = await McpClient.start({ cwd: sandbox.path('src'), stateDir: state.dir, env: { PROJECT_ROOT: '' } });
    try {
      const brief = await client.callOk('memory', { action: 'brief' });
      assert.match(brief, new RegExp(`root: ${sandbox.root}`));
      assert.ok(sandbox.exists('.agent/memory/PROJECT.md'), 'state belongs to the project root, not the subdirectory');
      assert.equal(sandbox.exists('src/.agent'), false);
    } finally {
      client.stop();
    }
  });

  test('workspace tools resolve against the detected root', async () => {
    const client = await McpClient.start({ cwd: sandbox.path('src'), stateDir: state.dir, env: { PROJECT_ROOT: '' } });
    try {
      // Path is relative to the detected project root, not to the cwd the server started in.
      const result = await client.callOk('review', { kind: 'code', path: 'src/math.ts', model: 'invalid-model-for-test' });
      assert.doesNotMatch(result, /Path not found/);
    } finally {
      client.stop();
    }
  });

  test('an explicit PROJECT_ROOT still overrides the cwd', async () => {
    const other = createSandbox('python');
    const client = await McpClient.start({ cwd: sandbox.root, projectRoot: other.root, stateDir: state.dir });
    try {
      const brief = await client.callOk('memory', { action: 'brief' });
      assert.match(brief, new RegExp(`root: ${other.root}`));
      assert.match(brief, /lang=Python/);
    } finally {
      client.stop();
      other.cleanup();
    }
  });
});

describe('state survives a server restart', () => {
  const state = createStateDir();
  let sandbox: Sandbox;

  before(() => {
    sandbox = createSandbox('node-ts');
  });

  after(() => {
    sandbox.cleanup();
    state.cleanup();
  });

  test('a chat opened by one process is found by the next', async () => {
    const first = await McpClient.start({ projectRoot: sandbox.root, stateDir: state.dir });
    const started = await first.callOk('memory', { action: 'chat_start', title: 'Survivor', goal: 'outlive the process' });
    const chatId = started.match(/chat (chat-[\w-]+)/)?.[1]!;
    await first.callOk('memory', { action: 'chat_save', chat: chatId, summary: 'stopped mid-refactor' });
    first.stop();

    const second = await McpClient.start({ projectRoot: sandbox.root, stateDir: state.dir });
    try {
      const brief = await second.callOk('memory', { action: 'brief' });
      assert.match(brief, /Survivor/);
      assert.match(brief, /stopped mid-refactor/);
      assert.match(brief, /outlive the process/);
    } finally {
      second.stop();
    }
  });
});
