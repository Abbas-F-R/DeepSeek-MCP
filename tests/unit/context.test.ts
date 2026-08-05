import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_RESULT_TOKENS,
  applyToolResultBudget,
  estimateTokens,
  isOverflow,
  needsCompaction,
  pruneToolOutputs,
  shapeContext,
  totalTokens,
} from '../../src/subagents/context.js';
import { SubagentMessage } from '../../src/subagents/types.js';

const now = Date.now();

/** A tool result of roughly `tokens` size, in the shape the run loop pushes. */
const toolMessage = (name: string, tokens: number, marker = 'x'): SubagentMessage => ({
  role: 'user',
  content: `[tool ${name}]\n${marker.repeat(Math.round(tokens * 3.5))}`,
  timestamp: now,
});

const say = (role: SubagentMessage['role'], content: string): SubagentMessage => ({ role, content, timestamp: now });

describe('token budget for tool results', () => {
  test('an oversized result is trimmed but keeps its head and tail', () => {
    const head = 'FIRST-LINE-MATTERS';
    const tail = 'LAST-LINE-MATTERS';
    const huge: SubagentMessage = {
      role: 'user',
      content: `[tool read_file]\n${head}${'m'.repeat(200_000)}${tail}`,
      timestamp: now,
    };

    const { messages, freed, changed } = applyToolResultBudget([huge]);

    assert.equal(changed, 1);
    assert.ok(freed > 0);
    assert.ok(messages[0].content.includes(head), 'the head of the result survives');
    assert.ok(messages[0].content.includes(tail), 'so does the tail');
    assert.match(messages[0].content, /trimmed to fit the context window/);
    assert.match(messages[0].content, /^\[tool read_file\]/, 'the tool name is preserved');
    assert.ok(estimateTokens(messages[0].content) < MAX_TOOL_RESULT_TOKENS * 1.3);
  });

  test('a result already within budget is left untouched', () => {
    const small = toolMessage('search_files', 100);
    const { messages, changed } = applyToolResultBudget([small]);

    assert.equal(changed, 0);
    assert.equal(messages[0].content, small.content);
  });

  test('assistant and user turns are never treated as tool output', () => {
    const chatter = [say('assistant', 'z'.repeat(200_000)), say('user', 'q'.repeat(200_000))];
    const { changed } = applyToolResultBudget(chatter);
    assert.equal(changed, 0);
  });
});

describe('pruning old tool output', () => {
  test('nothing is pruned below the activation threshold', () => {
    const messages = [toolMessage('read_file', 5_000), toolMessage('read_file', 5_000)];
    const { freed, changed } = pruneToolOutputs(messages);

    assert.equal(freed, 0);
    assert.equal(changed, 0);
  });

  test('the most recent tool turns are protected', () => {
    const messages = [
      toolMessage('read_file', 20_000, 'a'),
      toolMessage('read_file', 20_000, 'b'),
      toolMessage('read_file', 20_000, 'c'),
      toolMessage('read_file', 20_000, 'd'),
    ];

    const { messages: pruned, changed } = pruneToolOutputs(messages);

    assert.equal(changed, 2, 'only the two oldest of four are eligible');
    assert.match(pruned[0].content, /pruned/);
    assert.match(pruned[1].content, /pruned/);
    assert.ok(pruned[2].content.includes('ccc'), 'the second-newest survives whole');
    assert.ok(pruned[3].content.includes('ddd'), 'and so does the newest');
  });

  test('a pruned result still records what the call returned', () => {
    const messages = [
      toolMessage('search_files', 30_000),
      toolMessage('read_file', 30_000),
      toolMessage('read_file', 1_000),
      toolMessage('read_file', 1_000),
    ];

    const { messages: pruned } = pruneToolOutputs(messages);
    assert.match(pruned[0].content, /^\[tool search_files\] \[pruned — returned \d+ lines?, ~[\d,]+ tokens/);
    assert.match(pruned[0].content, /call it again if you need this/);
  });

  test('pruning is skipped when it would reclaim too little to be worth the loss', () => {
    // Over the 40k activation threshold, but everything eligible is tiny.
    const messages = [
      toolMessage('read_file', 1_000),
      toolMessage('read_file', 1_000),
      toolMessage('read_file', 25_000),
      toolMessage('read_file', 25_000),
    ];

    const { changed } = pruneToolOutputs(messages);
    assert.equal(changed, 0, 'the bulk sits inside the protected window');
  });
});

describe('overflow detection', () => {
  const budget = { contextWindow: 128_000 };

  test('a small history triggers nothing', () => {
    const messages = [say('system', 'prompt'), toolMessage('read_file', 1_000)];
    assert.equal(needsCompaction(messages, budget), false);
    assert.equal(isOverflow(messages, budget), false);
  });

  test('compaction is due before the window is actually full', () => {
    // 95k of a 108k usable window: past the 85% mark, not yet overflowing.
    const messages = [toolMessage('read_file', 95_000)];
    assert.equal(needsCompaction(messages, budget), true);
    assert.equal(isOverflow(messages, budget), false);
  });
});

describe('the full pipeline', () => {
  const budget = { contextWindow: 128_000 };

  test('a history that fits is passed through untouched', () => {
    const messages = [say('system', 'prompt'), toolMessage('read_file', 2_000), say('assistant', 'ok')];
    const { messages: shaped, report } = shapeContext(messages, budget);

    assert.equal(report.before, report.after);
    assert.equal(report.needsSummary, false);
    assert.deepEqual(shaped, messages);
  });

  test('sixteen large file reads no longer blow the request', () => {
    // The exact shape the old message-count trim allowed through: sixteen reads
    // at the 80k-character tool cap is a ~320k-token request.
    const messages: SubagentMessage[] = [say('system', 'prompt')];
    for (let i = 0; i < 16; i++) {
      messages.push(say('assistant', 'calling read_file'), toolMessage('read_file', 22_000, String.fromCharCode(97 + i)));
    }

    const before = totalTokens(messages);
    assert.ok(before > 300_000, `precondition: the unshaped history is ${before} tokens`);

    const { messages: shaped, report } = shapeContext(messages, budget);
    const after = totalTokens(shaped);

    assert.ok(after < before / 4, `shaping should cut this by more than 4x, got ${before} -> ${after}`);
    assert.ok(report.budgetFreed > 0, 'the budget layer does the bulk of the work');
    assert.ok(shaped.some((m) => m.content.includes('trimmed to fit')), 'trimmed results say so');
  });

  test('a summary is only requested once the cheap layers fall short', () => {
    // A single unprunable assistant turn: no tool output for the cheap layers
    // to reclaim, so the pipeline has to escalate.
    const messages = [say('system', 'prompt'), say('assistant', 'w'.repeat(500_000))];
    const { report } = shapeContext(messages, budget);

    assert.equal(report.budgetFreed, 0);
    assert.equal(report.pruneFreed, 0);
    assert.equal(report.needsSummary, true);
  });
});
