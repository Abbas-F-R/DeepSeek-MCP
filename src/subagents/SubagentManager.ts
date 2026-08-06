import {
  SubagentRole,
  SubagentSession,
  SubagentRunOptions,
  SubagentRunResult,
  SubagentDefinition,
  TokenUsage,
} from './types.js';
import {
  SubagentToolName,
  WORKSPACE_TOOLS,
  WorkspaceToolContext,
  getOpenAIToolSchemas,
} from './tools/workspaceTools.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { autoCaptureEnabled, compactTranscript, extractFacts } from '../memory/Curator.js';
import { KEEP_VERBATIM_MESSAGES, shapeContext } from './context.js';
import { ProviderRegistry } from '../providers/base/ProviderRegistry.js';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';

const ROLE_TOOLS: Record<string, SubagentToolName[]> = {
  explore: ['read_file', 'list_directory', 'search_files'],
  scout: ['read_file', 'list_directory', 'search_files'],
  general: ['read_file', 'list_directory', 'search_files'],
  security: ['read_file', 'list_directory', 'search_files'],
  coder: ['read_file', 'list_directory', 'search_files', 'write_file', 'edit_file', 'delete_file'],
  sql: ['read_file', 'list_directory', 'search_files', 'write_file', 'edit_file'],
  custom: ['read_file', 'list_directory', 'search_files', 'write_file', 'edit_file', 'delete_file'],
};

const SYSTEM_PROMPTS: Record<string, { name: string; prompt: string }> = {
  explore: {
    name: '@explore',
    prompt: `You are @explore, a fast read-only codebase explorer with read_file, list_directory and search_files.
Map directory layouts, module dependencies and symbol locations. Answer with concrete file:line references and zero filler.`,
  },
  scout: {
    name: '@scout',
    prompt: `You are @scout, a documentation, API-contract and dependency researcher with read_file, list_directory and search_files.
Inspect manifests, type signatures and library interfaces. Report exact versions, exported names and signatures.`,
  },
  general: {
    name: '@general',
    prompt: `You are @general, a multi-step reasoning and root-cause diagnosis worker with read_file, list_directory and search_files.
Work the problem step by step against the real code, then state the conclusion and the evidence for it.`,
  },
  coder: {
    name: '@coder',
    prompt: `You are @coder, a senior implementation worker with full workspace tools.
PRE-WRITE PROTOCOL: before creating or changing any file, read the neighbouring files to match existing imports, interfaces, error handling and naming.
Write complete production code. No placeholders, no TODO stubs. Report every file you touched.`,
  },
  security: {
    name: '@security',
    prompt: `You are @security, an application security auditor with read-only workspace tools.
Hunt OWASP Top 10 and CWE Top 25 issues, hardcoded secrets and broken access control. For each finding give file:line, impact and the concrete fix.`,
  },
  sql: {
    name: '@sql',
    prompt: `You are @sql, a database and query-tuning specialist with read/write workspace tools.
PRE-WRITE PROTOCOL: read existing migrations and schema files before writing DDL.
Optimize execution plans, design indexes, and keep migrations reversible.`,
  },
  custom: {
    name: '@custom',
    prompt: `You are a specialized engineering subagent with workspace tools. Execute the task with maximum technical accuracy.`,
  },
};

const emptyUsage = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

export class SubagentManager {
  private static instance: SubagentManager;
  /** Keyed by `${projectRoot}::${sessionId}` — sessions never cross projects. */
  private sessions: Map<string, SubagentSession> = new Map();
  private customRoles: Map<string, SubagentDefinition> = new Map();

  private constructor() {}

  public static getInstance(): SubagentManager {
    if (!SubagentManager.instance) SubagentManager.instance = new SubagentManager();
    return SubagentManager.instance;
  }

  public registerCustomRole(def: SubagentDefinition): void {
    this.customRoles.set(def.role, def);
    logger.info(`[Subagent] Registered persona '${def.personaName}' (${def.role})`);
  }

  private key(root: string, sessionId: string): string {
    return `${root}::${sessionId}`;
  }

  /** In-memory first, then the project's on-disk session store (survives restarts). */
  private lookupSession(store: MemoryStore, sessionId: string): SubagentSession | undefined {
    const cached = this.sessions.get(this.key(store.ref.root, sessionId));
    if (cached) return cached;
    const persisted = store.loadSessionRecord(sessionId);
    if (persisted && persisted.projectRoot === store.ref.root) {
      this.sessions.set(this.key(store.ref.root, sessionId), persisted);
      return persisted;
    }
    return undefined;
  }

  private persist(store: MemoryStore, session: SubagentSession): void {
    this.sessions.set(this.key(session.projectRoot, session.sessionId), session);
    store.saveSessionRecord(session);
  }

  public async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
    const startTime = Date.now();
    const role: SubagentRole = options.role || 'general';

    // 1. Bind this run to exactly one project.
    const store = MemoryStore.for(options.projectRoot);
    const root = store.ref.root;

    // 2. Bind to a chat thread: explicit id, else the project's active chat.
    const chatId = options.chatId?.trim() || store.getActiveChatId();

    const customDef = this.customRoles.get(role);
    const persona = customDef
      ? { name: customDef.personaName, prompt: customDef.systemPrompt }
      : SYSTEM_PROMPTS[role] || SYSTEM_PROMPTS.custom;

    const baseTools =
      options.allowedTools || (customDef ? customDef.allowedTools : undefined) || ROLE_TOOLS[role] || ROLE_TOOLS.custom;

    // Delegation is a permission, not a role trait: it exists only for a task
    // whose plan entry asked for it, and only while there is depth left.
    const allowedTools =
      options.orchestration?.allowSpawn && !baseTools.includes('spawn_agent')
        ? [...baseTools, 'spawn_agent' as SubagentToolName]
        : baseTools;

    let session: SubagentSession | undefined = options.sessionId ? this.lookupSession(store, options.sessionId) : undefined;
    let isNewSession = false;

    if (session) {
      if (session.status === 'cancelled') {
        throw new Error(`Session '${session.sessionId}' was cancelled. Start a new one.`);
      }
      logger.info(`[Subagent] Resuming '${session.sessionId}' (${role}) in ${store.ref.name}`);
    } else {
      isNewSession = true;
      const sessionId = options.sessionId || `${role}-${Date.now().toString(36)}`;

      // Project facts + chat brief are injected server-side, so the caller never
      // has to resend them on follow-up turns. The task text selects which
      // remembered facts come along, instead of dumping the whole store.
      const directive = store.projectDirective(options.task) + (chatId ? store.chatDirective(chatId) : '');
      const systemPrompt = (options.systemPrompt || persona.prompt) + directive;

      session = {
        sessionId,
        projectRoot: root,
        projectSlug: store.ref.slug,
        chatId,
        role,
        personaName: customDef?.personaName || persona.name,
        systemPrompt,
        allowedTools,
        status: 'active',
        stepCount: 0,
        totalExecutionTimeMs: 0,
        usage: emptyUsage(),
        touchedFiles: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ role: 'system', content: systemPrompt, timestamp: Date.now() }],
      };
      logger.info(`[Subagent] Created '${sessionId}' (${session.personaName}) in ${store.ref.name} tools=[${allowedTools.join(',')}]`);
    }

    if (chatId) {
      session.chatId = chatId;
      store.linkSession(chatId, session.sessionId);
    }

    session.status = 'active';
    session.stepCount++;
    session.lastTask = options.task.slice(0, 200);

    const userText = `${options.context ? `### Context\n${options.context}\n\n` : ''}### Task\n${options.task}`;
    session.messages.push({ role: 'user', content: userText, timestamp: Date.now() });

    const providerId = options.providerId || config.orchestrator.defaultProvider;
    const model = options.model || config.deepseek.defaultModel;
    const provider = ProviderRegistry.getInstance().getProvider(providerId);
    const toolSchemas = getOpenAIToolSchemas(session.allowedTools);
    const toolCtx: WorkspaceToolContext = { root, touchedFiles: [], orchestration: options.orchestration };

    let finalContent = '';
    let finalReasoning: string | undefined;
    let toolCallsMade = 0;
    let stepsLeft = Math.max(1, Math.min(options.maxSteps ?? 8, 20));

    while (stepsLeft > 0) {
      stepsLeft--;

      const live = this.lookupSession(store, session.sessionId);
      if (live?.status === 'cancelled' || options.signal?.aborted) {
        session.status = 'cancelled';
        this.persist(store, session);
        throw new Error(`Session '${session.sessionId}' was cancelled mid-run.`);
      }

      try {
        const response = await provider.chat(await this.prepareMessages(session), {
          model,
          temperature: options.temperature ?? 0.2,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          signal: options.signal,
        });

        finalContent = response.content || '';
        if (response.reasoningContent) {
          finalReasoning = (finalReasoning ? `${finalReasoning}\n\n` : '') + response.reasoningContent;
        }
        if (response.usage) {
          session.usage.promptTokens += response.usage.promptTokens || 0;
          session.usage.completionTokens += response.usage.completionTokens || 0;
          session.usage.totalTokens += response.usage.totalTokens || 0;
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          session.messages.push({
            role: 'assistant',
            content: response.content || `[calling ${response.toolCalls.length} workspace tool(s)]`,
            timestamp: Date.now(),
          });

          for (const call of response.toolCalls) {
            const toolName = call.function?.name as SubagentToolName;
            let argsObj: any = {};
            try {
              const raw = call.function?.arguments;
              argsObj = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
            } catch {
              argsObj = {};
            }

            if (!session.allowedTools.includes(toolName)) {
              logger.warn(`[Subagent] '${session.personaName}' denied tool '${toolName}'`);
              session.messages.push({
                role: 'user',
                content: `[tool ${toolName}] Denied: role '${role}' may only use [${session.allowedTools.join(', ')}].`,
                timestamp: Date.now(),
              });
              continue;
            }

            const toolDef = WORKSPACE_TOOLS[toolName];
            if (!toolDef) continue;

            toolCallsMade++;
            let toolResult: string;
            try {
              toolResult = await toolDef.execute(argsObj, toolCtx);
            } catch (err: any) {
              // Sandbox violations and unexpected failures go back to the model
              // as a normal tool error instead of killing the session.
              toolResult = `Error: ${err.message}`;
            }
            session.messages.push({
              role: 'user',
              content: `[tool ${toolName}]\n${toolResult}`,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        session.messages.push({ role: 'assistant', content: finalContent, timestamp: Date.now() });
        session.status = 'completed';
        break;
      } catch (error: any) {
        session.status = 'error';
        session.updatedAt = Date.now();
        this.persist(store, session);
        logger.error(`[Subagent] '${session.personaName}' failed: ${error.message}`);
        throw error;
      }
    }

    // Running out of steps used to return an empty placeholder, throwing away
    // every token the run had already spent. Force one tool-free turn instead:
    // the subagent must answer from what it gathered.
    if (stepsLeft === 0 && session.status === 'active' && !options.signal?.aborted) {
      session.messages.push({
        role: 'user',
        content:
          'You have no tool calls left. Answer the task now using only what you have already read. ' +
          'State your findings with their file:line references, and say plainly which parts you could not verify.',
        timestamp: Date.now(),
      });

      try {
        const response = await provider.chat(await this.prepareMessages(session), {
          model,
          temperature: options.temperature ?? 0.2,
          signal: options.signal,
        });
        if (response.content) {
          finalContent = response.content;
          session.messages.push({ role: 'assistant', content: finalContent, timestamp: Date.now() });
        }
        if (response.usage) {
          session.usage.promptTokens += response.usage.promptTokens || 0;
          session.usage.completionTokens += response.usage.completionTokens || 0;
          session.usage.totalTokens += response.usage.totalTokens || 0;
        }
      } catch (err: any) {
        logger.warn(`[Subagent] Forced final answer failed for '${session.sessionId}': ${err.message}`);
      }

      session.status = 'completed';
      finalContent =
        finalContent ||
        '[step limit reached and the forced final answer failed — re-run with a higher max_steps]';
    }

    const executionTimeMs = Date.now() - startTime;
    session.totalExecutionTimeMs += executionTimeMs;
    session.updatedAt = Date.now();
    for (const file of toolCtx.touchedFiles) {
      if (!session.touchedFiles.includes(file)) session.touchedFiles.push(file);
    }
    this.persist(store, session);

    // Keep the chat thread up to date so a later turn can pick up where we stopped.
    if (chatId) {
      store.appendChatEvent(chatId, {
        kind: 'agent',
        text: `${session.personaName} ${session.sessionId}: ${session.lastTask}`,
      });
      if (toolCtx.touchedFiles.length > 0) {
        store.saveChat(chatId, { touchedFiles: toolCtx.touchedFiles });
      }
    }

    // Turn the run into durable memory. Without this the project relearns the
    // same facts on every session, which is what the delegation was meant to
    // avoid. Capture never blocks or fails the run it is summarizing.
    if (autoCaptureEnabled() && session.status === 'completed') {
      try {
        const candidates = await extractFacts({ task: options.task, answer: finalContent, role: String(role) });
        if (candidates.length > 0) {
          const merged = store.rememberFacts(candidates);
          logger.info(
            `[Memory] ${store.ref.name}: +${merged.added.length} new, ${merged.reinforced.length} reinforced, ${merged.superseded.length} superseded`
          );
        }
      } catch (err: any) {
        logger.warn(`[Memory] Auto-capture failed: ${err.message}`);
      }
    }

    return {
      sessionId: session.sessionId,
      projectRoot: root,
      chatId,
      role: session.role,
      personaName: session.personaName,
      status: session.status,
      content: finalContent,
      reasoningContent: finalReasoning,
      modelUsed: model,
      executionTimeMs,
      isNewSession,
      allowedTools: session.allowedTools,
      usage: session.usage,
      touchedFiles: toolCtx.touchedFiles,
      toolCallsMade,
    };
  }

  public listSessions(projectRoot?: string, chatId?: string): SubagentSession[] {
    const store = MemoryStore.for(projectRoot);
    const records = store.listSessionRecords();
    return chatId ? records.filter((s) => s.chatId === chatId) : records;
  }

  public getSession(sessionId: string, projectRoot?: string): SubagentSession | undefined {
    return this.lookupSession(MemoryStore.for(projectRoot), sessionId);
  }

  public stopSession(sessionId: string, projectRoot?: string): boolean {
    const store = MemoryStore.for(projectRoot);
    const session = this.lookupSession(store, sessionId);
    if (!session) return false;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    this.persist(store, session);
    logger.info(`[Subagent] Cancelled '${sessionId}'`);
    return true;
  }

  /**
   * Shape the session's history down to something that fits, then format it.
   *
   * Runs the cheap layers first — cap oversized tool results, then prune old
   * ones — and only pays for a model-written handoff note if the arithmetic
   * was not enough. The shaped history is written back to the session so the
   * next turn starts from the reduced form instead of redoing the work.
   */
  private async prepareMessages(
    session: SubagentSession
  ): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
    const budget = { contextWindow: config.deepseek.contextWindow };
    const { messages, report } = shapeContext(session.messages, budget);

    if (report.before !== report.after) {
      session.messages = messages;
      logger.info(
        `[Context] ${session.sessionId}: ${report.before.toLocaleString()} -> ${report.after.toLocaleString()} tokens ` +
          `(budget freed ${report.budgetFreed.toLocaleString()}, pruned ${report.pruneFreed.toLocaleString()})`
      );
    }

    if (report.needsSummary) {
      await this.foldOldTurns(session);
    }

    return session.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Fold everything outside the protected tail into a single handoff note.
   *
   * The system prompt and the most recent turns survive verbatim; only the
   * middle is summarized, so repeated compaction does not erode what the agent
   * is currently working on.
   */
  private async foldOldTurns(session: SubagentSession): Promise<void> {
    const system = session.messages.filter((m) => m.role === 'system');
    const rest = session.messages.filter((m) => m.role !== 'system');
    const keep = rest.slice(-KEEP_VERBATIM_MESSAGES);
    const older = rest.slice(0, rest.length - keep.length);
    if (older.length === 0) return;

    const { summary, foldedMessages } = await compactTranscript(older);
    if (!summary) return;

    session.messages = [
      ...system,
      {
        role: 'user',
        content: `[earlier context, compacted — ${foldedMessages} messages]\n\n${summary}`,
        timestamp: Date.now(),
      },
      ...keep,
    ];
    logger.info(`[Context] ${session.sessionId}: folded ${foldedMessages} older message(s) into a handoff note`);
  }
}
