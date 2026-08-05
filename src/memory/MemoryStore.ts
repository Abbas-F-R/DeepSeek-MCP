import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';
import { SubagentSession } from '../subagents/types.js';
import {
  GLOBAL_STATE_DIR,
  WorkspaceRef,
  ensureDir,
  projectStateDir,
  resolveWorkspace,
} from '../workspace/WorkspaceContext.js';
import { Chat, ChatPatch, ChatStatus, ChatEvent, ChatStore } from './Chats.js';
import { compactChat } from './Curator.js';
import { FactCandidate, FactsStore, MergeReport, VerifyReport } from './Facts.js';
import { Entry, EntryKind, formatEntry, makeId, parseEntries, todayIso } from './format.js';
import { Scored, recall } from './Recall.js';
import { SessionStore } from './Sessions.js';
import { DetectedStack, ModuleStack, detectStack } from './StackDetector.js';

export interface ProjectMemory {
  slug: string;
  name: string;
  root: string;
  modules: ModuleStack[];
  language?: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  architecture?: string;
  codingStyle?: string;
  namingConvention?: string;
  lastScan: string;
}

export interface MemoryStats {
  facts: number;
  factsByKind: Record<string, number>;
  averageConfidence: number;
  rules: number;
  chats: number;
  activeChats: number;
  sessions: number;
  bytesOnDisk: number;
}

export type { Chat, ChatPatch, ChatStatus, ChatEvent } from './Chats.js';

/** How many facts a task-aware directive injects. */
const DIRECTIVE_FACT_LIMIT = 10;

const stores = new Map<string, MemoryStore>();

/**
 * Per-project memory, stored as plain markdown inside the project itself
 * (`<root>/.agent/memory/`), so it travels with the repo and can never leak
 * between projects. A small global index maps project names back to roots.
 *
 * Three layers, each with its own retrieval rule:
 *   FACTS.md  — semantic: what is true about the code, ranked by relevance
 *   RULES.md  — procedural: how work is done here, always injected
 *   chats/    — episodic: what happened, ranked by recency
 */
export class MemoryStore {
  private readonly workspace: WorkspaceRef;
  private readonly stateDir: string;
  private readonly memoryDir: string;

  public readonly facts: FactsStore;
  public readonly chats: ChatStore;
  public readonly sessions: SessionStore;

  private project: ProjectMemory;

  private constructor(workspace: WorkspaceRef) {
    this.workspace = workspace;
    this.stateDir = projectStateDir(workspace.root);
    this.memoryDir = path.join(this.stateDir, 'memory');

    this.facts = new FactsStore(workspace.root, this.memoryDir);
    this.chats = new ChatStore(this.memoryDir);
    this.sessions = new SessionStore(this.memoryDir);

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
    return path.join(this.memoryDir, 'PROJECT.md');
  }

  private get rulesFile(): string {
    return path.join(this.memoryDir, 'RULES.md');
  }

  private loadOrDetectProject(): ProjectMemory {
    const existing = readMarkdown(this.projectFile);
    if (existing.trim()) {
      const parsed = parseProject(existing);
      // The root may have moved (repo cloned elsewhere) — trust the live path.
      return { ...parsed, root: this.workspace.root, slug: this.workspace.slug, name: this.workspace.name };
    }

    const stack = detectStack(this.workspace.root);
    const project: ProjectMemory = {
      slug: this.workspace.slug,
      name: this.workspace.name,
      root: this.workspace.root,
      modules: stack.modules,
      language: stack.language,
      framework: stack.framework,
      packageManager: stack.packageManager,
      testFramework: stack.testFramework,
      codingStyle: stack.codingStyle,
      lastScan: todayIso(),
    };

    this.project = project;
    this.saveProject();
    return project;
  }

  public getProject(): ProjectMemory {
    return this.project;
  }

  public saveProject(): void {
    this.project.lastScan = todayIso();
    ensureDir(this.memoryDir);
    fs.writeFileSync(this.projectFile, renderProject(this.project), 'utf-8');
    this.touchGlobalIndex();
  }

  public rescan(): ProjectMemory {
    const stack: DetectedStack = detectStack(this.workspace.root);
    this.project = {
      ...this.project,
      modules: stack.modules,
      language: stack.language ?? this.project.language,
      framework: stack.framework ?? this.project.framework,
      packageManager: stack.packageManager ?? this.project.packageManager,
      testFramework: stack.testFramework ?? this.project.testFramework,
      codingStyle: stack.codingStyle ?? this.project.codingStyle,
    };
    this.saveProject();
    return this.project;
  }

  public setFields(patch: Partial<Omit<ProjectMemory, 'slug' | 'root' | 'modules'>>): void {
    this.project = { ...this.project, ...patch };
    this.saveProject();
  }

  // ------------------------------------------------------------------ rules

  public getRules(): Entry[] {
    return parseEntries(readMarkdown(this.rulesFile));
  }

  public addRule(rule: string, kind: EntryKind = 'rule'): Entry | undefined {
    const text = rule.trim();
    if (!text) return undefined;

    const rules = this.getRules();
    // Same rule phrased differently is still the same rule.
    const duplicate = rules.find((r) => normalizeRule(r.text) === normalizeRule(text));
    if (duplicate) {
      duplicate.hits += 1;
      duplicate.date = todayIso();
      this.saveRules(rules);
      return duplicate;
    }

    const entry: Entry = {
      id: makeId(new Set(rules.map((r) => r.id))),
      text,
      anchors: [],
      kind,
      hits: 0,
      confidence: 1,
      date: todayIso(),
    };
    rules.push(entry);
    this.saveRules(rules);
    return entry;
  }

  public removeRule(id: string): boolean {
    const rules = this.getRules();
    const next = rules.filter((r) => r.id !== id);
    if (next.length === rules.length) return false;
    this.saveRules(next);
    return true;
  }

  private saveRules(rules: Entry[]): void {
    ensureDir(this.memoryDir);
    const body = [
      '# Rules',
      '',
      'How work is done in this project. Always injected — these are not ranked or filtered.',
      '',
      ...rules.map(formatEntry),
      '',
    ].join('\n');
    fs.writeFileSync(this.rulesFile, body, 'utf-8');
  }

  // ------------------------------------------------------------------ facts

  public rememberFacts(candidates: FactCandidate[]): MergeReport {
    return this.facts.merge(candidates);
  }

  public verifyFacts(): VerifyReport {
    return this.facts.verify();
  }

  /**
   * Facts most relevant to `query`, ranked by relevance x recency x quality.
   *
   * The facts about to be served are re-checked against the working tree first.
   * Anchors alone only prove a file still exists; without this, hand-editing a
   * file leaves the old claim about it being injected as established fact — a
   * memory that lies confidently is worse than no memory at all. Only the
   * handful being returned are checked, so the cost is a few file reads.
   */
  public recallFacts(query: string, limit = DIRECTIVE_FACT_LIMIT): Scored<Entry>[] {
    const hits = recall(this.facts.load(), query, { limit });
    if (hits.length === 0) return hits;

    const report = this.facts.verifySubset(hits.map((h) => h.item));
    if (report.changed.length > 0) {
      logger.info(
        `[Memory] ${this.workspace.name}: ${report.changed.length} recalled fact(s) now point at edited code`
      );
    }

    const archived = new Set(report.archived.map((e) => e.id));
    const surviving = hits.filter((h) => !archived.has(h.item.id));
    this.facts.recordHits(surviving.map((h) => h.item.id));
    return surviving;
  }

  // ------------------------------------------------------------------ chats

  public openChat(options: { chatId?: string; title?: string; goal?: string } = {}): Chat {
    const chat = this.chats.open(options);
    this.touchGlobalIndex(chat);
    return chat;
  }

  public getChat(chatId: string): Chat | undefined {
    return this.chats.get(chatId);
  }

  public saveChat(chatId: string, patch: ChatPatch): Chat {
    const chat = this.chats.save(chatId, patch);
    this.touchGlobalIndex(chat);
    return chat;
  }

  public appendChatEvent(chatId: string, event: Omit<ChatEvent, 'at'>): void {
    this.chats.appendEvent(chatId, event);
  }

  public linkSession(chatId: string, sessionId: string): void {
    this.chats.linkSession(chatId, sessionId);
  }

  public listChats(limit = 10, status?: ChatStatus): Chat[] {
    return this.chats.list(limit, status);
  }

  /** Chat used when a call does not name one: the most recently updated active thread. */
  public getActiveChatId(): string | undefined {
    const recorded = this.readGlobalIndex().find((e) => e.root === this.workspace.root)?.activeChatId;
    if (recorded && this.chats.exists(recorded)) return recorded;
    return this.chats.list(1, 'active')[0]?.chatId;
  }

  public chatDirective(chatId: string): string {
    return this.chats.directive(chatId);
  }

  // -------------------------------------------------------------- sessions

  public saveSessionRecord(session: SubagentSession): void {
    this.sessions.save(session);
  }

  public loadSessionRecord(sessionId: string): SubagentSession | undefined {
    return this.sessions.load(sessionId);
  }

  public listSessionRecords(): SubagentSession[] {
    return this.sessions.list();
  }

  public deleteSessionRecord(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ------------------------------------------------------------ maintenance

  /** Verify anchors, compact overgrown threads, prune old transcripts. */
  public async compact(): Promise<string> {
    const verified = this.verifyFacts();
    const lines: string[] = [
      `facts: ${verified.checked} checked, ${verified.ok} intact, ${verified.changed.length} stale (code edited), ${verified.weakened.length} weakened, ${verified.archived.length} archived`,
    ];

    const overgrown = this.chats.needingCompaction();
    for (const chat of overgrown) {
      const result = await compactChat(chat);
      this.chats.write(chat);
      lines.push(
        `chat ${chat.chatId}: log ${result.eventsBefore}->${result.eventsAfter}, decisions ${result.decisionsBefore}->${result.decisionsAfter}`
      );
    }
    if (overgrown.length === 0) lines.push('chats: nothing over the soft caps');

    const pruned = this.sessions.prune();
    lines.push(`sessions: ${pruned} transcript(s) pruned`);
    return lines.join('\n');
  }

  public stats(): MemoryStats {
    const facts = this.facts.load();
    const chats = this.chats.list(200);
    const byKind: Record<string, number> = {};
    for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] || 0) + 1;

    return {
      facts: facts.length,
      factsByKind: byKind,
      averageConfidence: facts.length
        ? Number((facts.reduce((sum, f) => sum + f.confidence, 0) / facts.length).toFixed(2))
        : 0,
      rules: this.getRules().length,
      chats: chats.length,
      activeChats: chats.filter((c) => c.status === 'active').length,
      sessions: this.sessions.list().length,
      bytesOnDisk: directorySize(this.memoryDir),
    };
  }

  // ------------------------------------------------------------- directive

  /**
   * Project context injected into a subagent's system prompt.
   *
   * When `task` is given, only the facts that rank for it are injected instead
   * of the whole store. Dumping everything is what makes a memory system cost
   * more than it saves once it has been used for a while.
   */
  public projectDirective(task?: string): string {
    const p = this.project;
    const facts = [
      p.language && `lang=${p.language}`,
      p.framework && `framework=${p.framework}`,
      p.packageManager && `pkg=${p.packageManager}`,
      p.testFramework && `tests=${p.testFramework}`,
      p.architecture && `architecture=${p.architecture}`,
    ].filter(Boolean);

    let text = `\n\n## Project: ${p.name} (root: ${p.root})\n`;
    if (facts.length) text += `${facts.join(' | ')}\n`;

    if (p.modules.length > 1) {
      text += `Modules:\n`;
      for (const module of p.modules) {
        const detail = [module.language, module.framework, module.testFramework].filter(Boolean).join(' · ');
        text += `- ${module.dir}${detail ? ` — ${detail}` : ''}\n`;
      }
    }

    if (p.codingStyle) text += `Style: ${p.codingStyle}\n`;
    if (p.namingConvention) text += `Naming: ${p.namingConvention}\n`;

    const rules = this.getRules();
    if (rules.length) text += `Rules:\n${rules.map((r) => `- ${r.text}`).join('\n')}\n`;

    const relevant = task ? this.recallFacts(task) : [];
    if (relevant.length) {
      text += `\nKnown about this codebase:\n`;
      for (const { item } of relevant) {
        const anchor = item.anchors.length ? ` [${item.anchors.join(', ')}]` : '';
        // A fact whose code was edited since it was recorded is still worth
        // showing — but the agent must know to re-read before trusting it.
        const warning = item.stale ? ' — STALE: this code changed since, re-read before relying on it' : '';
        text += `- ${item.text}${anchor}${warning}\n`;
      }
    }

    text += `\nAll file paths you use are relative to the project root above. Never touch files outside it.\n`;
    text += `Quality bar: complete, production-ready code. No placeholders, no TODO stubs, exact imports and types.\n`;
    return text;
  }

  /** Everything worth knowing at the start of a thread. */
  public brief(query?: string): string {
    const chatId = this.getActiveChatId();
    let text = this.projectDirective(query);
    if (chatId) text += this.chatDirective(chatId);

    const chats = this.listChats(5);
    if (chats.length) {
      text += `\nRecent threads:\n`;
      for (const chat of chats) {
        const summary = chat.summary ? ` — ${chat.summary.slice(0, 110)}` : '';
        text += `- ${chat.chatId} [${chat.status}] ${chat.title}${summary}\n`;
      }
    } else {
      text += `\nNo threads yet. Call memory{action:"chat_start", title:"..."} to open one.\n`;
    }

    return text;
  }

  // ----------------------------------------------------------- global index

  private get globalIndexFile(): string {
    return path.join(GLOBAL_STATE_DIR, 'PROJECTS.md');
  }

  private readGlobalIndex(): GlobalIndexEntry[] {
    return parseGlobalIndex(readMarkdown(this.globalIndexFile));
  }

  private touchGlobalIndex(chat?: Chat): void {
    try {
      const entries = this.readGlobalIndex();
      const previous = entries.find((e) => e.root === this.workspace.root);
      const next: GlobalIndexEntry = {
        name: this.project.name,
        root: this.workspace.root,
        activeChatId: chat && chat.status !== 'done' ? chat.chatId : previous?.activeChatId,
        lastChatTitle: chat?.title || previous?.lastChatTitle,
        updatedAt: todayIso(),
      };

      const others = entries.filter((e) => e.root !== this.workspace.root);
      const all = [next, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      ensureDir(GLOBAL_STATE_DIR);
      fs.writeFileSync(this.globalIndexFile, renderGlobalIndex(all), 'utf-8');
    } catch (err: any) {
      logger.warn(`[Memory] Could not update global project index: ${err.message}`);
    }
  }

  public static listKnownProjects(): GlobalIndexEntry[] {
    const file = path.join(GLOBAL_STATE_DIR, 'PROJECTS.md');
    return parseGlobalIndex(readMarkdown(file)).filter((entry) => fs.existsSync(entry.root));
  }
}

export interface GlobalIndexEntry {
  name: string;
  root: string;
  activeChatId?: string;
  lastChatTitle?: string;
  updatedAt: string;
}

// ------------------------------------------------------------- rendering

function renderProject(project: ProjectMemory): string {
  const lines = [`# ${project.name}`, '', `root: ${project.root}`, `scanned: ${project.lastScan}`];
  if (project.language) lines.push(`language: ${project.language}`);
  if (project.framework) lines.push(`framework: ${project.framework}`);
  if (project.packageManager) lines.push(`packageManager: ${project.packageManager}`);
  if (project.testFramework) lines.push(`testFramework: ${project.testFramework}`);
  if (project.architecture) lines.push(`architecture: ${project.architecture}`);
  if (project.codingStyle) lines.push(`codingStyle: ${project.codingStyle}`);
  if (project.namingConvention) lines.push(`namingConvention: ${project.namingConvention}`);
  lines.push('');

  if (project.modules.length) {
    lines.push('## Modules', '');
    for (const module of project.modules) {
      const detail = [module.language, module.framework, module.packageManager, module.testFramework]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- ${module.dir}${detail ? ` — ${detail}` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function parseProject(doc: string): ProjectMemory {
  const header = (key: string): string | undefined => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(doc);
    return match ? match[1].trim() : undefined;
  };

  const titleMatch = /^#\s+(.+)$/m.exec(doc);
  const modules: ModuleStack[] = [];
  for (const line of doc.split('\n')) {
    const match = /^-\s+(\S+)(?:\s+—\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const [dir, detail] = [match[1], match[2] || ''];
    const parts = detail.split('·').map((p) => p.trim()).filter(Boolean);
    modules.push({ dir, language: parts[0], framework: parts[1], packageManager: parts[2], testFramework: parts[3] });
  }

  return {
    slug: '',
    name: titleMatch ? titleMatch[1].trim() : 'project',
    root: header('root') || '',
    modules,
    language: header('language'),
    framework: header('framework'),
    packageManager: header('packageManager'),
    testFramework: header('testFramework'),
    architecture: header('architecture'),
    codingStyle: header('codingStyle'),
    namingConvention: header('namingConvention'),
    lastScan: header('scanned') || todayIso(),
  };
}

const GLOBAL_LINE = /^-\s+(.+?)\s+@\s+(\S+)(?:\s+chat:(\S+))?(?:\s+"(.*)")?\s+(\d{4}-\d{2}-\d{2})\s*$/;

function renderGlobalIndex(entries: GlobalIndexEntry[]): string {
  const lines = ['# Projects', '', 'Every project this machine has run a subagent in.', ''];
  for (const entry of entries) {
    let line = `- ${entry.name} @ ${entry.root}`;
    if (entry.activeChatId) line += ` chat:${entry.activeChatId}`;
    if (entry.lastChatTitle) line += ` "${entry.lastChatTitle.replace(/"/g, "'")}"`;
    line += ` ${entry.updatedAt}`;
    lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

function parseGlobalIndex(doc: string): GlobalIndexEntry[] {
  const entries: GlobalIndexEntry[] = [];
  for (const line of doc.split('\n')) {
    const match = GLOBAL_LINE.exec(line.trim());
    if (!match) continue;
    entries.push({
      name: match[1],
      root: match[2],
      activeChatId: match[3],
      lastChatTitle: match[4],
      updatedAt: match[5],
    });
  }
  return entries;
}

// ---------------------------------------------------------------- helpers

function normalizeRule(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
}

function readMarkdown(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  } catch (err: any) {
    logger.warn(`[Memory] Could not read '${file}': ${err.message}`);
    return '';
  }
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(current, child.name);
      if (child.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(dir);
  return total;
}
