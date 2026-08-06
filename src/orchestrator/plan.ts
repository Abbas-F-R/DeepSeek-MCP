import { FailurePolicy, Plan, PlanTask, RunTask, TaskKind } from './types.js';

/**
 * Plan validation.
 *
 * A plan arrives as an argument from another agent, so it is untrusted input in
 * the ordinary sense: every failure here is one that would otherwise show up as
 * a hung run or an infinite loop half an hour later. Rejecting a bad graph
 * costs one tool call; discovering it at runtime costs a fleet of subagents.
 */

export const MAX_PLAN_TASKS = 40;
export const MAX_TASK_RETRIES = 2;
export const MAX_TASK_STEPS = 20;

const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const KINDS: TaskKind[] = ['agent', 'checkpoint'];
const POLICIES: FailurePolicy[] = ['block', 'continue', 'abort'];

export class PlanError extends Error {}

/**
 * Turn a plan into run tasks, or explain exactly what is wrong with it.
 *
 * Errors are worded for the agent that wrote the plan, naming the offending id,
 * because it is the one that has to fix it.
 */
export function compilePlan(plan: Plan): RunTask[] {
  if (!plan || typeof plan !== 'object') throw new PlanError('The plan must be an object with "goal" and "tasks".');
  if (!plan.goal || !plan.goal.trim()) throw new PlanError('The plan needs a "goal" describing what the run achieves.');
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new PlanError('The plan needs at least one task.');
  if (plan.tasks.length > MAX_PLAN_TASKS) {
    throw new PlanError(
      `The plan has ${plan.tasks.length} tasks, past the ceiling of ${MAX_PLAN_TASKS}. Split it into stages, or make individual tasks broader.`
    );
  }

  const byId = new Map<string, PlanTask>();
  for (const task of plan.tasks) {
    if (!task || typeof task !== 'object') throw new PlanError('Every entry of "tasks" must be an object.');
    if (!task.id || !VALID_ID.test(task.id)) {
      throw new PlanError(
        `Task id '${task.id ?? ''}' is not usable. Use a short identifier of letters, digits, '-' or '_' — it is how other tasks refer to this one.`
      );
    }
    if (byId.has(task.id)) throw new PlanError(`Duplicate task id '${task.id}'. Ids must be unique within a plan.`);
    if (!task.task || !task.task.trim()) throw new PlanError(`Task '${task.id}' has no "task" text.`);
    if (task.kind && !KINDS.includes(task.kind)) {
      throw new PlanError(`Task '${task.id}' has kind '${task.kind}'. Use ${KINDS.join(' or ')}.`);
    }
    if (task.onFail && !POLICIES.includes(task.onFail)) {
      throw new PlanError(`Task '${task.id}' has onFail '${task.onFail}'. Use ${POLICIES.join(', ')}.`);
    }
    byId.set(task.id, task);
  }

  for (const task of plan.tasks) {
    for (const need of task.needs || []) {
      if (!byId.has(need)) {
        throw new PlanError(`Task '${task.id}' needs '${need}', which is not in the plan.`);
      }
      if (need === task.id) throw new PlanError(`Task '${task.id}' needs itself.`);
    }
  }

  const cycle = findCycle(plan.tasks);
  if (cycle) {
    throw new PlanError(
      `The plan has a dependency cycle: ${cycle.join(' -> ')}. Dependencies must form a graph that finishes.`
    );
  }

  return plan.tasks.map((task) => toRunTask(task));
}

export function toRunTask(task: PlanTask, extra: Partial<RunTask> = {}): RunTask {
  const kind: TaskKind = task.kind || 'agent';
  return {
    ...task,
    kind,
    needs: [...(task.needs || [])],
    // A checkpoint exists to be answered by the coordinator, so it is always a gate.
    gate: kind === 'checkpoint' ? true : Boolean(task.gate),
    allowSpawn: Boolean(task.allowSpawn),
    onFail: task.onFail || 'block',
    retries: Math.max(0, Math.min(task.retries ?? 0, MAX_TASK_RETRIES)),
    maxSteps: task.maxSteps ? Math.max(1, Math.min(task.maxSteps, MAX_TASK_STEPS)) : undefined,
    state: 'pending',
    depth: 0,
    attempts: 0,
    tokens: 0,
    elapsedMs: 0,
    touchedFiles: [],
    ...extra,
  };
}

/**
 * Depth-first search for a back edge, returning the cycle itself rather than a
 * bare boolean — an agent that has to fix the plan needs to know which loop.
 */
function findCycle(tasks: PlanTask[]): string[] | undefined {
  const edges = new Map(tasks.map((t) => [t.id, t.needs || []]));
  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const seen = state.get(id);
    if (seen === 'closed') return undefined;
    if (seen === 'open') return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, 'open');
    stack.push(id);
    for (const next of edges.get(id) || []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'closed');
    return undefined;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return undefined;
}
