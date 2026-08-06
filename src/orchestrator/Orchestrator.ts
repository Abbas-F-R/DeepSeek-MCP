import { SubagentManager } from '../subagents/SubagentManager.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { SpawnOutcome, SpawnRequest } from '../subagents/tools/workspaceTools.js';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { RunStore } from './RunStore.js';
import { compilePlan, MAX_PLAN_TASKS, PlanError, toRunTask } from './plan.js';
import { releaseRun, releaseTask } from './claims.js';
import { isTerminalRun, isTerminalTask, Plan, Run, RunStatus, RunTask, TaskState } from './types.js';

/**
 * Executes a plan.
 *
 * Deliberately model-free: it resolves dependencies, holds a concurrency
 * ceiling, records state and hands results downstream. Every decision it makes
 * is arithmetic on a graph, so it can be tested and it cannot drift. The
 * judgement about *what* to run lives with the agent that wrote the plan.
 *
 * The run is asynchronous by construction. Starting it returns immediately and
 * the coordinator polls or waits, because a tool call that blocked for twenty
 * minutes would simply time out, and because a plan that only exists inside one
 * request handler dies with it.
 */

/** How much of a predecessor's answer is handed to a dependent task. */
const HANDOFF_CHARS_PER_TASK = 6_000;
const HANDOFF_CHARS_TOTAL = 20_000;
/** How deep the spawn tree may go. Plan tasks are depth 0. */
export const MAX_SPAWN_DEPTH = 2;
/** Longest a single `wait` call parks for, well inside any host request timeout. */
export const MAX_WAIT_MS = 240_000;

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

interface LiveRun {
  run: Run;
  store: RunStore;
  memory: MemoryStore;
  controllers: Map<string, AbortController>;
  waiters: Set<Waiter>;
  /** Tasks executing right now, including spawned children. */
  active: Set<string>;
}

export class Orchestrator {
  private static instance: Orchestrator;
  private live = new Map<string, LiveRun>();
  private stopping = false;
  /** Plan tasks executing across every run, against the process-wide ceiling. */
  private activeSlots = 0;

  public static getInstance(): Orchestrator {
    if (!Orchestrator.instance) Orchestrator.instance = new Orchestrator();
    return Orchestrator.instance;
  }

  // ------------------------------------------------------------------ start

  public start(options: {
    plan: Plan;
    projectRoot?: string;
    chatId?: string;
    maxParallel?: number;
  }): Run {
    if (this.stopping) throw new Error('The server is shutting down; no new runs are being accepted.');

    const memory = MemoryStore.for(options.projectRoot);
    const tasks = compilePlan(options.plan);

    const ceiling = config.orchestrator.maxParallelTasks;
    const run: Run = {
      runId: newRunId(),
      goal: options.plan.goal.trim(),
      status: 'running',
      projectRoot: memory.ref.root,
      chatId: options.chatId?.trim() || memory.getActiveChatId(),
      tasks,
      maxParallel: Math.max(1, Math.min(options.maxParallel || ceiling, ceiling)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const entry: LiveRun = {
      run,
      store: new RunStore(run.projectRoot),
      memory,
      controllers: new Map(),
      waiters: new Set(),
      active: new Set(),
    };
    this.live.set(run.runId, entry);

    logger.info(
      `[Run] ${run.runId} started in ${memory.ref.name}: ${tasks.length} task(s), up to ${run.maxParallel} at once`
    );
    if (run.chatId) {
      memory.appendChatEvent(run.chatId, { kind: 'agent', text: `run ${run.runId}: ${run.goal}` });
    }

    this.persist(entry);
    this.tick(entry);
    return run;
  }

  // ------------------------------------------------------------- scheduling

  /**
   * Advance the graph as far as it will go.
   *
   * Synchronous from the caller's point of view: it settles states, launches
   * whatever now fits, and returns. Each launched task calls back into `tick`
   * when it settles, which is what keeps the run moving with no polling loop.
   */
  private tick(entry: LiveRun): void {
    const { run } = entry;
    if (this.stopping) return;
    if (isTerminalRun(run.status) || run.status === 'interrupted') {
      // A task that settles after the run was cancelled still has a final
      // state worth writing down; without this the file keeps the last state
      // before the cancellation.
      this.persist(entry);
      return;
    }

    this.settleDependencies(entry);

    for (const task of run.tasks) {
      if (task.state !== 'ready') continue;
      if (entry.active.size >= run.maxParallel) break;
      if (this.activeSlots >= config.orchestrator.maxParallelTasks) break;
      this.launch(entry, task);
    }

    this.recomputeStatus(entry);
    this.persist(entry);
  }

  /**
   * Move `pending` tasks forward, and block the ones whose dependencies died.
   *
   * A failed task blocks its dependents but not the rest of the graph: an
   * unrelated branch that could still finish is worth finishing, and the run's
   * final status records the failure either way.
   */
  private settleDependencies(entry: LiveRun): void {
    const { run } = entry;
    const byId = new Map(run.tasks.map((t) => [t.id, t]));

    // Iterate to a fixed point: blocking one task can block the next one down.
    let changed = true;
    while (changed) {
      changed = false;

      for (const task of run.tasks) {
        if (task.state !== 'pending') continue;

        let blocked = false;
        let satisfied = true;

        for (const id of task.needs) {
          const need = byId.get(id);
          if (!need) continue;
          if (need.state === 'done') continue;
          if (isTerminalTask(need.state)) {
            // A dependency that failed is only survivable if its author said so.
            if (need.onFail === 'continue') continue;
            blocked = true;
            break;
          }
          satisfied = false;
        }

        if (blocked) {
          task.state = 'blocked';
          task.error = task.error || `dependency did not complete: ${task.needs.join(', ')}`;
          changed = true;
          continue;
        }
        if (!satisfied) continue;

        // A gate is the whole point of a waiting state: the graph stops here
        // until the coordinator says otherwise. Checkpoints are always gates.
        task.state = task.gate ? 'awaiting' : 'ready';
        changed = true;
      }
    }
  }

  private launch(entry: LiveRun, task: RunTask): void {
    const { run } = entry;

    task.state = 'running';
    task.attempts++;
    task.startedAt = Date.now();
    entry.active.add(task.id);
    this.activeSlots++;

    const controller = new AbortController();
    entry.controllers.set(task.id, controller);
    const attempt = task.attempts;

    logger.info(`[Run] ${run.runId}/${task.id} running (${task.role || 'general'}, attempt ${attempt})`);

    void this.execute(entry, task, controller)
      .then((outcome) => this.finishAttempt(entry, task, attempt, outcome))
      .catch((err: any) => this.finishAttempt(entry, task, attempt, { error: err?.message || String(err) }));
  }

  /**
   * Record an attempt's outcome, unless it has been superseded.
   *
   * An aborted call still settles, and it settles *after* a resume may already
   * have relaunched the same task. Without this fence the abandoned attempt
   * would report its cancellation over the live one's state and flush a stale
   * graph to disk. The slot it took is always given back; nothing else about
   * it is trusted.
   */
  private finishAttempt(
    entry: LiveRun,
    task: RunTask,
    attempt: number,
    outcome: { result?: string; error?: string; sessionId?: string; tokens?: number; files?: string[] }
  ): void {
    this.activeSlots = Math.max(0, this.activeSlots - 1);

    const superseded = this.live.get(entry.run.runId) !== entry || task.attempts !== attempt;
    if (superseded) {
      logger.info(`[Run] ${entry.run.runId}/${task.id} attempt ${attempt} settled after being superseded; ignoring.`);
      return;
    }

    entry.controllers.delete(task.id);
    entry.active.delete(task.id);
    releaseTask(entry.run.runId, task.id);
    this.settleTask(entry, task, outcome);
    this.tick(entry);
  }

  private async execute(
    entry: LiveRun,
    task: RunTask,
    controller: AbortController
  ): Promise<{ result?: string; error?: string; sessionId?: string; tokens?: number; files?: string[] }> {
    const { run } = entry;

    const result = await SubagentManager.getInstance().run({
      projectRoot: run.projectRoot,
      chatId: run.chatId,
      role: task.role || 'general',
      task: task.task,
      context: this.handoffFor(run, task),
      maxSteps: task.maxSteps,
      model: task.model,
      allowedTools: task.allowedTools?.length ? task.allowedTools : undefined,
      signal: controller.signal,
      orchestration: {
        runId: run.runId,
        taskId: task.id,
        depth: task.depth,
        allowSpawn: Boolean(task.allowSpawn) && task.depth < MAX_SPAWN_DEPTH,
        maxDepth: MAX_SPAWN_DEPTH,
        spawn: (request) => this.spawn(entry, task, request, controller.signal),
      },
    });

    return {
      result: result.content,
      sessionId: result.sessionId,
      tokens: result.usage.totalTokens,
      files: result.touchedFiles,
    };
  }

  private settleTask(
    entry: LiveRun,
    task: RunTask,
    outcome: { result?: string; error?: string; sessionId?: string; tokens?: number; files?: string[] }
  ): void {
    const { run } = entry;

    task.finishedAt = Date.now();
    task.elapsedMs += task.startedAt ? task.finishedAt - task.startedAt : 0;
    if (outcome.sessionId) task.sessionId = outcome.sessionId;
    if (outcome.tokens) task.tokens += outcome.tokens;
    for (const file of outcome.files || []) {
      if (!task.touchedFiles.includes(file)) task.touchedFiles.push(file);
    }

    if (!outcome.error) {
      task.state = 'done';
      task.result = outcome.result || '(no answer)';
      logger.info(`[Run] ${run.runId}/${task.id} done (${task.tokens} tok, ${task.elapsedMs}ms)`);
      return;
    }

    task.error = outcome.error;

    // A run cancelled underneath a task is not that task's failure.
    if (this.stopping || run.status === 'cancelled') {
      task.state = this.stopping ? 'interrupted' : 'cancelled';
      return;
    }

    if (task.attempts <= (task.retries ?? 0)) {
      logger.warn(`[Run] ${run.runId}/${task.id} failed, retrying: ${outcome.error}`);
      task.state = 'ready';
      return;
    }

    task.state = 'failed';
    logger.error(`[Run] ${run.runId}/${task.id} failed: ${outcome.error}`);

    if (task.onFail === 'abort') {
      run.note = `aborted: task '${task.id}' failed (${outcome.error})`;
      this.cancel(entry, run.note);
    }
  }

  // ---------------------------------------------------------------- handoff

  /**
   * The context a task inherits from the tasks it depends on.
   *
   * This is the reason ordering exists at all — a dependent that had to
   * rediscover what its predecessor already established would be no cheaper
   * than running it alone. Each answer is capped, and the whole handoff is
   * capped again, so a chain of verbose predecessors cannot flood the prompt.
   */
  private handoffFor(run: Run, task: RunTask): string | undefined {
    const byId = new Map(run.tasks.map((t) => [t.id, t]));
    const parts: string[] = [];
    let budget = HANDOFF_CHARS_TOTAL;

    for (const id of task.needs) {
      const need = byId.get(id);
      if (!need || budget <= 0) continue;

      const body = need.state === 'done' ? need.result : need.error && `FAILED: ${need.error}`;
      if (!body) continue;

      const allowance = Math.min(HANDOFF_CHARS_PER_TASK, budget);
      const clipped = body.length > allowance ? `${body.slice(0, allowance)}\n[...truncated]` : body;
      budget -= clipped.length;
      parts.push(`#### ${need.id} (${need.kind === 'checkpoint' ? 'checkpoint' : need.role || 'general'})\n${clipped}`);
    }

    if (task.context) parts.unshift(task.context);
    if (parts.length === 0) return undefined;

    const prior = task.needs.length > 0 ? '### Results from the steps this depends on\n' : '';
    return `${prior}${parts.join('\n\n')}`;
  }

  // ------------------------------------------------------------------ spawn

  /**
   * A running subagent delegating a piece of its own work.
   *
   * The child runs to completion inside the parent's tool call, so the parent
   * waits by construction and only the child's final answer enters the parent's
   * context. It is registered in the run graph before it starts, which is what
   * makes a nested agent visible in `status` rather than invisible work.
   *
   * Children are exempt from the concurrency ceiling on purpose: the parent is
   * already holding a slot and is blocked on the child, so making the child
   * queue for a slot would deadlock the run.
   */
  private async spawn(
    entry: LiveRun,
    parent: RunTask,
    request: SpawnRequest,
    signal: AbortSignal
  ): Promise<SpawnOutcome> {
    const { run } = entry;

    if (this.stopping) throw new Error('The server is shutting down.');
    if (parent.depth >= MAX_SPAWN_DEPTH) {
      throw new Error(`Delegation depth ${MAX_SPAWN_DEPTH} reached; do this work yourself.`);
    }
    if (run.tasks.length >= MAX_PLAN_TASKS) {
      throw new Error(`This run already has ${run.tasks.length} tasks, the ceiling. Do this work yourself.`);
    }

    // A child may never hold a permission its parent lacks.
    const parentTools = parent.allowedTools;
    const requested = request.allowedTools;
    const allowedTools = parentTools?.length
      ? (requested || parentTools).filter((t) => parentTools.includes(t))
      : requested;

    const child = toRunTask(
      {
        id: uniqueChildId(run, parent.id),
        task: request.task,
        role: request.role || 'general',
        context: request.context,
        maxSteps: request.maxSteps,
        allowedTools,
      },
      { depth: parent.depth + 1, parent: parent.id, state: 'running', attempts: 1, startedAt: Date.now() }
    );
    run.tasks.push(child);
    entry.active.add(child.id);
    this.persist(entry);

    logger.info(`[Run] ${run.runId}/${child.id} spawned by ${parent.id} (depth ${child.depth})`);

    try {
      const result = await SubagentManager.getInstance().run({
        projectRoot: run.projectRoot,
        chatId: run.chatId,
        role: child.role || 'general',
        task: child.task,
        context: child.context,
        maxSteps: child.maxSteps,
        allowedTools: child.allowedTools?.length ? child.allowedTools : undefined,
        signal,
        orchestration: {
          runId: run.runId,
          taskId: child.id,
          depth: child.depth,
          allowSpawn: child.depth < MAX_SPAWN_DEPTH,
          maxDepth: MAX_SPAWN_DEPTH,
          spawn: (nested) => this.spawn(entry, child, nested, signal),
        },
      });

      child.state = 'done';
      child.result = result.content;
      child.sessionId = result.sessionId;
      child.tokens = result.usage.totalTokens;
      child.touchedFiles = result.touchedFiles;

      // Deliberately not rolled up into the parent: a child has its own row, so
      // adding its cost to the parent's would count it twice in the run total
      // and make delegation look twice as expensive as it is.
      return {
        taskId: child.id,
        content: result.content,
        sessionId: result.sessionId,
        tokens: child.tokens,
        touchedFiles: child.touchedFiles,
      };
    } catch (err: any) {
      child.state = this.stopping ? 'interrupted' : 'failed';
      child.error = err?.message || String(err);
      throw err;
    } finally {
      child.finishedAt = Date.now();
      child.elapsedMs = child.finishedAt - (child.startedAt || child.finishedAt);
      entry.active.delete(child.id);
      releaseTask(run.runId, child.id);
      this.persist(entry);
    }
  }

  // ------------------------------------------------------------------ gates

  public approve(runId: string, taskId: string, note?: string, projectRoot?: string): RunTask {
    const entry = this.require(runId, projectRoot);
    const task = this.requireTask(entry, taskId);
    if (task.state !== 'awaiting') {
      throw new Error(`Task '${taskId}' is '${task.state}', not waiting for approval.`);
    }

    if (task.kind === 'checkpoint') {
      // Nothing runs: the coordinator's report *is* the result, and it is what
      // the dependent tasks read.
      task.state = 'done';
      task.result = note?.trim() || 'Checkpoint approved with no notes.';
      task.finishedAt = Date.now();
    } else {
      task.state = 'ready';
      if (note?.trim()) task.context = `${task.context ? `${task.context}\n\n` : ''}${note.trim()}`;
    }

    logger.info(`[Run] ${runId}/${taskId} approved`);
    this.tick(entry);
    return task;
  }

  public reject(runId: string, taskId: string, note?: string, projectRoot?: string): RunTask {
    const entry = this.require(runId, projectRoot);
    const task = this.requireTask(entry, taskId);
    if (task.state !== 'awaiting') {
      throw new Error(`Task '${taskId}' is '${task.state}', not waiting for approval.`);
    }

    task.state = 'skipped';
    task.error = note?.trim() || 'rejected by the coordinator';
    task.finishedAt = Date.now();
    logger.info(`[Run] ${runId}/${taskId} rejected`);
    this.tick(entry);
    return task;
  }

  // ------------------------------------------------------------- stop/resume

  public stop(runId: string, projectRoot?: string): Run {
    const entry = this.require(runId, projectRoot);
    this.cancel(entry, 'stopped by the coordinator');
    return entry.run;
  }

  private cancel(entry: LiveRun, note: string): void {
    const { run } = entry;
    if (isTerminalRun(run.status)) return;

    run.status = 'cancelled';
    run.note = note;

    for (const controller of entry.controllers.values()) controller.abort();
    for (const task of run.tasks) {
      if (!isTerminalTask(task.state)) {
        task.state = 'cancelled';
        task.finishedAt = task.finishedAt || Date.now();
      }
    }

    releaseRun(run.runId);
    logger.info(`[Run] ${run.runId} cancelled: ${note}`);
    this.persist(entry);
  }

  /**
   * Pick a run back up after the process that was executing it went away.
   *
   * Tasks that were mid-flight are re-queued rather than resumed: their
   * subagent session is on disk, but a half-finished tool loop has no
   * meaningful resume point, and re-running a task is cheap next to guessing
   * whether its writes landed.
   */
  public resume(runId: string, projectRoot?: string): Run {
    const entry = this.require(runId, projectRoot);
    const { run } = entry;

    if (isTerminalRun(run.status)) throw new Error(`Run '${runId}' is ${run.status} and cannot be resumed.`);

    let requeued = 0;
    for (const task of run.tasks) {
      if (task.state === 'interrupted' || task.state === 'running') {
        task.state = 'pending';
        task.startedAt = undefined;
        requeued++;
      }
    }

    run.status = 'running';
    run.note = requeued > 0 ? `resumed: ${requeued} interrupted task(s) re-queued` : 'resumed';
    logger.info(`[Run] ${run.runId} ${run.note}`);
    this.tick(entry);
    return run;
  }

  /**
   * Wind everything down because the host went away.
   *
   * Synchronous on purpose — this runs from a signal handler, and anything left
   * to a microtask may never execute. In-flight model calls are aborted, every
   * unfinished task is marked interrupted, and each run file is flushed, so a
   * later `resume` knows exactly where the work stopped.
   */
  public shutdown(reason = 'host disconnected'): void {
    if (this.stopping) return;
    this.stopping = true;

    for (const entry of this.live.values()) {
      const { run } = entry;
      for (const controller of entry.controllers.values()) controller.abort();

      if (!isTerminalRun(run.status)) {
        for (const task of run.tasks) {
          if (task.state === 'running' || task.state === 'ready') {
            task.state = 'interrupted';
            task.finishedAt = Date.now();
          }
        }
        run.status = 'interrupted';
        run.note = reason;
      }

      releaseRun(run.runId);
      run.updatedAt = Date.now();
      entry.store.save(run);
      for (const waiter of entry.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      entry.waiters.clear();
    }

    if (this.live.size > 0) logger.info(`[Run] Shutdown: ${this.live.size} run(s) flushed (${reason})`);
  }

  // ------------------------------------------------------------------- wait

  /**
   * Park until the run needs the coordinator again.
   *
   * The alternative is polling, and polling a twenty-minute run at any useful
   * interval costs more in tool calls than the run costs in tokens. Returns on
   * a terminal state, on a gate opening, or on the timeout — whichever is first.
   */
  public wait(runId: string, timeoutMs: number, projectRoot?: string): Promise<Run> {
    const entry = this.require(runId, projectRoot);
    const capped = Math.max(1_000, Math.min(timeoutMs, MAX_WAIT_MS));

    if (this.settledForCoordinator(entry.run)) return Promise.resolve(entry.run);

    return new Promise<Run>((resolve) => {
      const waiter: Waiter = {
        resolve: () => {
          entry.waiters.delete(waiter);
          resolve(entry.run);
        },
        timer: setTimeout(() => waiter.resolve(), capped),
      };
      entry.waiters.add(waiter);
    });
  }

  /** True when there is nothing left for the run to do without the coordinator. */
  private settledForCoordinator(run: Run): boolean {
    if (isTerminalRun(run.status) || run.status === 'interrupted') return true;
    return run.tasks.some((t) => t.state === 'awaiting');
  }

  // ------------------------------------------------------------------ lookup

  public get(runId: string, projectRoot?: string): Run | undefined {
    return this.lookup(runId, projectRoot)?.run;
  }

  public list(projectRoot?: string, limit = 20): Run[] {
    const memory = MemoryStore.for(projectRoot);
    const onDisk = new RunStore(memory.ref.root).list(limit);
    // A live run is always more current than its last flush.
    return onDisk.map((run) => this.live.get(run.runId)?.run ?? run);
  }

  /**
   * Find a run, loading it from disk if this process did not start it.
   *
   * A run recorded as running by a process that no longer exists is not
   * running; it was interrupted. Saying so is the difference between a resume
   * and a run that appears to be working and never finishes.
   */
  private lookup(runId: string, projectRoot?: string): LiveRun | undefined {
    const cached = this.live.get(runId);
    if (cached) return cached;

    const memory = MemoryStore.for(projectRoot);
    const store = new RunStore(memory.ref.root);
    const run = store.load(runId);
    if (!run) return undefined;

    if (run.status === 'running' || run.status === 'waiting') {
      run.status = 'interrupted';
      run.note = run.note || 'the process running this went away';
      for (const task of run.tasks) {
        if (task.state === 'running' || task.state === 'ready') task.state = 'interrupted';
      }
    }

    const entry: LiveRun = {
      run,
      store,
      memory,
      controllers: new Map(),
      waiters: new Set(),
      active: new Set(),
    };
    this.live.set(runId, entry);
    return entry;
  }

  private require(runId: string, projectRoot?: string): LiveRun {
    const entry = this.lookup(runId, projectRoot);
    if (!entry) throw new Error(`No run '${runId}' recorded for this project.`);
    return entry;
  }

  private requireTask(entry: LiveRun, taskId: string): RunTask {
    const task = entry.run.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Run '${entry.run.runId}' has no task '${taskId}'.`);
    return task;
  }

  // ------------------------------------------------------------------ status

  private recomputeStatus(entry: LiveRun): void {
    const { run } = entry;
    if (isTerminalRun(run.status) || run.status === 'interrupted') return;

    const states = new Set<TaskState>(run.tasks.map((t) => t.state));
    let next: RunStatus;

    if (states.has('running') || states.has('ready') || states.has('pending')) next = 'running';
    else if (states.has('awaiting')) next = 'waiting';
    else if (states.has('failed') || states.has('blocked')) next = 'failed';
    else next = 'done';

    // 'waiting' outranks 'running' only when nothing can proceed on its own;
    // a gate open alongside live work still means the run is working.
    if (next === 'running' && states.has('awaiting') && !states.has('running') && !states.has('ready')) {
      next = 'waiting';
    }

    if (next !== run.status) {
      run.status = next;
      if (isTerminalRun(next)) {
        releaseRun(run.runId);
        this.recordCompletion(entry);
      }
    }
  }

  private recordCompletion(entry: LiveRun): void {
    const { run } = entry;
    const done = run.tasks.filter((t) => t.state === 'done').length;
    const tokens = run.tasks.reduce((sum, t) => sum + t.tokens, 0);
    logger.info(`[Run] ${run.runId} ${run.status}: ${done}/${run.tasks.length} done, ${tokens} tok`);

    if (!run.chatId) return;
    try {
      entry.memory.appendChatEvent(run.chatId, {
        kind: 'agent',
        text: `run ${run.runId} ${run.status}: ${done}/${run.tasks.length} tasks`,
      });
      const files = [...new Set(run.tasks.flatMap((t) => t.touchedFiles))];
      if (files.length > 0) entry.memory.saveChat(run.chatId, { touchedFiles: files });
    } catch (err: any) {
      logger.warn(`[Run] Could not record completion in chat: ${err.message}`);
    }
  }

  private persist(entry: LiveRun): void {
    entry.run.updatedAt = Date.now();
    entry.store.save(entry.run);

    if (this.settledForCoordinator(entry.run)) {
      for (const waiter of entry.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      entry.waiters.clear();
    }
  }

  /** Test seam: forget in-memory runs without touching what is on disk. */
  public reset(): void {
    this.live.clear();
    this.activeSlots = 0;
    this.stopping = false;
  }
}

export { PlanError };

function newRunId(): string {
  const day = new Date().toISOString().slice(0, 10);
  return `run-${day}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueChildId(run: Run, parentId: string): string {
  const base = `${parentId}.sub`;
  let n = 1;
  while (run.tasks.some((t) => t.id === `${base}${n}`)) n++;
  return `${base}${n}`;
}
