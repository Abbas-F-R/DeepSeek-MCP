import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';
import { ensureDir } from '../workspace/WorkspaceContext.js';
import { readSection, todayIso, writeSection } from './format.js';

export type ChatStatus = 'active' | 'paused' | 'done';

export interface ChatEvent {
  at: string;
  kind: 'agent' | 'note' | 'decision' | 'file';
  text: string;
}

export interface Chat {
  chatId: string;
  title: string;
  goal?: string;
  status: ChatStatus;
  /** Where the work currently stands — overwritten on every save. */
  summary?: string;
  constraints: string[];
  decisions: string[];
  nextSteps: string[];
  openQuestions: string[];
  critical: string[];
  touchedFiles: string[];
  sessionIds: string[];
  events: ChatEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatPatch {
  title?: string;
  goal?: string;
  status?: ChatStatus;
  summary?: string;
  constraints?: string[];
  decisions?: string[];
  nextSteps?: string[];
  openQuestions?: string[];
  critical?: string[];
  touchedFiles?: string[];
}

/**
 * Soft caps. Nothing is dropped when a list crosses one — the curator is asked
 * to compact instead, so the content is summarized rather than silently lost.
 */
export const CHAT_SOFT_CAPS = {
  events: 30,
  decisions: 25,
  files: 40,
};

/**
 * The episodic layer: one markdown file per thread of work, holding what was
 * decided, what is next, and what happened. Recency is the primary retrieval
 * signal here, which is why threads are listed newest-first everywhere.
 */
export class ChatStore {
  private readonly dir: string;

  constructor(memoryDir: string) {
    this.dir = path.join(memoryDir, 'chats');
  }

  public newChatId(): string {
    return `chat-${todayIso()}-${crypto.randomBytes(2).toString('hex')}`;
  }

  private fileFor(chatId: string): string {
    return path.join(this.dir, `${chatId}.md`);
  }

  public exists(chatId: string): boolean {
    return fs.existsSync(this.fileFor(chatId));
  }

  public open(options: { chatId?: string; title?: string; goal?: string } = {}): Chat {
    const chatId = options.chatId?.trim() || this.newChatId();
    const existing = this.get(chatId);

    if (existing) {
      if (options.title) existing.title = options.title;
      if (options.goal) existing.goal = options.goal;
      if (existing.status === 'done') existing.status = 'active';
      this.write(existing);
      return existing;
    }

    const now = todayIso();
    const chat: Chat = {
      chatId,
      title: options.title?.trim() || chatId,
      goal: options.goal?.trim(),
      status: 'active',
      constraints: [],
      decisions: [],
      nextSteps: [],
      openQuestions: [],
      critical: [],
      touchedFiles: [],
      sessionIds: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.write(chat);
    return chat;
  }

  public get(chatId: string): Chat | undefined {
    const file = this.fileFor(chatId);
    if (!fs.existsSync(file)) return undefined;
    try {
      return parseChat(chatId, fs.readFileSync(file, 'utf-8'));
    } catch (err: any) {
      logger.warn(`[Memory] Could not parse chat '${chatId}': ${err.message}`);
      return undefined;
    }
  }

  public save(chatId: string, patch: ChatPatch): Chat {
    const chat = this.get(chatId) || this.open({ chatId });

    if (patch.title) chat.title = patch.title;
    if (patch.goal !== undefined) chat.goal = patch.goal;
    if (patch.status) chat.status = patch.status;
    if (patch.summary !== undefined) chat.summary = patch.summary;

    chat.constraints = appendUnique(chat.constraints, patch.constraints);
    chat.decisions = appendUnique(chat.decisions, patch.decisions);
    chat.critical = appendUnique(chat.critical, patch.critical);
    chat.openQuestions = appendUnique(chat.openQuestions, patch.openQuestions);
    chat.touchedFiles = appendUnique(chat.touchedFiles, patch.touchedFiles);

    // Next steps are a replacement list, not an append log — a completed step
    // that lingers is worse than no list at all.
    if (patch.nextSteps) {
      chat.nextSteps = patch.nextSteps.map((s) => s.trim()).filter(Boolean);
    }

    this.write(chat);
    return chat;
  }

  public appendEvent(chatId: string, event: Omit<ChatEvent, 'at'>): void {
    const chat = this.get(chatId);
    if (!chat) return;
    chat.events.push({ at: new Date().toISOString().slice(0, 16).replace('T', ' '), ...event });
    this.write(chat);
  }

  public linkSession(chatId: string, sessionId: string): void {
    const chat = this.get(chatId);
    if (!chat) return;
    if (chat.sessionIds.includes(sessionId)) return;
    chat.sessionIds.push(sessionId);
    this.write(chat);
  }

  public list(limit = 10, status?: ChatStatus): Chat[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this.get(f.replace(/\.md$/, '')))
      .filter((c): c is Chat => Boolean(c))
      .filter((c) => (status ? c.status === status : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /** Threads whose logs have outgrown the soft caps and should be compacted. */
  public needingCompaction(): Chat[] {
    return this.list(100).filter(
      (chat) => chat.events.length > CHAT_SOFT_CAPS.events || chat.decisions.length > CHAT_SOFT_CAPS.decisions
    );
  }

  public write(chat: Chat): void {
    chat.updatedAt = todayIso();
    ensureDir(this.dir);
    fs.writeFileSync(this.fileFor(chat.chatId), renderChat(chat), 'utf-8');
  }

  /** Compact "where we left off" brief, injected into subagent prompts. */
  public directive(chatId: string): string {
    const chat = this.get(chatId);
    if (!chat) return '';

    let text = `\n## Thread: ${chat.title} [${chat.status}] (${chat.chatId})\n`;
    if (chat.goal) text += `Goal: ${chat.goal}\n`;
    if (chat.constraints.length) {
      text += `Constraints:\n${chat.constraints.map((c) => `- ${c}`).join('\n')}\n`;
    }
    if (chat.summary) text += `State: ${chat.summary}\n`;
    if (chat.nextSteps.length) text += `Next:\n${chat.nextSteps.map((s) => `- ${s}`).join('\n')}\n`;
    if (chat.decisions.length) {
      text += `Decided:\n${chat.decisions.slice(-6).map((d) => `- ${d}`).join('\n')}\n`;
    }
    // Exact values a resumed run would otherwise guess at — never truncated.
    if (chat.critical.length) {
      text += `Critical:\n${chat.critical.map((c) => `- ${c}`).join('\n')}\n`;
    }
    if (chat.openQuestions.length) {
      text += `Open:\n${chat.openQuestions.slice(-4).map((q) => `- ${q}`).join('\n')}\n`;
    }
    if (chat.touchedFiles.length) text += `Files in play: ${chat.touchedFiles.slice(-12).join(', ')}\n`;
    return text;
  }
}

// ------------------------------------------------------------- rendering

function renderChat(chat: Chat): string {
  const lines: string[] = [
    `# ${chat.title}`,
    '',
    `id: ${chat.chatId}`,
    `status: ${chat.status}`,
  ];
  if (chat.goal) lines.push(`goal: ${chat.goal}`);
  lines.push(`created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`);
  if (chat.sessionIds.length) lines.push(`sessions: ${chat.sessionIds.join(', ')}`);
  lines.push('');

  // Section order mirrors the handoff template a resumed run reads top-down:
  // what limits the work, where it stands, what was settled, what is left.
  let doc = lines.join('\n');
  doc = writeSection(doc, 'Constraints', chat.constraints.map((c) => `- ${c}`).join('\n') || '_none_');
  doc = writeSection(doc, 'State', chat.summary || '_not recorded yet_');
  doc = writeSection(doc, 'Next', chat.nextSteps.map((s) => `- [ ] ${s}`).join('\n') || '_nothing queued_');
  doc = writeSection(doc, 'Decisions', chat.decisions.map((d) => `- ${d}`).join('\n') || '_none_');
  doc = writeSection(doc, 'Critical', chat.critical.map((c) => `- ${c}`).join('\n') || '_none_');
  doc = writeSection(doc, 'Open', chat.openQuestions.map((q) => `- ${q}`).join('\n') || '_none_');
  doc = writeSection(doc, 'Files', chat.touchedFiles.join('\n') || '_none_');
  doc = writeSection(doc, 'Log', chat.events.map((e) => `- ${e.at} [${e.kind}] ${e.text}`).join('\n') || '_empty_');
  return doc.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

const EVENT_LINE = /^-\s+(\S+(?:\s+[\d:]+)?)\s+\[(agent|note|decision|file)\]\s+(.*)$/;

function parseChat(chatId: string, doc: string): Chat {
  const header = (key: string): string | undefined => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(doc);
    return match ? match[1].trim() : undefined;
  };

  const titleMatch = /^#\s+(.+)$/m.exec(doc);
  const summary = cleanBody(readSection(doc, 'State'));

  return {
    chatId,
    title: titleMatch ? titleMatch[1].trim() : chatId,
    goal: header('goal'),
    status: (header('status') as ChatStatus) || 'active',
    summary: summary || undefined,
    constraints: bulletList(readSection(doc, 'Constraints')),
    nextSteps: bulletList(readSection(doc, 'Next')).map((s) => s.replace(/^\[[ xX]\]\s*/, '')),
    decisions: bulletList(readSection(doc, 'Decisions')),
    critical: bulletList(readSection(doc, 'Critical')),
    openQuestions: bulletList(readSection(doc, 'Open')),
    touchedFiles: plainList(readSection(doc, 'Files')),
    sessionIds: (header('sessions') || '').split(',').map((s) => s.trim()).filter(Boolean),
    events: readSection(doc, 'Log')
      .map((line) => EVENT_LINE.exec(line.trim()))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => ({ at: m[1], kind: m[2] as ChatEvent['kind'], text: m[3] })),
    createdAt: header('created') || todayIso(),
    updatedAt: header('updated') || todayIso(),
  };
}

function cleanBody(lines: string[]): string {
  const text = lines.join('\n').trim();
  return text === '_not recorded yet_' ? '' : text;
}

function bulletList(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && !line.startsWith('_'));
}

function plainList(lines: string[]): string[] {
  return lines
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .filter((line) => line && !line.startsWith('_'));
}

function appendUnique(existing: string[], added: string[] | undefined): string[] {
  if (!added || added.length === 0) return existing;
  const merged = [...existing];
  for (const item of added) {
    const value = item.trim();
    if (value && !merged.includes(value)) merged.push(value);
  }
  return merged;
}
