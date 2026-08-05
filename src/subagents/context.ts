import { SubagentMessage } from './types.js';

/**
 * Context shaping for a subagent's own message history.
 *
 * Ordered cheapest-first, the way production coding agents do it: cap oversized
 * tool results, then prune old ones, and only pay for a model-generated summary
 * when neither freed enough. Every layer that runs before the summary is one
 * that costs nothing but arithmetic.
 *
 * The layer this replaces kept the last 16 messages by *count*. A single file
 * read is capped at 80k characters, so sixteen of them is a ~320k-token request
 * — far past any usable context window.
 */

/**
 * Characters per token. Deliberately low: code tokenizes denser than prose, and
 * an overestimate makes the pipeline shape early, while an underestimate lets a
 * request blow the window.
 */
const CHARS_PER_TOKEN = 3.5;

/** A single tool result may not occupy more than this before it is summarized. */
export const MAX_TOOL_RESULT_TOKENS = 6_000;

/** Turns kept whole no matter what — the agent is still working with them. */
export const PROTECTED_TURNS = 2;

/**
 * Messages that survive a fold verbatim. Everything older becomes one handoff
 * note; these stay exactly as they were, so the agent never loses the turn it
 * is in the middle of.
 */
export const KEEP_VERBATIM_MESSAGES = 6;

/** Pruning is pointless below this much tool output in total. */
export const PRUNE_ABOVE_TOKENS = 40_000;

/** And not worth the loss unless it reclaims at least this much. */
export const MIN_RECLAIM_TOKENS = 20_000;

/** Room held back for the model's own output before the window is "full". */
export const OUTPUT_RESERVE_TOKENS = 20_000;

/**
 * Fraction of the usable window at which we compact. Below the 95% that a
 * naive implementation would pick: waiting for the cliff means compaction
 * lands mid-task, which is where quality loss shows up.
 */
export const COMPACT_AT = 0.85;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function totalTokens(messages: SubagentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/** Tool results are pushed as `[tool <name>]\n<result>` by the run loop. */
const TOOL_MESSAGE = /^\[tool ([a-z_]+)\]\n?([\s\S]*)$/;

export interface ToolMessage {
  name: string;
  body: string;
}

export function asToolMessage(message: SubagentMessage): ToolMessage | undefined {
  if (message.role !== 'user') return undefined;
  const match = TOOL_MESSAGE.exec(message.content);
  return match ? { name: match[1], body: match[2] } : undefined;
}

function describe(body: string): string {
  const lines = body.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'}, ~${estimateTokens(body).toLocaleString()} tokens`;
}

export interface ShapeResult {
  messages: SubagentMessage[];
  /** Tokens freed by this layer. */
  freed: number;
  /** How many messages the layer rewrote. */
  changed: number;
}

// ------------------------------------------------------------- layer 1

/**
 * Cap any single tool result.
 *
 * The head and tail are kept: the head carries the structure of a file or a
 * listing, the tail usually carries the part the agent was reading toward.
 * Everything between them becomes a marker that says what was dropped, so the
 * model knows the result was trimmed rather than empty.
 */
export function applyToolResultBudget(
  messages: SubagentMessage[],
  limit = MAX_TOOL_RESULT_TOKENS
): ShapeResult {
  const budget = limit * CHARS_PER_TOKEN;
  let freed = 0;
  let changed = 0;

  const shaped = messages.map((message) => {
    const tool = asToolMessage(message);
    if (!tool || tool.body.length <= budget) return message;

    const head = Math.floor(budget * 0.6);
    const tail = Math.floor(budget * 0.4);
    const dropped = tool.body.length - head - tail;

    const content =
      `[tool ${tool.name}]\n` +
      tool.body.slice(0, head) +
      `\n\n...[${describe(tool.body.slice(head, tool.body.length - tail))} trimmed to fit the context window; ` +
      `re-read a narrower range if you need what is missing]...\n\n` +
      tool.body.slice(tool.body.length - tail);

    freed += Math.ceil(dropped / CHARS_PER_TOKEN);
    changed++;
    return { ...message, content };
  });

  return { messages: shaped, freed, changed };
}

// ------------------------------------------------------------- layer 2

/**
 * Replace old tool results with a reference to what they were.
 *
 * Only fires when there is enough tool output to be worth it and enough to
 * reclaim — pruning a little costs the agent recall for no real gain. Recent
 * turns are never touched: that is what the agent is actively reasoning over.
 */
export function pruneToolOutputs(
  messages: SubagentMessage[],
  options: { protectedTurns?: number; pruneAbove?: number; minReclaim?: number } = {}
): ShapeResult {
  const protectedTurns = options.protectedTurns ?? PROTECTED_TURNS;
  const pruneAbove = options.pruneAbove ?? PRUNE_ABOVE_TOKENS;
  const minReclaim = options.minReclaim ?? MIN_RECLAIM_TOKENS;

  const toolIndexes: number[] = [];
  let toolTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const tool = asToolMessage(messages[i]);
    if (!tool) continue;
    toolIndexes.push(i);
    toolTokens += estimateTokens(tool.body);
  }

  if (toolTokens <= pruneAbove) return { messages, freed: 0, changed: 0 };

  // Walk backwards so the protected window is counted from the newest turn.
  const protectedIndexes = new Set(toolIndexes.slice(-protectedTurns));
  const candidates = toolIndexes.filter((i) => !protectedIndexes.has(i));

  const reclaimable = candidates.reduce(
    (sum, i) => sum + estimateTokens(asToolMessage(messages[i])!.body),
    0
  );
  if (reclaimable < minReclaim) return { messages, freed: 0, changed: 0 };

  const targets = new Set(candidates);
  let freed = 0;
  let changed = 0;

  const shaped = messages.map((message, i) => {
    if (!targets.has(i)) return message;
    const tool = asToolMessage(message)!;
    // Keep the record that the call happened and what it returned in outline;
    // the agent can call it again if it turns out to matter.
    const content = `[tool ${tool.name}] [pruned — returned ${describe(tool.body)}; call it again if you need this]`;
    freed += estimateTokens(tool.body) - estimateTokens(content);
    changed++;
    return { ...message, content };
  });

  return { messages: shaped, freed, changed };
}

// ------------------------------------------------------------- layer 3

export interface WindowBudget {
  /** The model's total context window, in tokens. */
  contextWindow: number;
  /** Held back for the response. */
  outputReserve?: number;
}

/** Tokens available for history after reserving room to answer. */
export function usableWindow(budget: WindowBudget): number {
  return Math.max(1, budget.contextWindow - (budget.outputReserve ?? OUTPUT_RESERVE_TOKENS));
}

/** True once history no longer fits at all. */
export function isOverflow(messages: SubagentMessage[], budget: WindowBudget): boolean {
  return totalTokens(messages) > usableWindow(budget);
}

/** True at the point where compaction should happen — before the cliff, not at it. */
export function needsCompaction(messages: SubagentMessage[], budget: WindowBudget): boolean {
  return totalTokens(messages) > usableWindow(budget) * COMPACT_AT;
}

// --------------------------------------------------------------- pipeline

export interface PipelineReport {
  before: number;
  after: number;
  budgetFreed: number;
  pruneFreed: number;
  /** True when the cheap layers did not free enough and a summary is required. */
  needsSummary: boolean;
}

/**
 * Run the cheap shapers in order and report whether a summary is still needed.
 *
 * Returns the messages to send. The caller persists them, so work done here is
 * not repeated on the next turn.
 */
export function shapeContext(
  messages: SubagentMessage[],
  budget: WindowBudget
): { messages: SubagentMessage[]; report: PipelineReport } {
  const before = totalTokens(messages);

  if (!needsCompaction(messages, budget)) {
    return {
      messages,
      report: { before, after: before, budgetFreed: 0, pruneFreed: 0, needsSummary: false },
    };
  }

  const budgeted = applyToolResultBudget(messages);
  let current = budgeted.messages;

  let pruneFreed = 0;
  if (needsCompaction(current, budget)) {
    const pruned = pruneToolOutputs(current);
    current = pruned.messages;
    pruneFreed = pruned.freed;
  }

  const after = totalTokens(current);
  return {
    messages: current,
    report: {
      before,
      after,
      budgetFreed: budgeted.freed,
      pruneFreed,
      needsSummary: needsCompaction(current, budget),
    },
  };
}
