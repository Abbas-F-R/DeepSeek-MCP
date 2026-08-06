import fs from 'fs';
import path from 'path';
import { TaskDefinition } from '../types/index.js';
import { TaskRouter } from '../router/TaskRouter.js';
import { ResultMerger } from '../merger/ResultMerger.js';
import { GenerationMerger } from '../merger/GenerationMerger.js';
import { config } from '../config/index.js';
import { SubagentManager } from '../subagents/SubagentManager.js';
import { SubagentRole } from '../subagents/types.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { safeResolve, relativeToRoot } from '../workspace/WorkspaceContext.js';
import { Orchestrator, MAX_WAIT_MS } from '../orchestrator/Orchestrator.js';
import { MAX_PLAN_TASKS } from '../orchestrator/plan.js';
import { renderBoard, renderResults, renderTask } from '../orchestrator/format.js';
import { Run } from '../orchestrator/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any, router: TaskRouter) => Promise<string>;
}

/**
 * The tool surface is deliberately small: six tools with a `kind`/`role`
 * discriminator instead of thirty-four near-identical schemas. Every schema is
 * re-sent on every request, so tool count is a permanent context tax.
 * Legacy names still work through TOOL_ALIASES below without being listed.
 */

const WORKSPACE_PROPS = {
  project_root: { type: 'string', description: 'Absolute project root. Omit to use PROJECT_ROOT env or the server cwd.' },
  chat: { type: 'string', description: 'Chat thread id from memory{action:"chat_start"}. Omit to use the project\'s active chat.' },
};

const MODEL_PROPS = {
  model: { type: 'string', description: 'Model override' },
  provider: { type: 'string', description: 'Provider id (default: deepseek)' },
};

const MAX_INLINE_CONTENT = 120_000;

// --------------------------------------------------------------------- utils

function shortTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Resolve `content` for the analysis tools. Callers may pass raw text, or a
 * path inside the project — reading it server-side keeps the code out of the
 * caller's context entirely.
 */
function resolveContent(args: any, contentKeys: string[]): { text: string; label: string } {
  for (const key of contentKeys) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return { text: args[key], label: args.file_name || 'inline content' };
    }
  }

  if (args.path) {
    const store = MemoryStore.for(args.project_root);
    const root = store.ref.root;
    const target = safeResolve(root, args.path);
    if (!fs.existsSync(target)) throw new Error(`Path not found in project: '${args.path}'`);

    const stat = fs.statSync(target);
    if (stat.isFile()) {
      const text = fs.readFileSync(target, 'utf-8').slice(0, MAX_INLINE_CONTENT);
      return { text, label: relativeToRoot(root, target) };
    }

    const parts: string[] = [];
    let budget = MAX_INLINE_CONTENT;
    const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', '.agent', 'out', '__pycache__']);
    const walk = (dir: string, depth: number) => {
      if (budget <= 0 || depth > 3) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (budget <= 0) return;
        if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          try {
            const body = fs.readFileSync(full, 'utf-8').slice(0, Math.min(budget, 20_000));
            parts.push(`--- ${relativeToRoot(root, full)} ---\n${body}`);
            budget -= body.length;
          } catch {
            /* binary or unreadable — skip */
          }
        }
      }
    };
    walk(target, 1);
    return { text: parts.join('\n\n'), label: relativeToRoot(root, target) };
  }

  throw new Error(`Provide either "content" or "path" (a file or folder inside the project).`);
}

async function runPromptTask(
  router: TaskRouter,
  spec: { id: string; name: string; toolName: string; template: string; variables: Record<string, string>; args: any; reasoner?: boolean }
): Promise<string> {
  const task: TaskDefinition = {
    id: `task-${spec.id}-${Date.now()}`,
    name: spec.name,
    toolName: spec.toolName,
    providerId: spec.args.provider || config.orchestrator.defaultProvider,
    model: spec.args.model || (spec.reasoner ? config.deepseek.defaultReasonerModel : config.deepseek.defaultChatModel),
    promptTemplate: spec.template,
    variables: spec.variables,
  };
  const result = await router.executeTask(task);
  return ResultMerger.merge([result]).markdownReport;
}

function buildGenerationTask(
  idPrefix: string,
  taskName: string,
  toolName: string,
  args: any,
  generationMode: string,
  extra: { spec: string; file_type?: string; reasoner?: boolean }
): TaskDefinition {
  return {
    id: `task-${idPrefix}-${Date.now()}`,
    name: taskName,
    toolName,
    providerId: args.provider || config.orchestrator.defaultProvider,
    model: args.model || (extra.reasoner ? config.deepseek.defaultReasonerModel : config.deepseek.defaultChatModel),
    promptTemplate: 'generate',
    variables: {
      generation_mode: generationMode,
      spec: extra.spec,
      language: args.language || 'auto-detect',
      file_type: extra.file_type || args.file_type || 'N/A',
      architecture: args.architecture || 'Follow existing project conventions',
      design_pattern: args.design_pattern || 'N/A',
      framework: args.framework || 'N/A',
      coding_style: args.coding_style || 'Idiomatic for the target language',
      naming_convention: args.naming_convention || 'Idiomatic for the target language',
      project_rules: args.project_rules || 'N/A',
      target_folder: args.target_folder || 'N/A',
      project_context: args.project_context || 'N/A',
    },
  };
}

/** Project facts (stack, rules) appended to generation specs so output fits the repo. */
function projectSpecSuffix(args: any): string {
  try {
    const store = MemoryStore.for(args.project_root);
    const p = store.getProject();
    const facts = [p.language, p.framework, p.architecture, p.namingConvention].filter(Boolean).join(', ');
    const ruleList = store.getRules();
    const rules = ruleList.length ? `\nProject rules: ${ruleList.map((r) => r.text).join('; ')}` : '';
    return facts || rules ? `\n\nProject conventions: ${facts}${rules}` : '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ 1. agent

const AGENT_ROLES = ['explore', 'scout', 'general', 'coder', 'security', 'sql', 'custom'];

async function handleAgent(args: any): Promise<string> {
  const result = await SubagentManager.getInstance().run({
    role: (args.role as SubagentRole) || 'general',
    sessionId: args.session || args.session_id,
    projectRoot: args.project_root,
    chatId: args.chat || args.chat_id,
    task: args.task,
    context: args.context || args.code || args.spec,
    systemPrompt: args.system_prompt,
    allowedTools: args.allowed_tools,
    temperature: args.temperature,
    model: args.model,
    providerId: args.provider,
    maxSteps: args.max_steps,
  });

  const head = [
    `${result.personaName} · session ${result.sessionId}`,
    result.chatId ? `chat ${result.chatId}` : undefined,
    `${(result.executionTimeMs / 1000).toFixed(1)}s`,
    `${result.toolCallsMade} tool calls`,
    `${shortTokens(result.usage.totalTokens)} tok`,
    result.status !== 'completed' ? result.status : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const files = result.touchedFiles.length ? `\nfiles: ${result.touchedFiles.join(', ')}` : '';
  const reasoning = args.verbose && result.reasoningContent ? `\n\n<reasoning>\n${result.reasoningContent}\n</reasoning>` : '';

  return `${head}${files}\n\n${result.content}${reasoning}`;
}

// ----------------------------------------------------------- 2. orchestrate

/**
 * Find the run a call means when it does not say.
 *
 * Almost every call in a session concerns the run that session started, and
 * making the coordinator carry the id through every turn is a tax on the thing
 * it does most. An explicit id always wins.
 */
function resolveRun(args: any): Run {
  const orchestrator = Orchestrator.getInstance();

  if (args.run) {
    const run = orchestrator.get(args.run, args.project_root);
    if (!run) throw new Error(`No run '${args.run}' recorded for this project.`);
    return run;
  }

  const runs = orchestrator.list(args.project_root, 10);
  if (runs.length === 0) throw new Error('No runs recorded for this project. Start one with action:"start".');
  const live = runs.find((r) => r.status === 'running' || r.status === 'waiting' || r.status === 'interrupted');
  return live || runs[0];
}

/**
 * Accept a plan written in either casing.
 *
 * The schema advertises snake_case for the fields that have it elsewhere in
 * this tool surface, but a model writing a plan reaches for whichever it saw
 * last. Rejecting `allow_spawn` because the schema said `allowSpawn` would be
 * a validation error over nothing.
 */
function normalizePlan(plan: any): any {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task: any) => {
      if (!task || typeof task !== 'object') return task;
      const { max_steps, allow_spawn, on_fail, allowed_tools, ...rest } = task;
      return {
        ...rest,
        maxSteps: task.maxSteps ?? max_steps,
        allowSpawn: task.allowSpawn ?? allow_spawn,
        onFail: task.onFail ?? on_fail,
        allowedTools: task.allowedTools ?? allowed_tools,
      };
    }),
  };
}

async function handleOrchestrate(args: any): Promise<string> {
  const orchestrator = Orchestrator.getInstance();

  switch (args.action) {
    case 'start': {
      const plan = normalizePlan(args.plan);
      if (!plan) return 'Error: "plan" is required for action "start".';
      const run = orchestrator.start({
        plan: { goal: args.goal || plan.goal, tasks: plan.tasks },
        projectRoot: args.project_root,
        chatId: args.chat,
        maxParallel: args.max_parallel,
      });
      return `${renderBoard(run)}\n\nThe run is executing in the background; this call did not wait for it.`;
    }

    case 'status':
      return renderBoard(resolveRun(args));

    case 'wait': {
      const run = resolveRun(args);
      const settled = await orchestrator.wait(run.runId, args.timeout_ms || 120_000, args.project_root);
      return renderBoard(settled);
    }

    case 'approve': {
      if (!args.task) return 'Error: "task" is required for action "approve".';
      const run = resolveRun(args);
      orchestrator.approve(run.runId, args.task, args.note, args.project_root);
      return renderBoard(run);
    }

    case 'reject': {
      if (!args.task) return 'Error: "task" is required for action "reject".';
      const run = resolveRun(args);
      orchestrator.reject(run.runId, args.task, args.note, args.project_root);
      return renderBoard(run);
    }

    case 'stop':
      return renderBoard(orchestrator.stop(resolveRun(args).runId, args.project_root));

    case 'resume':
      return renderBoard(orchestrator.resume(resolveRun(args).runId, args.project_root));

    case 'show': {
      const run = resolveRun(args);
      if (!args.task) return `${renderBoard(run)}\n\nAnswers so far:\n${renderResults(run)}`;
      const task = run.tasks.find((t) => t.id === args.task);
      return task ? renderTask(task) : `Error: run '${run.runId}' has no task '${args.task}'.`;
    }

    case 'list': {
      const runs = orchestrator.list(args.project_root, 15);
      if (runs.length === 0) return 'No runs recorded for this project.';
      return runs
        .map((r) => {
          const done = r.tasks.filter((t) => t.state === 'done').length;
          return `${r.runId} [${r.status}] ${done}/${r.tasks.length} · ${r.goal}`;
        })
        .join('\n');
    }

    default:
      return `Error: unknown action '${args.action}'. Use start, status, wait, approve, reject, show, stop, resume or list.`;
  }
}

// ------------------------------------------------------------------- exports

export const ALL_TOOLS: ToolDefinition[] = [
  {
    name: 'agent',
    description:
      'Run a DeepSeek subagent with direct read/write access to the project on disk. Roles: explore (read-only codebase search), scout (docs/deps), general (deep reasoning), coder (writes files), security (audit), sql (schema/queries), custom (own system_prompt). Pass session to continue a thread; project facts and chat state are injected server-side, so do not resend them.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the subagent must do' },
        role: { type: 'string', enum: AGENT_ROLES, description: 'Subagent role (default: general)' },
        context: { type: 'string', description: 'Extra context. Skip it for code the subagent can read itself.' },
        session: { type: 'string', description: 'Session id from a previous call, to continue that thread' },
        ...WORKSPACE_PROPS,
        system_prompt: { type: 'string', description: 'Custom persona instructions (role: custom)' },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override tool permissions: read_file, write_file, edit_file, delete_file, list_directory, search_files',
        },
        max_steps: { type: 'number', description: 'Max tool round trips (default 8, max 20)' },
        temperature: { type: 'number' },
        verbose: { type: 'boolean', description: 'Include the model reasoning trace (costs tokens)' },
        ...MODEL_PROPS,
      },
      required: ['task'],
    },
    handler: async (args) => handleAgent(args),
  },

  {
    name: 'orchestrate',
    description:
      'Run a multi-step plan you have written as a dependency graph of subagents. Tasks with no unmet dependency run in parallel; a task that "needs" others starts only once they finish and receives their answers as its context. The run executes in the background and survives this call, so start it, then wait on it. Use a "checkpoint" task wherever you must run the tests or inspect the result yourself before the run continues — subagents cannot execute anything. Use plain "agent" instead for a single self-contained task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'wait', 'approve', 'reject', 'show', 'stop', 'resume', 'list'],
          description:
            'start: begin a plan | wait: park until the run needs you or ends | status: the board | show: one task\'s full answer | approve / reject: release or refuse a gated task | stop | resume: re-queue what an interrupted run left in flight | list',
        },
        plan: {
          type: 'object',
          description: 'start: the graph to execute.',
          properties: {
            goal: { type: 'string', description: 'What the run achieves, one line' },
            tasks: {
              type: 'array',
              description: `Up to ${MAX_PLAN_TASKS} tasks. Array order is irrelevant; "needs" is what orders them.`,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short unique id other tasks refer to' },
                  task: { type: 'string', description: 'The full instruction, or what a checkpoint must verify' },
                  kind: {
                    type: 'string',
                    enum: ['agent', 'checkpoint'],
                    description: 'checkpoint runs nothing and waits for you to report back (default: agent)',
                  },
                  role: { type: 'string', enum: AGENT_ROLES, description: 'default: general' },
                  needs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Ids that must finish first. Their answers become this task\'s context — do not repeat them in "task".',
                  },
                  context: { type: 'string', description: 'Material not on disk and not from a dependency' },
                  gate: { type: 'boolean', description: 'Hold for your approval before running' },
                  allowSpawn: {
                    type: 'boolean',
                    description:
                      'Let this task delegate parts of its own work. A delegate may hold a role this task does not, so a read-only task with allowSpawn can get files written. Set allowedTools to cap what its delegates may do.',
                  },
                  onFail: {
                    type: 'string',
                    enum: ['block', 'continue', 'abort'],
                    description: 'On failure: block dependents (default), run them anyway with the error, or cancel the run',
                  },
                  retries: { type: 'number', description: 'Re-runs on failure (max 2)' },
                  max_steps: { type: 'number', description: 'Tool round trips (default 8)' },
                  model: { type: 'string' },
                },
                required: ['id', 'task'],
              },
            },
          },
          required: ['goal', 'tasks'],
        },
        run: { type: 'string', description: 'Run id. Omit to use this project\'s current run.' },
        task: { type: 'string', description: 'Task id (approve, reject, show)' },
        note: {
          type: 'string',
          description: 'approve / reject: what you found. On a checkpoint this note IS the result dependents read — put the test output in it.',
        },
        timeout_ms: { type: 'number', description: `wait: how long to park, up to ${MAX_WAIT_MS} (default 120000)` },
        max_parallel: { type: 'number', description: 'start: tasks at once (capped by MAX_PARALLEL_TASKS)' },
        ...WORKSPACE_PROPS,
      },
      required: ['action'],
    },
    handler: async (args) => handleOrchestrate(args),
  },

  {
    name: 'agent_control',
    description: 'Inspect and control subagent sessions: list, status, stop, or register a reusable persona.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'stop', 'persona'], description: 'What to do' },
        session: { type: 'string', description: 'Target session id (status, stop)' },
        ...WORKSPACE_PROPS,
        role: { type: 'string', description: 'persona: unique role id' },
        persona_name: { type: 'string', description: 'persona: display name, e.g. "@perf"' },
        system_prompt: { type: 'string', description: 'persona: system instructions' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: 'persona: allowed workspace tools' },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const manager = SubagentManager.getInstance();

      switch (args.action) {
        case 'list': {
          const sessions = manager.listSessions(args.project_root, args.chat);
          if (sessions.length === 0) return 'No subagent sessions recorded for this project.';
          return sessions
            .slice(0, 30)
            .map(
              (s) =>
                `${s.sessionId} · ${s.personaName} · ${s.status} · ${s.stepCount} steps · ${shortTokens(s.usage?.totalTokens || 0)} tok` +
                `${s.chatId ? ` · chat ${s.chatId}` : ''}${s.lastTask ? `\n   ${s.lastTask}` : ''}`
            )
            .join('\n');
        }

        case 'status': {
          if (!args.session) return 'Error: "session" is required for action "status".';
          const session = manager.getSession(args.session, args.project_root);
          if (!session) return `Error: session '${args.session}' not found in this project.`;
          const header =
            `${session.sessionId} · ${session.personaName} · ${session.status} · ${session.stepCount} steps · ` +
            `${session.totalExecutionTimeMs}ms · ${shortTokens(session.usage?.totalTokens || 0)} tok` +
            `${session.chatId ? ` · chat ${session.chatId}` : ''}`;
          const files = session.touchedFiles.length ? `\nfiles: ${session.touchedFiles.join(', ')}` : '';
          const history = session.messages
            .filter((m) => m.role !== 'system')
            .slice(-10)
            .map((m) => `- [${m.role}] ${m.content.slice(0, 200).replace(/\n/g, ' ')}`)
            .join('\n');
          return `${header}${files}\n\nlast turns:\n${history}`;
        }

        case 'stop': {
          if (!args.session) return 'Error: "session" is required for action "stop".';
          return manager.stopSession(args.session, args.project_root)
            ? `Cancelled session '${args.session}'.`
            : `Error: session '${args.session}' not found.`;
        }

        case 'persona': {
          if (!args.role || !args.system_prompt) return 'Error: "role" and "system_prompt" are required for action "persona".';
          const tools = args.allowed_tools || ['read_file', 'list_directory', 'search_files'];
          manager.registerCustomRole({
            role: args.role,
            personaName: args.persona_name || `@${args.role}`,
            systemPrompt: args.system_prompt,
            allowedTools: tools,
          });
          return `Registered persona '${args.persona_name || `@${args.role}`}' (role: ${args.role}) with tools [${tools.join(', ')}]. Call agent with role="${args.role}".`;
        }

        default:
          return `Error: unknown action '${args.action}'. Use list, status, stop or persona.`;
      }
    },
  },

  {
    name: 'memory',
    description:
      'Per-project memory, stored as plain markdown in <project>/.agent/memory/ and surviving restarts. Three layers: facts about the codebase (ranked by relevance to your query), rules for how work is done here, and chat threads recording what was decided and what is next. Call action:"brief" with a query at the start of a thread; facts are captured automatically after every subagent run, so it fills itself.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'brief',
            'recall',
            'project',
            'rule',
            'rule_remove',
            'set',
            'rescan',
            'remember',
            'chat_start',
            'chat_save',
            'chat_get',
            'chat_list',
            'verify',
            'compact',
            'stats',
            'projects',
          ],
          description:
            'brief: stack, rules and where the last thread stopped | recall: the facts that rank for a query | project: stack and modules | rule / rule_remove: project conventions | set: update project fields | rescan: re-detect the stack | remember: store a fact by hand | chat_start / chat_save / chat_get / chat_list: thread state | verify: re-check every fact anchor against the working tree | compact: verify, compress overgrown threads, prune transcripts | stats: what memory holds | projects: every project on this machine',
        },
        ...WORKSPACE_PROPS,
        rule: { type: 'string', description: 'rule: the quality/architecture rule to store' },
        id: { type: 'string', description: 'rule_remove: id of the rule to drop' },
        query: { type: 'string', description: 'recall / brief: what you are about to work on, used to pick which facts come back' },
        limit: { type: 'number', description: 'recall: how many facts to return (default 8)' },
        fact: { type: 'string', description: 'remember: the claim to store, one sentence' },
        anchors: { type: 'array', items: { type: 'string' }, description: 'remember: file:line references backing the fact' },
        kind: {
          type: 'string',
          enum: ['stack', 'config', 'entrypoint', 'contract', 'convention', 'gotcha', 'security', 'decision', 'rule'],
          description: 'remember / rule: what sort of entry this is',
        },
        fields: {
          type: 'object',
          description: 'set: any of language, framework, architecture, codingStyle, namingConvention, testFramework',
        },
        title: { type: 'string', description: 'chat_start: short thread title' },
        goal: { type: 'string', description: 'chat_start: what this chat is trying to achieve' },
        summary: { type: 'string', description: 'chat_save: where we stand right now' },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'chat_save: limits the work must respect — versions, interfaces that may not break, instructions given',
        },
        critical: {
          type: 'array',
          items: { type: 'string' },
          description: 'chat_save: exact values it would be wrong to guess again — paths, ports, names, signatures',
        },
        next_steps: { type: 'array', items: { type: 'string' }, description: 'chat_save: replaces the current next-step list' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'chat_save: decisions to append' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'chat_save: open questions to append' },
        files: { type: 'array', items: { type: 'string' }, description: 'chat_save: files in play' },
        status: { type: 'string', enum: ['active', 'paused', 'done'], description: 'chat_save: thread status' },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const store = MemoryStore.for(args.project_root);
      const project = store.getProject();

      switch (args.action) {
        case 'brief':
          return store.brief(args.query);

        case 'recall': {
          if (!args.query) return 'Error: "query" is required for action "recall".';
          const hits = store.recallFacts(args.query, args.limit || 8);
          if (!hits.length) return `Nothing remembered yet that matches "${args.query}".`;
          return hits
            .map(({ item }) => {
              const anchors = item.anchors.length ? ` [${item.anchors.join(', ')}]` : '';
              return `- ${item.text}${anchors} (${item.kind}, confidence ${item.confidence.toFixed(2)})`;
            })
            .join('\n');
        }

        case 'project': {
          const modules = project.modules.length
            ? project.modules
                .map((m) => `- ${m.dir} — ${[m.language, m.framework, m.packageManager, m.testFramework].filter(Boolean).join(' · ')}`)
                .join('\n')
            : '- (no recognisable module manifests)';
          const summary = [project.language, project.framework, project.packageManager, project.testFramework]
            .filter(Boolean)
            .join(' | ');
          return `${project.name} — ${project.root}\n${summary}\nscanned ${project.lastScan}\n\nModules:\n${modules}`;
        }

        case 'remember': {
          if (!args.fact) return 'Error: "fact" is required for action "remember".';
          const report = store.rememberFacts([{ text: args.fact, anchors: args.anchors, kind: args.kind }]);
          if (report.rejected.length) return `Rejected: ${report.rejected[0].reason}.`;
          if (report.reinforced.length) return `Already known — reinforced [${report.reinforced[0].id}].`;
          if (report.superseded.length) {
            return `Stored [${report.superseded[0].by.id}], superseding [${report.superseded[0].old.id}].`;
          }
          return `Stored fact [${report.added[0]?.id}].`;
        }

        case 'rule': {
          if (!args.rule) return 'Error: "rule" is required for action "rule".';
          const entry = store.addRule(args.rule, args.kind);
          return `Stored rule [${entry?.id}]: "${args.rule}" (${store.getRules().length} rules total).`;
        }

        case 'rule_remove': {
          if (!args.id) return 'Error: "id" is required for action "rule_remove".';
          return store.removeRule(args.id) ? `Removed rule [${args.id}].` : `No rule with id '${args.id}'.`;
        }

        case 'set': {
          if (!args.fields || typeof args.fields !== 'object') return 'Error: "fields" object is required for action "set".';
          store.setFields(args.fields);
          return `Updated project memory: ${Object.keys(args.fields).join(', ')}.`;
        }

        case 'rescan': {
          const rescanned = store.rescan();
          return `Rescanned ${rescanned.name}: ${[rescanned.language, rescanned.framework, rescanned.packageManager, rescanned.testFramework].filter(Boolean).join(' | ')}`;
        }

        case 'chat_start': {
          const chat = store.openChat({ chatId: args.chat, title: args.title, goal: args.goal });
          return `chat ${chat.chatId} — ${chat.title}\nproject ${project.name} (${project.root})\nPass chat:"${chat.chatId}" on later agent/memory calls.`;
        }

        case 'chat_save': {
          const chatId = args.chat || store.getActiveChatId();
          if (!chatId) return 'Error: no chat thread open. Call memory{action:"chat_start"} first.';
          const chat = store.saveChat(chatId, {
            summary: args.summary,
            constraints: args.constraints,
            critical: args.critical,
            nextSteps: args.next_steps,
            decisions: args.decisions,
            openQuestions: args.open_questions,
            touchedFiles: args.files,
            status: args.status,
          });
          return `Saved chat ${chat.chatId} [${chat.status}] · ${chat.nextSteps.length} next steps · ${chat.decisions.length} decisions.`;
        }

        case 'chat_get': {
          const chatId = args.chat || store.getActiveChatId();
          if (!chatId) return 'No chat thread open for this project.';
          const directive = store.chatDirective(chatId);
          return directive || `Error: chat '${chatId}' not found in this project.`;
        }

        case 'chat_list': {
          const chats = store.listChats(20);
          if (!chats.length) return 'No chat threads recorded for this project.';
          return chats
            .map((c) => `${c.chatId} [${c.status}] ${c.title} · updated ${c.updatedAt}${c.summary ? `\n   ${c.summary.slice(0, 160)}` : ''}`)
            .join('\n');
        }

        case 'verify': {
          const report = store.verifyFacts();
          const lines = [
            `Checked ${report.checked} anchored fact(s): ${report.ok} intact, ${report.changed.length} now point at edited code, ${report.weakened.length} weakened, ${report.archived.length} archived.`,
          ];
          for (const entry of report.changed) {
            lines.push(`  STALE  ${entry.text.slice(0, 70)} [${entry.anchors.join(', ')}]`);
          }
          for (const entry of report.archived) {
            lines.push(`  GONE   ${entry.text.slice(0, 70)}`);
          }
          return lines.join('\n');
        }

        case 'compact':
          return store.compact();

        case 'stats': {
          const s = store.stats();
          const kinds = Object.entries(s.factsByKind)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, count]) => `${kind} ${count}`)
            .join(', ');
          return [
            `${project.name} memory`,
            `facts: ${s.facts} (${kinds || 'none'}) · average confidence ${s.averageConfidence}`,
            `rules: ${s.rules}`,
            `threads: ${s.chats} (${s.activeChats} active)`,
            `session transcripts: ${s.sessions}`,
            `on disk: ${(s.bytesOnDisk / 1024).toFixed(1)} KB`,
          ].join('\n');
        }

        case 'projects': {
          const projects = MemoryStore.listKnownProjects();
          if (!projects.length) return 'No projects indexed yet on this machine.';
          return projects
            .map((p) => `${p.name} · ${p.root}${p.activeChatId ? ` · active chat ${p.activeChatId} (${p.lastChatTitle || ''})` : ''} · ${p.updatedAt}`)
            .join('\n');
        }

        default:
          return `Error: unknown action '${args.action}'.`;
      }
    },
  },

  {
    name: 'review',
    description:
      'DeepSeek review of existing code. kind: code | folder | project | sql | architecture | security | performance | refactor. Pass path (file or folder inside the project) instead of content to avoid pasting code into context.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['code', 'folder', 'project', 'sql', 'architecture', 'security', 'performance', 'refactor'],
          description: 'What kind of review to run',
        },
        content: { type: 'string', description: 'Code, SQL, or architecture description to review' },
        path: { type: 'string', description: 'File or folder inside the project to read instead of passing content' },
        language: { type: 'string', description: 'Programming language' },
        focus: { type: 'string', description: 'Specific focus, e.g. "error handling", or the refactor goal' },
        database_type: { type: 'string', description: 'kind=sql: DB engine' },
        ...WORKSPACE_PROPS,
        ...MODEL_PROPS,
      },
      required: ['kind'],
    },
    handler: async (args, router) => {
      const kind = args.kind;
      const { text, label } = resolveContent(args, ['content', 'code', 'sql_content', 'project_summary', 'architecture_description', 'code_or_config', 'folder_content']);

      switch (kind) {
        case 'code':
          return runPromptTask(router, {
            id: 'review-code', name: 'Code Review', toolName: 'review', template: 'review', args,
            variables: { content: text, language: args.language || 'auto-detect', scope: `File/snippet: ${label}`, focus: args.focus || 'Bugs, correctness, code quality' },
          });

        case 'folder':
          return runPromptTask(router, {
            id: 'review-folder', name: 'Folder Review', toolName: 'review', template: 'review', args,
            variables: { content: text, language: args.language || 'mixed', scope: `Folder: ${label}`, focus: args.focus || 'Module structure, inter-file dependencies, clean code' },
          });

        case 'sql':
          return runPromptTask(router, {
            id: 'review-sql', name: 'SQL Review', toolName: 'review', template: 'sql', args,
            variables: { content: `${args.database_type ? `-- Database: ${args.database_type}\n` : ''}${text}` },
          });

        case 'architecture':
          return runPromptTask(router, {
            id: 'review-arch', name: 'Architecture Review', toolName: 'review', template: 'architecture', args, reasoner: true,
            variables: { content: text },
          });

        case 'security':
          return runPromptTask(router, {
            id: 'review-sec', name: 'Security Audit', toolName: 'review', template: 'security', args, reasoner: true,
            variables: { content: text },
          });

        case 'performance':
          return runPromptTask(router, {
            id: 'review-perf', name: 'Performance Review', toolName: 'review', template: 'performance', args, reasoner: true,
            variables: { content: text },
          });

        case 'refactor':
          return runPromptTask(router, {
            id: 'refactor', name: 'Refactoring Proposal', toolName: 'review', template: 'review', args, reasoner: true,
            variables: { content: text, language: args.language || 'auto-detect', scope: `Refactor: ${label}`, focus: args.focus || 'Clean code, SOLID, modern patterns' },
          });

        case 'project': {
          // Code + architecture + security in parallel, merged into one report.
          const base = { providerId: args.provider || config.orchestrator.defaultProvider, toolName: 'review' };
          const tasks: TaskDefinition[] = [
            { ...base, id: `task-proj-code-${Date.now()}`, name: 'Project Code Audit', model: args.model || config.deepseek.defaultChatModel, promptTemplate: 'review', variables: { content: text, language: args.language || 'project-wide', scope: `Project: ${label}`, focus: 'Maintainability and standards' } },
            { ...base, id: `task-proj-arch-${Date.now()}`, name: 'Project Architecture Audit', model: args.model || config.deepseek.defaultReasonerModel, promptTemplate: 'architecture', variables: { content: text } },
            { ...base, id: `task-proj-sec-${Date.now()}`, name: 'Project Security Audit', model: args.model || config.deepseek.defaultReasonerModel, promptTemplate: 'security', variables: { content: text } },
          ];
          const results = await router.executeParallel(tasks);
          return ResultMerger.merge(results).markdownReport;
        }

        default:
          return `Error: unknown review kind '${kind}'.`;
      }
    },
  },

  {
    name: 'generate',
    description:
      'Generate new, saveable file content with DeepSeek. kind: code (one file) | files (a module) | sql | tests | tests_inline | docs | project (scaffold) | seed. Returns structured file blocks; it never writes to disk — use agent role="coder" for that.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['code', 'files', 'sql', 'tests', 'tests_inline', 'docs', 'project', 'seed'],
          description: 'What to generate',
        },
        spec: { type: 'string', description: 'Full specification: purpose, inputs/outputs, behavior, dependencies' },
        language: { type: 'string' },
        framework: { type: 'string' },
        architecture: { type: 'string', description: 'e.g. Clean Architecture, Vertical Slice, CQRS' },
        design_pattern: { type: 'string' },
        coding_style: { type: 'string' },
        naming_convention: { type: 'string' },
        project_rules: { type: 'string' },
        project_context: { type: 'string', description: 'Existing tree/conventions the output must match' },
        target_folder: { type: 'string' },
        file_type: { type: 'string', description: 'kind=code: Repository, Service, Controller, DTO, Entity, Migration...' },
        file_name: { type: 'string' },
        module_name: { type: 'string', description: 'kind=files: feature/module name' },
        components: { type: 'string', description: 'kind=files: expected components list' },
        database: { type: 'string', description: 'kind=project|sql: database technology' },
        database_type: { type: 'string', description: 'kind=sql: DB engine' },
        sql_object_type: { type: 'string', description: 'kind=sql: Stored Procedure, View, Function, Trigger, Migration, Index' },
        test_framework: { type: 'string', description: 'kind=tests: Jest, Vitest, xUnit, PyTest...' },
        test_scope: { type: 'string', description: 'kind=tests: Unit, Integration, Performance' },
        doc_set: { type: 'string', description: 'kind=docs: README, API Docs, Architecture Docs, Sequence Diagram' },
        format: { type: 'string', description: 'kind=seed: SQL INSERT, JSON, CSV' },
        ...WORKSPACE_PROPS,
        ...MODEL_PROPS,
      },
      required: ['kind', 'spec'],
    },
    handler: async (args, router) => {
      const spec = `${args.spec}${projectSpecSuffix(args)}`;

      if (args.kind === 'tests_inline') {
        return runPromptTask(router, {
          id: 'tests-inline', name: 'Inline Test Generation', toolName: 'generate', template: 'tests', args,
          variables: { content: spec, framework: args.test_framework || args.framework || 'Standard test framework' },
        });
      }

      if (args.kind === 'seed') {
        return runPromptTask(router, {
          id: 'seed', name: 'Seed Data Generation', toolName: 'generate', template: 'seed', args,
          variables: { content: spec, format: args.format || 'SQL / JSON' },
        });
      }

      const plans: Record<string, { name: string; mode: string; spec: string; file_type?: string; reasoner?: boolean }> = {
        code: {
          name: 'Single File Generation', mode: 'Single File',
          spec: `${spec}${args.file_name ? `\n\nDesired file name: ${args.file_name}` : ''}`,
          file_type: args.file_type,
        },
        files: {
          name: `Multi-File Generation${args.module_name ? ` (${args.module_name})` : ''}`, mode: 'Multi-File Module',
          spec: `${spec}${args.module_name ? `\n\nModule: ${args.module_name}` : ''}${args.components ? `\n\nExpected components: ${args.components}` : ''}`,
        },
        sql: {
          name: 'SQL Object Generation', mode: 'SQL Objects',
          spec: `${spec}${args.database_type || args.database ? `\n\nDatabase: ${args.database_type || args.database}` : ''}`,
          file_type: args.sql_object_type,
        },
        tests: {
          name: 'Test Suite Generation', mode: 'Test Suite',
          spec: `${spec}${args.test_scope ? `\n\nTest scope: ${args.test_scope}` : ''}`,
          file_type: args.test_framework || args.framework,
        },
        docs: {
          name: 'Documentation Set Generation', mode: 'Documentation Set',
          spec: `${spec}${args.doc_set ? `\n\nRequested documents: ${args.doc_set}` : ''}`,
        },
        project: {
          name: 'Project Scaffold Generation', mode: 'Full Project Scaffold',
          spec: `${spec}${args.database ? `\n\nDatabase: ${args.database}` : ''}`,
          reasoner: true,
        },
      };

      const plan = plans[args.kind];
      if (!plan) return `Error: unknown generate kind '${args.kind}'.`;

      const task = buildGenerationTask(`gen-${args.kind}`, plan.name, 'generate', args, plan.mode, {
        spec: plan.spec,
        file_type: plan.file_type,
        reasoner: plan.reasoner,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  {
    name: 'analyze',
    description:
      'Explain or document existing material with DeepSeek. kind: explain (step-by-step walkthrough) | summarize | document (Markdown docs) | repo (repository structure and design). Pass path instead of content to read from the project.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['explain', 'summarize', 'document', 'repo'], description: 'What to produce' },
        content: { type: 'string', description: 'Code, text, or directory tree' },
        path: { type: 'string', description: 'File or folder inside the project to read instead of passing content' },
        doc_type: { type: 'string', description: 'kind=document: API Docs, README, JSDoc/Docstring' },
        ...WORKSPACE_PROPS,
        ...MODEL_PROPS,
      },
      required: ['kind'],
    },
    handler: async (args, router) => {
      const { text, label } = resolveContent(args, ['content', 'code', 'text', 'repository_tree']);

      const modes: Record<string, { mode: string; template: string; reasoner?: boolean }> = {
        explain: { mode: 'Detailed step-by-step walkthrough', template: 'documentation' },
        summarize: { mode: 'Executive technical summary', template: 'documentation' },
        document: { mode: args.doc_type || 'Comprehensive technical documentation', template: 'documentation' },
        repo: { mode: 'Repository structure and architecture analysis', template: 'architecture', reasoner: true },
      };

      const plan = modes[args.kind];
      if (!plan) return `Error: unknown analyze kind '${args.kind}'.`;

      return runPromptTask(router, {
        id: `analyze-${args.kind}`, name: `${plan.mode} (${label})`, toolName: 'analyze',
        template: plan.template, args, reasoner: plan.reasoner,
        variables: plan.template === 'architecture' ? { content: text } : { content: text, mode: plan.mode },
      });
    },
  },
];

/**
 * Pre-1.1 tool names. They are accepted by the server but not advertised, so
 * older skills and project configs keep working without paying for 34 schemas.
 */
export const TOOL_ALIASES: Record<string, { tool: string; inject: Record<string, any> }> = {
  subagent_explore: { tool: 'agent', inject: { role: 'explore' } },
  subagent_scout: { tool: 'agent', inject: { role: 'scout' } },
  subagent_general: { tool: 'agent', inject: { role: 'general' } },
  subagent_coder: { tool: 'agent', inject: { role: 'coder' } },
  subagent_security: { tool: 'agent', inject: { role: 'security' } },
  subagent_sql: { tool: 'agent', inject: { role: 'sql' } },
  subagent_custom: { tool: 'agent', inject: { role: 'custom' } },
  deepseek_agent: { tool: 'agent', inject: { role: 'custom' } },
  subagent_list: { tool: 'agent_control', inject: { action: 'list' } },
  subagent_status: { tool: 'agent_control', inject: { action: 'status' } },
  subagent_stop: { tool: 'agent_control', inject: { action: 'stop' } },
  subagent_create: { tool: 'agent_control', inject: { action: 'persona' } },
  subagent_memory: { tool: 'memory', inject: { action: 'brief' } },
  review_code: { tool: 'review', inject: { kind: 'code' } },
  review_folder: { tool: 'review', inject: { kind: 'folder' } },
  review_project: { tool: 'review', inject: { kind: 'project' } },
  review_sql: { tool: 'review', inject: { kind: 'sql' } },
  review_architecture: { tool: 'review', inject: { kind: 'architecture' } },
  review_security: { tool: 'review', inject: { kind: 'security' } },
  review_performance: { tool: 'review', inject: { kind: 'performance' } },
  refactor_code: { tool: 'review', inject: { kind: 'refactor' } },
  write_tests: { tool: 'generate', inject: { kind: 'tests_inline' } },
  generate_seed: { tool: 'generate', inject: { kind: 'seed' } },
  generate_code: { tool: 'generate', inject: { kind: 'code' } },
  generate_files: { tool: 'generate', inject: { kind: 'files' } },
  generate_sql: { tool: 'generate', inject: { kind: 'sql' } },
  generate_tests: { tool: 'generate', inject: { kind: 'tests' } },
  generate_documentation: { tool: 'generate', inject: { kind: 'docs' } },
  generate_project: { tool: 'generate', inject: { kind: 'project' } },
  explain_code: { tool: 'analyze', inject: { kind: 'explain' } },
  summarize: { tool: 'analyze', inject: { kind: 'summarize' } },
  documentation: { tool: 'analyze', inject: { kind: 'document' } },
  analyze_repository: { tool: 'analyze', inject: { kind: 'repo' } },
};

/** Legacy argument names mapped onto the consolidated schemas. */
const LEGACY_ARG_KEYS: Record<string, string> = {
  session_id: 'session',
  chat_id: 'chat',
  code: 'content',
  sql_content: 'content',
  project_summary: 'content',
  architecture_description: 'content',
  code_or_config: 'content',
  folder_content: 'content',
  repository_tree: 'content',
  text: 'content',
  schema: 'spec',
  custom_rule: 'rule',
  framework: 'framework',
};

export function resolveToolCall(name: string, args: any): { tool: ToolDefinition; args: any } | undefined {
  const direct = ALL_TOOLS.find((t) => t.name === name);
  if (direct) return { tool: direct, args };

  const alias = TOOL_ALIASES[name];
  if (!alias) return undefined;

  const tool = ALL_TOOLS.find((t) => t.name === alias.tool);
  if (!tool) return undefined;

  const mapped: any = { ...alias.inject };
  for (const [key, value] of Object.entries(args || {})) {
    if (key === 'action') continue; // handled below — the alias decides the action
    const target = LEGACY_ARG_KEYS[key] || key;
    if (mapped[target] === undefined) mapped[target] = value;
  }

  // subagent_memory carried its own action vocabulary.
  if (alias.tool === 'memory' && args?.action) {
    mapped.action = args.action === 'add_rule' ? 'rule' : args.action === 'view' ? 'brief' : args.action;
  }
  if (alias.tool === 'agent' && !mapped.task && mapped.content) mapped.task = mapped.content;
  if (alias.tool === 'generate' && !mapped.spec && mapped.content) mapped.spec = mapped.content;
  return { tool, args: mapped };
}
