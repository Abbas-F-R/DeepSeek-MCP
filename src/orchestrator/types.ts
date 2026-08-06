import { SubagentRole } from '../subagents/types.js';
import { SubagentToolName } from '../subagents/tools/workspaceTools.js';

/**
 * A plan is written by the coordinating agent and executed verbatim.
 *
 * The orchestrator makes no model calls of its own: it resolves dependencies,
 * enforces a concurrency ceiling and records state. Planning stays where the
 * judgement is, execution stays where it can be tested.
 */

export type TaskState =
  /** Dependencies not yet satisfied. */
  | 'pending'
  /** Dependencies satisfied, queued for a slot. */
  | 'ready'
  /** Held until the coordinator approves it. */
  | 'awaiting'
  /** A subagent is executing it right now. */
  | 'running'
  | 'done'
  | 'failed'
  /** Rejected at its gate, or its dependency was. */
  | 'skipped'
  /** A dependency failed and this can no longer run. */
  | 'blocked'
  | 'cancelled'
  /** The process died mid-flight. Resumable. */
  | 'interrupted';

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** What happens to the rest of the graph when a task fails. */
export type FailurePolicy =
  /** Dependents are blocked; unrelated branches keep going. The default. */
  | 'block'
  /** Dependents run anyway, and receive the error text as context. */
  | 'continue'
  /** The whole run is cancelled. */
  | 'abort';

export type TaskKind =
  /** Runs a subagent. */
  | 'agent'
  /**
   * Runs nothing. Holds the graph open until the coordinator reports back —
   * the way tests get run, since subagents cannot execute anything.
   */
  | 'checkpoint';

/** One node of the plan, as written by the coordinator. */
export interface PlanTask {
  id: string;
  /** What the subagent must do, or what the coordinator must verify. */
  task: string;
  kind?: TaskKind;
  role?: SubagentRole;
  /** Ids of tasks that must finish first. Their answers become this task's context. */
  needs?: string[];
  /** Extra material that is not on disk. */
  context?: string;
  /** Hold for approval even though this is an ordinary agent task. */
  gate?: boolean;
  /** Let this task delegate further, up to the depth ceiling. */
  allowSpawn?: boolean;
  onFail?: FailurePolicy;
  /** Re-runs on failure. Capped by MAX_TASK_RETRIES. */
  retries?: number;
  maxSteps?: number;
  model?: string;
  allowedTools?: SubagentToolName[];
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
}

/** A plan task plus everything that happened to it. */
export interface RunTask extends PlanTask {
  state: TaskState;
  kind: TaskKind;
  needs: string[];
  onFail: FailurePolicy;
  /** How deep in the spawn tree. 0 for tasks named in the plan. */
  depth: number;
  /** Set when a running subagent spawned this task instead of the plan. */
  parent?: string;
  /** Subagent session, so the transcript survives the run. */
  sessionId?: string;
  /** Final answer, or the coordinator's note for a checkpoint. */
  result?: string;
  error?: string;
  attempts: number;
  tokens: number;
  elapsedMs: number;
  touchedFiles: string[];
  startedAt?: number;
  finishedAt?: number;
}

export interface Run {
  runId: string;
  goal: string;
  status: RunStatus;
  projectRoot: string;
  chatId?: string;
  tasks: RunTask[];
  maxParallel: number;
  createdAt: number;
  updatedAt: number;
  /** Recorded when the run stops for a reason worth reporting. */
  note?: string;
}

export const TERMINAL_TASK_STATES: TaskState[] = ['done', 'failed', 'skipped', 'blocked', 'cancelled'];
export const TERMINAL_RUN_STATES: RunStatus[] = ['done', 'failed', 'cancelled'];

export function isTerminalTask(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATES.includes(status);
}
