import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';
import { ensureDir } from '../workspace/WorkspaceContext.js';
import { SubagentMessage, SubagentSession } from '../subagents/types.js';

/**
 * Subagent transcripts, stored as plain text.
 *
 * Unlike facts and chats these are machinery, not memory — nothing reads them
 * back into a prompt except a resume. They still need an exact round-trip, so
 * the format is delimiter-based with escaping rather than prose.
 */

const RECORD_SEPARATOR = '=== ';
const HEADER_KEYS = [
  'id',
  'root',
  'slug',
  'chat',
  'role',
  'persona',
  'status',
  'steps',
  'tools',
  'files',
  'lastTask',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'elapsedMs',
  'created',
  'updated',
] as const;

/** Sessions older than this are pruned; transcripts are debugging aids, not history. */
const MAX_SESSION_AGE_DAYS = 14;
const MAX_SESSIONS_KEPT = 40;

export class SessionStore {
  private readonly dir: string;

  constructor(memoryDir: string) {
    this.dir = path.join(memoryDir, 'sessions');
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.txt`);
  }

  public save(session: SubagentSession): void {
    ensureDir(this.dir);
    try {
      fs.writeFileSync(this.fileFor(session.sessionId), renderSession(session), 'utf-8');
    } catch (err: any) {
      logger.warn(`[Memory] Could not write session '${session.sessionId}': ${err.message}`);
    }
  }

  public load(sessionId: string): SubagentSession | undefined {
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file)) return undefined;
    try {
      return parseSession(fs.readFileSync(file, 'utf-8'));
    } catch (err: any) {
      logger.warn(`[Memory] Could not parse session '${sessionId}': ${err.message}`);
      return undefined;
    }
  }

  public list(): SubagentSession[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => this.load(f.replace(/\.txt$/, '')))
      .filter((s): s is SubagentSession => Boolean(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public delete(sessionId: string): void {
    const file = this.fileFor(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /**
   * Drop transcripts that are too old or too many. Facts extracted from a run
   * outlive it, so the raw transcript is safe to discard.
   */
  public prune(): number {
    const sessions = this.list();
    const cutoff = Date.now() - MAX_SESSION_AGE_DAYS * 86_400_000;
    let removed = 0;

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const tooOld = session.updatedAt < cutoff;
      const tooMany = i >= MAX_SESSIONS_KEPT;
      if ((tooOld || tooMany) && session.status !== 'active') {
        this.delete(session.sessionId);
        removed++;
      }
    }

    if (removed > 0) logger.info(`[Memory] Pruned ${removed} old session transcript(s)`);
    return removed;
  }
}

// ------------------------------------------------------------- rendering

/** Protect content lines that would otherwise look like a delimiter. */
function escapeBody(text: string): string {
  return text.replace(/^(\\*===)/gm, '\\$1');
}

function unescapeBody(text: string): string {
  return text.replace(/^\\(\\*===)/gm, '$1');
}

function renderSession(session: SubagentSession): string {
  const header = [
    `id: ${session.sessionId}`,
    `root: ${session.projectRoot}`,
    `slug: ${session.projectSlug}`,
    session.chatId ? `chat: ${session.chatId}` : '',
    `role: ${session.role}`,
    `persona: ${session.personaName}`,
    `status: ${session.status}`,
    `steps: ${session.stepCount}`,
    `tools: ${session.allowedTools.join(',')}`,
    `files: ${session.touchedFiles.join(',')}`,
    session.lastTask ? `lastTask: ${session.lastTask.replace(/\n/g, ' ')}` : '',
    `promptTokens: ${session.usage.promptTokens}`,
    `completionTokens: ${session.usage.completionTokens}`,
    `totalTokens: ${session.usage.totalTokens}`,
    `elapsedMs: ${session.totalExecutionTimeMs}`,
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
  ].filter(Boolean);

  const body = session.messages
    .map((m) => `${RECORD_SEPARATOR}${m.role} ${m.timestamp}\n${escapeBody(m.content)}`)
    .join('\n');

  return `${header.join('\n')}\n${body}\n`;
}

const MESSAGE_HEADER = /^=== (system|user|assistant) (\d+)$/;

function parseSession(text: string): SubagentSession {
  const lines = text.split('\n');
  const header = new Map<string, string>();
  let i = 0;

  for (; i < lines.length; i++) {
    if (MESSAGE_HEADER.test(lines[i])) break;
    const match = /^([a-zA-Z]+):\s*(.*)$/.exec(lines[i]);
    if (match && (HEADER_KEYS as readonly string[]).includes(match[1])) header.set(match[1], match[2]);
  }

  const messages: SubagentMessage[] = [];
  let current: { role: SubagentMessage['role']; timestamp: number; body: string[] } | undefined;

  for (; i < lines.length; i++) {
    const match = MESSAGE_HEADER.exec(lines[i]);
    if (match) {
      if (current) {
        messages.push({ role: current.role, timestamp: current.timestamp, content: finishBody(current.body) });
      }
      current = { role: match[1] as SubagentMessage['role'], timestamp: parseInt(match[2], 10), body: [] };
      continue;
    }
    if (current) current.body.push(lines[i]);
  }
  if (current) {
    messages.push({ role: current.role, timestamp: current.timestamp, content: finishBody(current.body) });
  }

  const num = (key: string): number => parseInt(header.get(key) || '0', 10) || 0;
  const csv = (key: string): string[] => (header.get(key) || '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    sessionId: header.get('id') || '',
    projectRoot: header.get('root') || '',
    projectSlug: header.get('slug') || '',
    chatId: header.get('chat') || undefined,
    role: header.get('role') || 'general',
    personaName: header.get('persona') || 'Subagent',
    systemPrompt: messages.find((m) => m.role === 'system')?.content || '',
    allowedTools: csv('tools') as SubagentSession['allowedTools'],
    status: (header.get('status') as SubagentSession['status']) || 'completed',
    stepCount: num('steps'),
    totalExecutionTimeMs: num('elapsedMs'),
    usage: {
      promptTokens: num('promptTokens'),
      completionTokens: num('completionTokens'),
      totalTokens: num('totalTokens'),
    },
    touchedFiles: csv('files'),
    lastTask: header.get('lastTask'),
    createdAt: num('created'),
    updatedAt: num('updated'),
    messages,
  };
}

function finishBody(lines: string[]): string {
  // The renderer puts a newline between the last message and EOF; drop it.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return unescapeBody(lines.join('\n'));
}
