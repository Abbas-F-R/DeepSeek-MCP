import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';
import { detectStack } from './StackDetector.js';
import {
  GLOBAL_STATE_DIR,
  WorkspaceRef,
  ensureDir,
  projectStateDir,
  resolveWorkspace,
} from '../workspace/WorkspaceContext.js';

export interface ProjectMemory {
  slug: string;
  name: string;
  root: string;
  language?: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  architecture?: string;
  codingStyle?: string;
  namingConvention?: string;
  rules: string[];
  lastScan: string;
}

export type ChatStatus = 'active' | 'paused' | 'done';

export interface ChatEvent {
  at: string;
  kind: 'agent' | 'note' | 'decision' | 'file';
  text: string;
}

export interface ChatState {
  chatId: string;
  projectSlug: string;
  projectRoot: string;
  title: string;
  goal?: string;
  status: ChatStatus;
  /** Where we currently stand — overwritten on every save. */
  summary?: string;
  decisions: string[];
  nextSteps: string[];
  openQuestions: string[];
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
  decisions?: string[];
  nextSteps?: string[];
  openQuestions?: string[];
  touchedFiles?: string[];
}

interface GlobalIndexEntry {
  slug: string;
  name: string;
  root: string;
  activeChatId?: string;
  lastChatTitle?: string;
  updatedAt: string;
}

const MAX_EVENTS = 40;
const MAX_LIST_ITEMS = 20;
const LEGACY_MEMORY_FILE = '.agent_memory.json';

const stores = new Map<string, MemoryStore>();

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err: any) {
    logger.warn(`[Memory] Corrupt JSON at '${file}': ${err.message}`);
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function uniqTail(existing: string[], added: string[] | undefined, max = MAX_LIST_ITEMS): string[] {
  if (!added || added.length === 0) return existing;
  const merged = [...existing];
  for (const item of added) {
    const value = item.trim();
    if (value && !merged.includes(value)) merged.push(value);
  }
  return merged.slice(-max);
}

/**
 * Per-project persistent memory: stack facts, quality rules, chat threads and
 * subagent session transcripts. Everything lives inside the project itself
 * (`<root>/.agent/`), so it travels with the repo and can never leak between
 * projects. A small global index in ~/.deepseek-mcp maps slugs back to roots.
 */
export class MemoryStore {
  private readonly workspace: WorkspaceRef;
  private readonly stateDir: string;
  private project: ProjectMemory;

  private constructor(workspace: WorkspaceRef) {
    this.workspace = workspace;
    this.stateDir = projectStateDir(workspace.root);
    this.project = this.loadOrDetectProject();
  }

  public static for(root?: string): MemoryStore {
    const workspace = resolveWorkspace(root);
    const cached = stores.get(workspace.root);
    if (cached) return cached;
    const store = new MemoryStore(workspace);
    stores.set(workspace.root, store);
    return store;
  }

  public get ref(): WorkspaceRef {
    return this.workspace;
  }

  // ---------------------------------------------------------------- project

  private get projectFile(): string {
    return path.join(this.stateDir, 'project.json');
  }

  private loadOrDetectProject(): ProjectMemory {
    const existing = readJson<ProjectMemory>(this.projectFile);
    if (existing) {
      // Root may have moved (repo cloned elsewhere) — always trust the live path.
      existing.root = this.workspace.root;
      existing.slug = this.workspace.slug;
      existing.rules = existing.rules || [];
      return existing;
    }

    const stack = detectStack(this.workspace.root);
    const project: ProjectMemory = {
      slug: this.workspace.slug,
      name: this.workspace.name,
      root: this.workspace.root,
      ...stack,
      rules: [],
      lastScan: new Date().toISOString(),
    };

    // Migrate the pre-1.1 single-file memory format if present.
    const legacy = readJson<any>(path.join(this.workspace.root, LEGACY_MEMORY_FILE));
    if (legacy) {
      project.language = legacy.language || project.language;
      project.framework = legacy.framework || project.framework;
      project.architecture = legacy.architecture || project.architecture;
      project.codingStyle = legacy.codingStyle || project.codingStyle;
      project.namingConvention = legacy.namingConvention || project.namingConvention;
      project.rules = Array.isArray(legacy.customRules) ? legacy.customRules : [];
      logger.info(`[Memory] Migrated legacy ${LEGACY_MEMORY_FILE} for '${this.workspace.name}'`);
    }

    this.project = project;
    this.saveProject();
    return project;
  }

  public getProject(): ProjectMemory {
    return this.project;
  }

  public saveProject(): void {
    this.project.lastScan = new Date().toISOString();
    writeJson(this.projectFile, this.project);
    this.touchGlobalIndex();
  }

  public rescan(): ProjectMemory {
    const stack = detectStack(this.workspace.root);
    this.project = { ...this.project, ...stack };
    this.saveProject();
    return this.project;
  }

  public addRule(rule: string): void {
    const value = rule.trim();
    if (!value) return;
    if (!this.project.rules.includes(value)) this.project.rules.push(value);
    this.saveProject();
  }

  public setFields(patch: Partial<Omit<ProjectMemory, 'slug' | 'root' | 'rules'>>): void {
    this.project = { ...this.project, ...patch };
    this.saveProject();
  }

  // ------------------------------------------------------------------ chats

  private get chatsDir(): string {
    return path.join(this.stateDir, 'chats');
  }

  private chatFile(chatId: string): string {
    return path.join(this.chatsDir, `${chatId}.json`);
  }

  public newChatId(): string {
    const date = new Date().toISOString().slice(0, 10);
    return `chat-${date}-${crypto.randomBytes(2).toString('hex')}`;
  }

  public openChat(options: { chatId?: string; title?: string; goal?: string } = {}): ChatState {
    const chatId = options.chatId?.trim() || this.newChatId();
    const existing = this.getChat(chatId);

    if (existing) {
      if (options.title) existing.title = options.title;
      if (options.goal) existing.goal = options.goal;
      existing.status = existing.status === 'done' ? 'active' : existing.status;
      return this.persistChat(existing);
    }

    const now = new Date().toISOString();
    const chat: ChatState = {
      chatId,
      projectSlug: this.project.slug,
      projectRoot: this.workspace.root,
      title: options.title?.trim() || chatId,
      goal: options.goal?.trim(),
      status: 'active',
      decisions: [],
      nextSteps: [],
      openQuestions: [],
      touchedFiles: [],
      sessionIds: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.persistChat(chat);
  }

  public getChat(chatId: string): ChatState | undefined {
    return readJson<ChatState>(this.chatFile(chatId));
  }

  /** Chat used when a call does not name one: the most recently updated active chat. */
  public getActiveChatId(): string | undefined {
    const index = this.readGlobalIndex()[this.project.slug];
    if (index?.activeChatId && fs.existsSync(this.chatFile(index.activeChatId))) return index.activeChatId;
    const [latest] = this.listChats(1, 'active');
    return latest?.chatId;
  }

  public saveChat(chatId: string, patch: ChatPatch): ChatState {
    const chat = this.getChat(chatId) || this.openChat({ chatId });
    if (patch.title) chat.title = patch.title;
    if (patch.goal !== undefined) chat.goal = patch.goal;
    if (patch.status) chat.status = patch.status;
    if (patch.summary !== undefined) chat.summary = patch.summary;
    chat.decisions = uniqTail(chat.decisions, patch.decisions);
    chat.openQuestions = uniqTail(chat.openQuestions, patch.openQuestions);
    chat.touchedFiles = uniqTail(chat.touchedFiles, patch.touchedFiles, 40);
    // Next steps are a replacement list, not an append log — stale steps are noise.
    if (patch.nextSteps) chat.nextSteps = patch.nextSteps.map((s) => s.trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS);
    return this.persistChat(chat);
  }

  public appendChatEvent(chatId: string, event: Omit<ChatEvent, 'at'>): void {
    const chat = this.getChat(chatId);
    if (!chat) return;
    chat.events.push({ at: new Date().toISOString(), ...event });
    if (chat.events.length > MAX_EVENTS) chat.events = chat.events.slice(-MAX_EVENTS);
    this.persistChat(chat);
  }

  public linkSession(chatId: string, sessionId: string): void {
    const chat = this.getChat(chatId);
    if (!chat) return;
    if (!chat.sessionIds.includes(sessionId)) chat.sessionIds.push(sessionId);
    this.persistChat(chat);
  }

  public listChats(limit = 10, status?: ChatStatus): ChatState[] {
    if (!fs.existsSync(this.chatsDir)) return [];
    const chats = fs
      .readdirSync(this.chatsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<ChatState>(path.join(this.chatsDir, f)))
      .filter((c): c is ChatState => Boolean(c))
      .filter((c) => (status ? c.status === status : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return chats.slice(0, limit);
  }

  private persistChat(chat: ChatState): ChatState {
    chat.updatedAt = new Date().toISOString();
    writeJson(this.chatFile(chat.chatId), chat);
    this.touchGlobalIndex(chat);
    return chat;
  }

  // --------------------------------------------------------------- sessions

  private get sessionsDir(): string {
    return path.join(this.stateDir, 'sessions');
  }

  public saveSessionRecord(sessionId: string, record: unknown): void {
    writeJson(path.join(this.sessionsDir, `${sessionId}.json`), record);
  }

  public loadSessionRecord<T>(sessionId: string): T | undefined {
    return readJson<T>(path.join(this.sessionsDir, `${sessionId}.json`));
  }

  public listSessionRecords<T extends { updatedAt?: number }>(): T[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<T>(path.join(this.sessionsDir, f)))
      .filter((s): s is T => Boolean(s))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  public deleteSessionRecord(sessionId: string): void {
    const file = path.join(this.sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  // ----------------------------------------------------------- global index

  private get globalIndexFile(): string {
    return path.join(GLOBAL_STATE_DIR, 'projects.json');
  }

  private readGlobalIndex(): Record<string, GlobalIndexEntry> {
    return readJson<Record<string, GlobalIndexEntry>>(this.globalIndexFile) || {};
  }

  private touchGlobalIndex(chat?: ChatState): void {
    try {
      const index = this.readGlobalIndex();
      const previous = index[this.project.slug];
      index[this.project.slug] = {
        slug: this.project.slug,
        name: this.project.name,
        root: this.workspace.root,
        activeChatId: chat && chat.status !== 'done' ? chat.chatId : previous?.activeChatId,
        lastChatTitle: chat?.title || previous?.lastChatTitle,
        updatedAt: new Date().toISOString(),
      };
      writeJson(this.globalIndexFile, index);
    } catch (err: any) {
      logger.warn(`[Memory] Could not update global project index: ${err.message}`);
    }
  }

  public static listKnownProjects(): GlobalIndexEntry[] {
    const file = path.join(GLOBAL_STATE_DIR, 'projects.json');
    const index = readJson<Record<string, GlobalIndexEntry>>(file) || {};
    return Object.values(index)
      .filter((entry) => fs.existsSync(entry.root))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // -------------------------------------------------------------- directive

  /** Compact project directive injected into every subagent system prompt. */
  public projectDirective(): string {
    const p = this.project;
    const facts = [
      p.language && `lang=${p.language}`,
      p.framework && `framework=${p.framework}`,
      p.packageManager && `pkg=${p.packageManager}`,
      p.testFramework && `tests=${p.testFramework}`,
      p.architecture && `architecture=${p.architecture}`,
    ].filter(Boolean);

    let text = `\n\n## Project: ${p.name} (root: ${p.root})\n${facts.join(' | ')}\n`;
    if (p.codingStyle) text += `Style: ${p.codingStyle}\n`;
    if (p.namingConvention) text += `Naming: ${p.namingConvention}\n`;
    if (p.rules.length > 0) text += `Rules:\n${p.rules.map((r) => `- ${r}`).join('\n')}\n`;
    text += `All file paths you use are relative to the project root above. Never touch files outside it.\n`;
    text += `Quality bar: complete, production-ready code. No placeholders, no TODO stubs, exact imports and types.\n`;
    return text;
  }

  /** Compact "where we left off" brief for a chat thread. */
  public chatDirective(chatId: string): string {
    const chat = this.getChat(chatId);
    if (!chat) return '';

    let text = `\n## Chat thread: ${chat.chatId} — ${chat.title} [${chat.status}]\n`;
    if (chat.goal) text += `Goal: ${chat.goal}\n`;
    if (chat.summary) text += `State: ${chat.summary}\n`;
    if (chat.decisions.length) text += `Decisions:\n${chat.decisions.slice(-8).map((d) => `- ${d}`).join('\n')}\n`;
    if (chat.nextSteps.length) text += `Next steps:\n${chat.nextSteps.map((s) => `- ${s}`).join('\n')}\n`;
    if (chat.openQuestions.length) text += `Open questions:\n${chat.openQuestions.slice(-5).map((q) => `- ${q}`).join('\n')}\n`;
    if (chat.touchedFiles.length) text += `Files in play: ${chat.touchedFiles.slice(-15).join(', ')}\n`;
    const recent = chat.events.slice(-5);
    if (recent.length) text += `Recent activity:\n${recent.map((e) => `- [${e.kind}] ${e.text}`).join('\n')}\n`;
    return text;
  }
}
