import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;

const { MemoryStore } = await import('../../src/memory/MemoryStore.js');

describe('MemoryStore', () => {
  const sandboxes: Sandbox[] = [];
  const make = (preset: Parameters<typeof createSandbox>[0] = 'node-ts', extra?: Record<string, string>) => {
    const sandbox = createSandbox(preset, extra);
    sandboxes.push(sandbox);
    return sandbox;
  };

  after(() => {
    for (const sandbox of sandboxes) sandbox.cleanup();
    state.cleanup();
  });

  test('detects a TypeScript/Express project and writes .agent/project.json', () => {
    const sandbox = make('node-ts');
    const project = MemoryStore.for(sandbox.root).getProject();

    assert.equal(project.language, 'TypeScript');
    assert.equal(project.framework, 'Express.js');
    assert.equal(project.testFramework, 'Vitest');
    assert.equal(project.root, sandbox.root);
    assert.ok(sandbox.exists('.agent/project.json'));
  });

  test('detects a Python/FastAPI project', () => {
    const sandbox = make('python');
    const project = MemoryStore.for(sandbox.root).getProject();
    assert.equal(project.language, 'Python');
    assert.equal(project.framework, 'FastAPI');
  });

  test('migrates a legacy .agent_memory.json', () => {
    const sandbox = make('node-ts', {
      '.agent_memory.json': JSON.stringify({
        language: 'TypeScript',
        architecture: 'Hexagonal',
        customRules: ['No default exports'],
      }),
    });

    const project = MemoryStore.for(sandbox.root).getProject();
    assert.equal(project.architecture, 'Hexagonal');
    assert.deepEqual(project.rules, ['No default exports']);
  });

  test('rules persist and reach the project directive', () => {
    const sandbox = make('node-ts');
    const store = MemoryStore.for(sandbox.root);

    store.addRule('Use Result types, never throw across module boundaries');
    store.addRule('Use Result types, never throw across module boundaries'); // duplicate ignored

    assert.equal(store.getProject().rules.length, 1);
    assert.match(store.projectDirective(), /Use Result types/);

    const onDisk = JSON.parse(sandbox.read('.agent/project.json'));
    assert.deepEqual(onDisk.rules, ['Use Result types, never throw across module boundaries']);
  });

  test('project memory never leaks between projects', () => {
    const a = make('node-ts');
    const b = make('node-ts');

    MemoryStore.for(a.root).addRule('Only in project A');

    assert.deepEqual(MemoryStore.for(b.root).getProject().rules, []);
    assert.doesNotMatch(MemoryStore.for(b.root).projectDirective(), /project A/);
  });

  describe('chat threads', () => {
    test('open, save and brief a thread', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const chat = store.openChat({ title: 'Auth refactor', goal: 'rotate refresh tokens' });
      assert.match(chat.chatId, /^chat-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/);
      assert.equal(chat.status, 'active');

      store.saveChat(chat.chatId, {
        summary: 'token service extracted',
        nextSteps: ['wire rotation into middleware'],
        decisions: ['store refresh tokens hashed'],
        openQuestions: ['grace period for old tokens?'],
        touchedFiles: ['src/auth/token.ts'],
      });

      const directive = store.chatDirective(chat.chatId);
      assert.match(directive, /Auth refactor/);
      assert.match(directive, /Goal: rotate refresh tokens/);
      assert.match(directive, /State: token service extracted/);
      assert.match(directive, /wire rotation into middleware/);
      assert.match(directive, /store refresh tokens hashed/);
      assert.match(directive, /src\/auth\/token\.ts/);
    });

    test('next steps are replaced while decisions accumulate', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Thread' });

      store.saveChat(chat.chatId, { nextSteps: ['step one'], decisions: ['decision one'] });
      const updated = store.saveChat(chat.chatId, { nextSteps: ['step two'], decisions: ['decision two'] });

      assert.deepEqual(updated.nextSteps, ['step two']);
      assert.deepEqual(updated.decisions, ['decision one', 'decision two']);
    });

    test('the active chat is the most recent non-closed thread', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const first = store.openChat({ title: 'First' });
      assert.equal(store.getActiveChatId(), first.chatId);

      const second = store.openChat({ title: 'Second' });
      assert.equal(store.getActiveChatId(), second.chatId);

      assert.equal(store.listChats(10).length, 2);
      assert.equal(store.listChats(10, 'active').length, 2);

      store.saveChat(second.chatId, { status: 'done' });
      assert.equal(store.listChats(10, 'done').length, 1);
    });

    test('events are recorded and capped', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Busy thread' });

      for (let i = 0; i < 60; i++) {
        store.appendChatEvent(chat.chatId, { kind: 'agent', text: `run ${i}` });
      }

      const stored = store.getChat(chat.chatId)!;
      assert.equal(stored.events.length, 40);
      assert.equal(stored.events.at(-1)!.text, 'run 59');
      assert.match(store.chatDirective(chat.chatId), /run 59/);
    });

    test('chats do not cross projects', () => {
      const a = make('node-ts');
      const b = make('node-ts');
      MemoryStore.for(a.root).openChat({ title: 'Only in A' });

      assert.equal(MemoryStore.for(b.root).listChats(10).length, 0);
      assert.equal(MemoryStore.for(b.root).getActiveChatId(), undefined);
    });
  });

  describe('sessions', () => {
    test('records round-trip and list newest first', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.saveSessionRecord('coder-1', { sessionId: 'coder-1', updatedAt: 1 });
      store.saveSessionRecord('coder-2', { sessionId: 'coder-2', updatedAt: 2 });

      const loaded = store.loadSessionRecord<{ sessionId: string }>('coder-2');
      assert.equal(loaded?.sessionId, 'coder-2');

      const all = store.listSessionRecords<{ sessionId: string; updatedAt: number }>();
      assert.deepEqual(all.map((s) => s.sessionId), ['coder-2', 'coder-1']);

      store.deleteSessionRecord('coder-1');
      assert.equal(store.listSessionRecords().length, 1);
    });

    test('linking a session to a chat is idempotent', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Linked' });

      store.linkSession(chat.chatId, 'coder-1');
      store.linkSession(chat.chatId, 'coder-1');

      assert.deepEqual(store.getChat(chat.chatId)!.sessionIds, ['coder-1']);
    });
  });

  test('the global index lists projects and stays out of $HOME', () => {
    const sandbox = make('node-ts');
    const store = MemoryStore.for(sandbox.root);
    const chat = store.openChat({ title: 'Indexed thread' });

    const projects = MemoryStore.listKnownProjects();
    const entry = projects.find((p) => p.root === sandbox.root);

    assert.ok(entry, 'project should appear in the machine-wide index');
    assert.equal(entry!.activeChatId, chat.chatId);
    assert.ok(fs.existsSync(path.join(state.dir, 'projects.json')));
  });

  test('state written by a previous process is read back', () => {
    const sandbox = make('node-ts');
    const store = MemoryStore.for(sandbox.root);
    const chat = store.openChat({ title: 'Persisted', goal: 'survive a restart' });
    store.saveChat(chat.chatId, { summary: 'half done' });

    // Simulate a fresh process: read straight off disk.
    const raw = JSON.parse(sandbox.read(`.agent/chats/${chat.chatId}.json`));
    assert.equal(raw.goal, 'survive a restart');
    assert.equal(raw.summary, 'half done');
  });
});
