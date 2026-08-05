import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { ProviderRegistry } from '../providers/base/ProviderRegistry.js';
import { Chat, CHAT_SOFT_CAPS } from './Chats.js';
import { FactCandidate } from './Facts.js';
import { ENTRY_KINDS, EntryKind } from './format.js';

/**
 * The curator turns finished work into memory.
 *
 * It runs on DeepSeek, never on the orchestrating model: extraction and
 * compaction are bounded mechanical jobs, so they belong on the cheap model
 * while planning stays with the caller.
 *
 * The curator only ever *proposes* — every write goes through the deterministic
 * merge in FactsStore. A model that rewrites its own accumulated memory
 * collapses it, which is exactly the failure this split avoids.
 */

/** Answers shorter than this carry nothing worth remembering. */
const MIN_ANSWER_LENGTH = 120;
/** How much of an answer the extractor sees. Enough for the findings, not the essay. */
const MAX_ANSWER_CHARS = 6000;
const MAX_FACTS_PER_RUN = 8;

const EXTRACT_SYSTEM = `You extract durable engineering facts from a finished subagent report.

Output ONLY fact lines. One per line, no preamble, no numbering, no markdown:

FACT | kind | anchors | claim

- kind: one of ${ENTRY_KINDS.join(', ')}
- anchors: comma-separated file:line references taken from the report, or "-" when it cites none
- claim: one sentence, under 200 characters, stating something that stays true about this codebase

Rules:
- At most ${MAX_FACTS_PER_RUN} lines. Fewer is better. Zero is correct when the report found nothing durable.
- Only facts about the codebase: where something lives, how it is configured, what contract it exposes, what convention it follows, what trap it hides.
- Never record what the agent did, what it was asked, or how long it took.
- Never invent an anchor. Copy it from the report or write "-".
- Prefer the specific: "Kestrel binds 0.0.0.0:6777" beats "the server has a port".`;

const COMPACT_SYSTEM = `You compress an old activity log into a short paragraph.

Output ONLY the paragraph — no heading, no bullets, no preamble.
State what was done and what it led to, in at most 4 sentences.
Keep concrete identifiers: file names, endpoints, decisions.
Drop timestamps, tool names, and session ids.`;

/**
 * Compaction is a handoff to the next working-memory state, not compression in
 * the abstract. Fixed sections force the summary to carry what a resumed run
 * actually needs, instead of whatever the model found interesting.
 */
const TRANSCRIPT_SYSTEM = `You are writing the handoff note for a coding agent that is about to lose its earlier context.

Output exactly these sections, in this order, with no preamble:

## Goal
What the agent was asked to do.

## Constraints
Limits it must respect: versions, interfaces it may not break, instructions it was given.

## Progress
What it has established or changed so far. Cite file:line where the transcript does.

## Key decisions
Choices already made that must not be revisited.

## Next steps
What remains, most important first.

## Critical context
Exact values it would be wrong to guess again: paths, ports, names, signatures.

Rules:
- Write only what the transcript supports. Never invent a file, a value or a decision.
- Keep identifiers verbatim. A paraphrased path is worse than no path.
- Omit a section entirely if the transcript says nothing about it.
- Be terse. This is a working note, not a report.`;

export interface CuratorOptions {
  /** Overrides DEEPSEEK_CURATOR_MODEL; falls back to the default chat model. */
  model?: string;
  providerId?: string;
}

/** Whether auto-capture runs after each subagent turn. */
export function autoCaptureEnabled(): boolean {
  const flag = process.env.MEMORY_AUTOCAPTURE;
  if (flag === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(flag.toLowerCase());
}

function curatorModel(options: CuratorOptions): string {
  return options.model || process.env.DEEPSEEK_CURATOR_MODEL || config.deepseek.defaultChatModel;
}

/**
 * Pull candidate facts out of a completed subagent answer.
 *
 * Never throws: memory capture is a side effect of the real work, so a failure
 * here degrades the memory rather than the answer the caller is waiting on.
 */
export async function extractFacts(
  input: { task: string; answer: string; role: string },
  options: CuratorOptions = {}
): Promise<FactCandidate[]> {
  const answer = (input.answer || '').trim();
  if (answer.length < MIN_ANSWER_LENGTH) return [];
  if (answer.startsWith('[step limit reached')) return [];

  try {
    const provider = ProviderRegistry.getInstance().getProvider(options.providerId || config.orchestrator.defaultProvider);
    const response = await provider.chat(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        {
          role: 'user',
          content: `Task given to the ${input.role} subagent:\n${input.task.slice(0, 600)}\n\nIts report:\n${answer.slice(0, MAX_ANSWER_CHARS)}`,
        },
      ],
      { model: curatorModel(options), temperature: 0 }
    );

    const candidates = parseFactLines(response.content || '');
    logger.info(`[Curator] Extracted ${candidates.length} candidate fact(s) from ${input.role} run`);
    return candidates;
  } catch (err: any) {
    logger.warn(`[Curator] Fact extraction failed: ${err.message}`);
    return [];
  }
}

/** Parse the curator's line format. Malformed lines are skipped, not guessed at. */
export function parseFactLines(text: string): FactCandidate[] {
  const candidates: FactCandidate[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith('FACT')) continue;

    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 4) continue;

    const kindText = parts[1].toLowerCase();
    const kind: EntryKind = (ENTRY_KINDS as string[]).includes(kindText) ? (kindText as EntryKind) : 'gotcha';

    const anchorText = parts[2];
    const anchors =
      anchorText && anchorText !== '-' ? anchorText.split(',').map((a) => a.trim()).filter(Boolean) : [];

    // Rejoin the tail so a claim containing '|' survives.
    const claim = parts.slice(3).join(' | ').trim();
    if (!claim) continue;

    candidates.push({ text: claim, anchors, kind });
    if (candidates.length >= MAX_FACTS_PER_RUN) break;
  }

  return candidates;
}

export interface TranscriptCompaction {
  /** The handoff note, or undefined when the summary call failed. */
  summary?: string;
  /** Messages folded into the note. */
  foldedMessages: number;
}

/**
 * Summarize the older part of a subagent's transcript into a handoff note.
 *
 * Only the portion outside the protected tail is summarized — the recent turns
 * stay verbatim. Summarizing everything on every overflow is what produces the
 * cumulative information loss users report from repeatedly compacted sessions.
 */
export async function compactTranscript(
  older: Array<{ role: string; content: string }>,
  options: CuratorOptions = {}
): Promise<TranscriptCompaction> {
  if (older.length === 0) return { foldedMessages: 0 };

  const transcript = older
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n\n')
    // Keep the newest material when the transcript itself is too large to send.
    .slice(-40_000);

  try {
    const provider = ProviderRegistry.getInstance().getProvider(
      options.providerId || config.orchestrator.defaultProvider
    );
    const response = await provider.chat(
      [
        { role: 'system', content: TRANSCRIPT_SYSTEM },
        { role: 'user', content: transcript },
      ],
      { model: curatorModel(options), temperature: 0 }
    );

    const summary = (response.content || '').trim();
    if (!summary) return { foldedMessages: 0 };

    logger.info(`[Curator] Folded ${older.length} message(s) into a handoff note`);
    return { summary, foldedMessages: older.length };
  } catch (err: any) {
    logger.warn(`[Curator] Transcript compaction failed: ${err.message}`);
    return { foldedMessages: 0 };
  }
}

export interface CompactionResult {
  chatId: string;
  digest?: string;
  eventsBefore: number;
  eventsAfter: number;
  decisionsBefore: number;
  decisionsAfter: number;
}

/**
 * Compress a thread's history in place.
 *
 * Only the portion past the soft cap is summarized; recent entries stay
 * verbatim. Summarizing the whole log every time is how accumulated context
 * degrades into a generic paragraph.
 */
export async function compactChat(chat: Chat, options: CuratorOptions = {}): Promise<CompactionResult> {
  const result: CompactionResult = {
    chatId: chat.chatId,
    eventsBefore: chat.events.length,
    eventsAfter: chat.events.length,
    decisionsBefore: chat.decisions.length,
    decisionsAfter: chat.decisions.length,
  };

  const overflow = chat.events.length - CHAT_SOFT_CAPS.events;
  if (overflow <= 0 && chat.decisions.length <= CHAT_SOFT_CAPS.decisions) return result;

  if (overflow > 0) {
    const old = chat.events.slice(0, overflow);
    const kept = chat.events.slice(overflow);

    let digest = `${old.length} earlier steps`;
    try {
      const provider = ProviderRegistry.getInstance().getProvider(
        options.providerId || config.orchestrator.defaultProvider
      );
      const response = await provider.chat(
        [
          { role: 'system', content: COMPACT_SYSTEM },
          { role: 'user', content: old.map((e) => `- [${e.kind}] ${e.text}`).join('\n').slice(0, 6000) },
        ],
        { model: curatorModel(options), temperature: 0 }
      );
      const summary = (response.content || '').trim();
      if (summary) digest = summary;
    } catch (err: any) {
      logger.warn(`[Curator] Log compaction failed for ${chat.chatId}: ${err.message}`);
    }

    chat.events = [{ at: chat.updatedAt, kind: 'note', text: `(compacted) ${digest}` }, ...kept];
    result.digest = digest;
    result.eventsAfter = chat.events.length;
  }

  // Decisions are the record of intent — deduplicate rather than summarize, so
  // no individual decision is ever paraphrased away.
  if (chat.decisions.length > CHAT_SOFT_CAPS.decisions) {
    const seen = new Set<string>();
    chat.decisions = chat.decisions.filter((decision) => {
      const key = decision.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    result.decisionsAfter = chat.decisions.length;
  }

  return result;
}
