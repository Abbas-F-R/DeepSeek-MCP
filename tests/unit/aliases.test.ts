import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStateDir } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;

const { ALL_TOOLS, TOOL_ALIASES, resolveToolCall } = await import('../../src/tools/index.js');

describe('tool surface', () => {
  after(() => state.cleanup());

  test('exactly seven tools are advertised', () => {
    assert.deepEqual(
      ALL_TOOLS.map((t) => t.name).sort(),
      ['agent', 'agent_control', 'analyze', 'generate', 'memory', 'orchestrate', 'review']
    );
  });

  test('every tool has a description and an object schema', () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.inputSchema.properties, `${tool.name} needs properties`);
    }
  });

  test('the advertised schema payload stays small', () => {
    const bytes = JSON.stringify(
      ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    ).length;
    // Schemas are resent on every request; this guards against schema creep.
    assert.ok(bytes < 15_000, `tool schema payload grew to ${bytes} chars`);
  });

  test('every alias points at a real tool', () => {
    for (const [legacy, alias] of Object.entries(TOOL_ALIASES)) {
      assert.ok(ALL_TOOLS.some((t) => t.name === alias.tool), `alias '${legacy}' targets unknown tool '${alias.tool}'`);
    }
  });

  test('no alias shadows an advertised tool name', () => {
    for (const legacy of Object.keys(TOOL_ALIASES)) {
      assert.ok(!ALL_TOOLS.some((t) => t.name === legacy), `alias '${legacy}' collides with a real tool`);
    }
  });
});

describe('resolveToolCall', () => {
  after(() => state.cleanup());

  test('passes through a direct call untouched', () => {
    const resolved = resolveToolCall('agent', { task: 'do it', role: 'coder' });
    assert.equal(resolved?.tool.name, 'agent');
    assert.deepEqual(resolved?.args, { task: 'do it', role: 'coder' });
  });

  test('returns undefined for an unknown tool', () => {
    assert.equal(resolveToolCall('nope', {}), undefined);
  });

  test('maps subagent roles and the legacy session_id key', () => {
    const resolved = resolveToolCall('subagent_coder', { task: 'refactor', session_id: 'coder-1' });
    assert.equal(resolved?.tool.name, 'agent');
    assert.equal(resolved?.args.role, 'coder');
    assert.equal(resolved?.args.session, 'coder-1');
    assert.equal(resolved?.args.task, 'refactor');
  });

  test('maps every legacy subagent role', () => {
    for (const role of ['explore', 'scout', 'general', 'coder', 'security', 'sql', 'custom']) {
      const resolved = resolveToolCall(`subagent_${role}`, { task: 't' });
      assert.equal(resolved?.tool.name, 'agent');
      assert.equal(resolved?.args.role, role);
    }
  });

  test('maps subagent control actions', () => {
    assert.equal(resolveToolCall('subagent_list', {})?.args.action, 'list');
    assert.equal(resolveToolCall('subagent_stop', { session_id: 'x' })?.args.action, 'stop');
    assert.equal(resolveToolCall('subagent_stop', { session_id: 'x' })?.args.session, 'x');
    assert.equal(resolveToolCall('subagent_create', { role: 'perf' })?.args.action, 'persona');
  });

  test('translates the old memory action vocabulary', () => {
    const view = resolveToolCall('subagent_memory', { action: 'view' });
    assert.equal(view?.tool.name, 'memory');
    assert.equal(view?.args.action, 'brief');

    const addRule = resolveToolCall('subagent_memory', { action: 'add_rule', custom_rule: 'No var' });
    assert.equal(addRule?.args.action, 'rule');
    assert.equal(addRule?.args.rule, 'No var');
  });

  test('maps review aliases and their content keys', () => {
    const cases: Array<[string, string, string]> = [
      ['review_code', 'code', 'code'],
      ['review_folder', 'folder', 'folder_content'],
      ['review_project', 'project', 'project_summary'],
      ['review_sql', 'sql', 'sql_content'],
      ['review_architecture', 'architecture', 'architecture_description'],
      ['review_security', 'security', 'code_or_config'],
      ['review_performance', 'performance', 'code'],
      ['refactor_code', 'refactor', 'code'],
    ];

    for (const [legacy, kind, contentKey] of cases) {
      const resolved = resolveToolCall(legacy, { [contentKey]: 'PAYLOAD' });
      assert.equal(resolved?.tool.name, 'review', legacy);
      assert.equal(resolved?.args.kind, kind, legacy);
      assert.equal(resolved?.args.content, 'PAYLOAD', legacy);
    }
  });

  test('maps generation aliases onto spec', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['generate_code', 'code', { spec: 'S' }],
      ['generate_files', 'files', { spec: 'S' }],
      ['generate_sql', 'sql', { spec: 'S' }],
      ['generate_tests', 'tests', { spec: 'S' }],
      ['generate_documentation', 'docs', { spec: 'S' }],
      ['generate_project', 'project', { spec: 'S' }],
      ['generate_seed', 'seed', { schema: 'S' }],
      ['write_tests', 'tests_inline', { code: 'S' }],
    ];

    for (const [legacy, kind, args] of cases) {
      const resolved = resolveToolCall(legacy, args);
      assert.equal(resolved?.tool.name, 'generate', legacy);
      assert.equal(resolved?.args.kind, kind, legacy);
      assert.equal(resolved?.args.spec, 'S', legacy);
    }
  });

  test('maps analysis aliases', () => {
    assert.equal(resolveToolCall('explain_code', { code: 'X' })?.args.kind, 'explain');
    assert.equal(resolveToolCall('summarize', { text: 'X' })?.args.content, 'X');
    assert.equal(resolveToolCall('documentation', { code: 'X' })?.args.kind, 'document');
    assert.equal(resolveToolCall('analyze_repository', { repository_tree: 'X' })?.args.kind, 'repo');
  });

  test('an explicit argument never overrides the alias discriminator', () => {
    const resolved = resolveToolCall('subagent_explore', { task: 't', role: 'coder' });
    assert.equal(resolved?.args.role, 'explore', 'alias role must win over a stray role argument');
  });
});
