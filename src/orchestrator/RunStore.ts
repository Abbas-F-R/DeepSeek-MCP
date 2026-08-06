import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';
import { ensureDir, projectStateDir } from '../workspace/WorkspaceContext.js';
import { Run, RunStatus, RunTask, TaskKind, TaskState, FailurePolicy } from './types.js';

/**
 * Runs on disk, as plain text.
 *
 * A run outlives the process that started it — that is the whole point of
 * writing it down. The file is the source of truth for "what was in flight
 * when the host went away", so it is rewritten on every state change and
 * written atomically, because a half-flushed run file is worse than none.
 */

const RUNS_DIRNAME = 'runs';
const TASK_DELIM = '== task ';
const SECTION_DELIM = '--- ';

/** Sections whose bodies are free-form text rather than key/value pairs. */
type Section = 'task' | 'context' | 'result' | 'error';

export class RunStore {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = path.join(projectStateDir(projectRoot), RUNS_DIRNAME);
  }

  private fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.md`);
  }

  public save(run: Run): void {
    ensureDir(this.dir);
    const file = this.fileFor(run.runId);
    // Temp-and-rename: a crash mid-write leaves the previous run file intact
    // instead of a truncated one that would parse into a wrong graph.
    const temp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, renderRun(run), 'utf-8');
      fs.renameSync(temp, file);
    } catch (err: any) {
      logger.warn(`[Run] Could not write '${run.runId}': ${err.message}`);
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        /* nothing more to do */
      }
    }
  }

  public load(runId: string): Run | undefined {
    const file = this.fileFor(runId);
    if (!fs.existsSync(file)) return undefined;
    try {
      return parseRun(fs.readFileSync(file, 'utf-8'));
    } catch (err: any) {
      logger.warn(`[Run] Could not parse '${runId}': ${err.message}`);
      return undefined;
    }
  }

  public list(limit = 20): Run[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this.load(f.replace(/\.md$/, '')))
      .filter((r): r is Run => Boolean(r))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  public delete(runId: string): void {
    const file = this.fileFor(runId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

// -------------------------------------------------------------- rendering

/**
 * Protect body lines that would otherwise read as structure.
 *
 * A subagent's answer is markdown and frequently contains `--- ` rules; a
 * result quoting this very file would contain `== task `. Escaping the
 * backslash run as well keeps the round trip exact.
 */
function escapeBody(text: string): string {
  return text.replace(/^(\\*(?:== |--- ))/gm, '\\$1');
}

function unescapeBody(text: string): string {
  return text.replace(/^\\(\\*(?:== |--- ))/gm, '$1');
}

function section(name: Section, body?: string): string {
  if (!body) return '';
  return `${SECTION_DELIM}${name}\n${escapeBody(body)}\n`;
}

function renderRun(run: Run): string {
  const header = [
    `# ${run.runId}`,
    `status: ${run.status}`,
    `goal: ${run.goal.replace(/\n/g, ' ')}`,
    `root: ${run.projectRoot}`,
    run.chatId ? `chat: ${run.chatId}` : '',
    `maxParallel: ${run.maxParallel}`,
    `created: ${run.createdAt}`,
    `updated: ${run.updatedAt}`,
    run.note ? `note: ${run.note.replace(/\n/g, ' ')}` : '',
  ].filter(Boolean);

  const tasks = run.tasks.map((task) =>
    [
      `${TASK_DELIM}${task.id}`,
      `state: ${task.state}`,
      `kind: ${task.kind}`,
      task.role ? `role: ${task.role}` : '',
      `needs: ${task.needs.join(',')}`,
      `depth: ${task.depth}`,
      task.parent ? `parent: ${task.parent}` : '',
      task.sessionId ? `session: ${task.sessionId}` : '',
      `attempts: ${task.attempts}`,
      `tokens: ${task.tokens}`,
      `elapsedMs: ${task.elapsedMs}`,
      `files: ${task.touchedFiles.join(',')}`,
      `gate: ${task.gate ? 'true' : 'false'}`,
      `allowSpawn: ${task.allowSpawn ? 'true' : 'false'}`,
      `onFail: ${task.onFail}`,
      `retries: ${task.retries ?? 0}`,
      task.maxSteps ? `maxSteps: ${task.maxSteps}` : '',
      task.model ? `model: ${task.model}` : '',
      task.allowedTools?.length ? `tools: ${task.allowedTools.join(',')}` : '',
      task.startedAt ? `startedAt: ${task.startedAt}` : '',
      task.finishedAt ? `finishedAt: ${task.finishedAt}` : '',
      section('task', task.task),
      section('context', task.context),
      section('result', task.result),
      section('error', task.error),
    ]
      .filter(Boolean)
      .join('\n')
  );

  return `${header.join('\n')}\n\n${tasks.join('\n')}`;
}

const KEY_LINE = /^([a-zA-Z]+):\s?(.*)$/;

function parseRun(text: string): Run {
  const lines = text.split('\n');
  const head = new Map<string, string>();
  let i = 0;

  const runId = (lines[0] || '').startsWith('# ') ? lines[0].slice(2).trim() : '';
  for (i = 1; i < lines.length; i++) {
    if (lines[i].startsWith(TASK_DELIM)) break;
    const match = KEY_LINE.exec(lines[i]);
    if (match) head.set(match[1], match[2]);
  }

  const tasks: RunTask[] = [];
  let current: { keys: Map<string, string>; bodies: Map<Section, string[]> } | undefined;
  let body: Section | undefined;

  const flush = () => {
    if (current) tasks.push(materializeTask(current.keys, current.bodies));
    current = undefined;
    body = undefined;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith(TASK_DELIM)) {
      flush();
      current = { keys: new Map([['id', line.slice(TASK_DELIM.length).trim()]]), bodies: new Map() };
      continue;
    }
    if (!current) continue;

    if (line.startsWith(SECTION_DELIM)) {
      body = line.slice(SECTION_DELIM.length).trim() as Section;
      current.bodies.set(body, []);
      continue;
    }

    if (body) {
      current.bodies.get(body)!.push(line);
      continue;
    }

    const match = KEY_LINE.exec(line);
    if (match) current.keys.set(match[1], match[2]);
  }
  flush();

  return {
    runId: runId || head.get('runId') || '',
    goal: head.get('goal') || '',
    status: (head.get('status') as RunStatus) || 'interrupted',
    projectRoot: head.get('root') || '',
    chatId: head.get('chat') || undefined,
    tasks,
    maxParallel: parseInt(head.get('maxParallel') || '4', 10) || 4,
    createdAt: parseInt(head.get('created') || '0', 10) || 0,
    updatedAt: parseInt(head.get('updated') || '0', 10) || 0,
    note: head.get('note') || undefined,
  };
}

function materializeTask(keys: Map<string, string>, bodies: Map<Section, string[]>): RunTask {
  const num = (key: string, fallback = 0): number => {
    const raw = keys.get(key);
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  const csv = (key: string): string[] =>
    (keys.get(key) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const text = (name: Section): string | undefined => {
    const lines = bodies.get(name);
    if (!lines) return undefined;
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return unescapeBody(lines.join('\n'));
  };

  return {
    id: keys.get('id') || '',
    task: text('task') || '',
    context: text('context'),
    result: text('result'),
    error: text('error'),
    kind: (keys.get('kind') as TaskKind) || 'agent',
    role: keys.get('role') || undefined,
    needs: csv('needs'),
    state: (keys.get('state') as TaskState) || 'pending',
    depth: num('depth'),
    parent: keys.get('parent') || undefined,
    sessionId: keys.get('session') || undefined,
    attempts: num('attempts'),
    tokens: num('tokens'),
    elapsedMs: num('elapsedMs'),
    touchedFiles: csv('files'),
    gate: keys.get('gate') === 'true',
    allowSpawn: keys.get('allowSpawn') === 'true',
    onFail: (keys.get('onFail') as FailurePolicy) || 'block',
    retries: num('retries'),
    maxSteps: keys.get('maxSteps') ? num('maxSteps') : undefined,
    model: keys.get('model') || undefined,
    // An empty list would read as "no tools at all"; absent means "use the role's".
    allowedTools: csv('tools').length ? (csv('tools') as RunTask['allowedTools']) : undefined,
    startedAt: keys.get('startedAt') ? num('startedAt') : undefined,
    finishedAt: keys.get('finishedAt') ? num('finishedAt') : undefined,
  };
}
