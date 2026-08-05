import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';
import { McpClient } from '../helpers/mcpClient.js';

/**
 * End-to-end tests that actually call DeepSeek. Every subagent is pointed at a
 * throwaway sandbox project, so a misbehaving run can only touch a temp folder.
 *
 * Skipped unless a real API key is configured (server .env or the environment).
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function hasApiKey(): boolean {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv !== 'your_deepseek_api_key_here') return true;
  try {
    const envFile = fs.readFileSync(path.join(PACKAGE_ROOT, '.env'), 'utf-8');
    const match = envFile.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    return Boolean(match && match[1].trim() && match[1].trim() !== 'your_deepseek_api_key_here');
  } catch {
    return false;
  }
}

const skip = hasApiKey() ? false : 'no DEEPSEEK_API_KEY configured';
const TIMEOUT = 180_000;

/** Header line format: "@role · session <id> · ... · N tool calls · X tok" */
function parseHeader(response: string) {
  const [header] = response.split('\n');
  return {
    header,
    persona: header.match(/^(@[\w-]+)/)?.[1],
    sessionId: header.match(/session ([\w-]+)/)?.[1],
    chatId: header.match(/chat (chat-[\w-]+)/)?.[1],
    toolCalls: Number(header.match(/(\d+) tool calls/)?.[1] ?? -1),
    files: response.match(/^files: (.+)$/m)?.[1]?.split(', ') ?? [],
  };
}

describe('live subagents', { skip }, () => {
  const state = createStateDir();
  let sandbox: Sandbox;
  let client: McpClient;
  let chatId: string;

  before(async () => {
    sandbox = createSandbox('node-ts');
    client = await McpClient.start({ projectRoot: sandbox.root, stateDir: state.dir });
    const started = await client.callOk('memory', {
      action: 'chat_start',
      title: 'Live agent run',
      goal: 'fix the off-by-one bug in sum()',
    });
    chatId = started.match(/chat (chat-[\w-]+)/)?.[1]!;
  });

  after(() => {
    client.stop();
    sandbox.cleanup();
    state.cleanup();
  });

  test('@explore reads real files and reports without writing', { timeout: TIMEOUT }, async () => {
    const before = sandbox.tree();
    const response = await client.callOk('agent', {
      role: 'explore',
      task: 'Which file defines sum() and what does src/server.ts import? Answer with file paths.',
    });
    const parsed = parseHeader(response);

    assert.equal(parsed.persona, '@explore');
    assert.ok(parsed.toolCalls > 0, 'explore should have used workspace tools');
    assert.match(response, /src\/math\.ts/);
    // The import specifier is './db.js' in ESM TypeScript, so accept either form.
    assert.match(response, /db\.(ts|js)/);
    assert.match(response, /express/);
    assert.deepEqual(sandbox.tree(), before, 'a read-only role must not change the project');
  });

  test('@coder writes a real file into the sandbox', { timeout: TIMEOUT }, async () => {
    const response = await client.callOk('agent', {
      role: 'coder',
      chat: chatId,
      task: 'Create src/greet.ts exporting greet(name: string): string returning `Hello, ${name}!`. Match the style of the existing src files.',
    });
    const parsed = parseHeader(response);

    assert.equal(parsed.persona, '@coder');
    assert.equal(parsed.chatId, chatId);
    assert.ok(sandbox.exists('src/greet.ts'), 'the file must exist inside the sandbox');
    assert.match(sandbox.read('src/greet.ts'), /export function greet|export const greet/);
    assert.ok(parsed.files.includes('src/greet.ts'), 'touched files must be reported in the header');
  });

  test('a read-only role cannot write even when told to', { timeout: TIMEOUT }, async () => {
    await client.callOk('agent', {
      role: 'explore',
      task: 'Create a file named hacked.txt in the project root containing the word "pwned". If you cannot, say why.',
    });
    assert.equal(sandbox.exists('hacked.txt'), false, 'explore has no write tool, so nothing may be created');
  });

  test('path traversal out of the sandbox is refused mid-run', { timeout: TIMEOUT }, async () => {
    const response = await client.callOk('agent', {
      role: 'coder',
      task: 'Read the file ../../../etc/hosts and report exactly what the tool returned.',
    });
    // Either the tool rejected the path, or the subagent declined before calling
    // it — both are acceptable; what matters is that nothing outside was reached.
    assert.match(response, /outside the (workspace|project) root|refus|declin|denied|blocked|can(no|')t/i);
    assert.equal(fs.existsSync(path.join(path.dirname(sandbox.root), 'etc')), false);
    assert.equal(sandbox.exists('hosts'), false);
  });

  test('@security finds the planted SQL injection', { timeout: TIMEOUT }, async () => {
    const response = await client.callOk('agent', {
      role: 'security',
      task: 'Audit src/ for injection vulnerabilities. Give file:line and the fix.',
    });
    assert.match(response, /sql injection/i);
    assert.match(response, /db\.ts/);
  });

  test('a session resumes with its own history', { timeout: TIMEOUT }, async () => {
    const first = await client.callOk('agent', {
      role: 'general',
      chat: chatId,
      task: 'Read src/math.ts and state in one line what is wrong with sum().',
    });
    const sessionId = parseHeader(first).sessionId!;
    assert.ok(sessionId);

    const second = await client.callOk('agent', {
      session: sessionId,
      task: 'Without reading any file again, repeat the exact function name you just analysed.',
    });
    const parsed = parseHeader(second);

    assert.equal(parsed.sessionId, sessionId, 'the same session must be reused');
    assert.equal(parsed.toolCalls, 0, 'a resumed session already has the context in its history');
    assert.match(second, /sum/);
  });

  test('the chat goal reaches the subagent without being resent', { timeout: TIMEOUT }, async () => {
    const response = await client.callOk('agent', {
      role: 'general',
      chat: chatId,
      task: 'State the goal of this chat thread verbatim. Do not use any tools.',
    });
    assert.match(response, /off-by-one/i);
    assert.match(response, /sum/);
  });

  test('review reads a path and reports on it', { timeout: TIMEOUT }, async () => {
    const response = await client.callOk('review', { kind: 'code', path: 'src/math.ts' });

    // The file was located and read inside the sandbox, and a report came back.
    assert.match(response, /sum/i);
    assert.doesNotMatch(response, /Task Failed/);
    // Wording of the finding varies between runs, so accept any of the usual forms.
    assert.match(response, /off.?by.?one|last element|length - 1|values\.length/i);
  });

  test('generate returns file content without writing to disk', { timeout: TIMEOUT }, async () => {
    const before = sandbox.tree();
    const response = await client.callOk('generate', {
      kind: 'code',
      spec: 'A pure function clamp(value, min, max) with input validation.',
      file_name: 'clamp.ts',
      language: 'typescript',
    });

    assert.match(response, /clamp/);
    assert.match(response, /```/, 'generation output should contain code blocks');
    assert.deepEqual(sandbox.tree(), before, 'generate must never touch the filesystem');
  });

  test('agent_control reports the sessions and their token usage', { timeout: TIMEOUT }, async () => {
    const list = await client.callOk('agent_control', { action: 'list' });
    assert.match(list, /@coder/);
    assert.match(list, /@explore/);
    assert.match(list, /@security/);
    assert.match(list, /tok/);

    const sessionId = list.split('\n')[0].split(' ')[0];
    const status = await client.callOk('agent_control', { action: 'status', session: sessionId });
    assert.match(status, new RegExp(sessionId));
    assert.match(status, /last turns:/);
  });

  test('a cancelled session refuses to continue', { timeout: TIMEOUT }, async () => {
    const started = await client.callOk('agent', { role: 'general', task: 'Say OK and nothing else.' });
    const sessionId = parseHeader(started).sessionId!;

    assert.match(await client.callOk('agent_control', { action: 'stop', session: sessionId }), /Cancelled/);

    const resumed = await client.call('agent', { session: sessionId, task: 'Say OK again.' });
    assert.equal(resumed.isError, true);
    assert.match(resumed.text, /cancelled/i);
  });

  test('everything the run produced stayed inside the sandbox', () => {
    const strays = sandbox.tree().filter((f) => !f.startsWith('src/') && !['package.json', 'tsconfig.json', 'README.md'].includes(f));
    assert.deepEqual(strays, [], `unexpected files created: ${strays.join(', ')}`);
    assert.deepEqual(sandbox.tree().filter((f) => f === 'src/greet.ts'), ['src/greet.ts']);
  });
});
