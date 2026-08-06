import { Run, RunTask, TaskState } from './types.js';

/**
 * How a run is reported back.
 *
 * The status board is read after every wait, so it is the single most repeated
 * output this plugin produces. It stays a fixed-width table of one line per
 * task: everything the coordinator needs to decide what to do next, and
 * nothing it already knows.
 */

const RESULT_PREVIEW_CHARS = 220;

export function shortTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function shortMs(ms: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** The note that tells the coordinator why a task is not moving. */
function annotate(run: Run, task: RunTask): string {
  switch (task.state) {
    case 'awaiting':
      return task.kind === 'checkpoint'
        ? `← ${task.task.replace(/\n/g, ' ').slice(0, 90)}`
        : '← waiting for approval';
    case 'pending': {
      const byId = new Map(run.tasks.map((t) => [t.id, t]));
      const outstanding = task.needs.filter((id) => byId.get(id)?.state !== 'done');
      return outstanding.length ? `needs ${outstanding.join(', ')}` : 'queued';
    }
    case 'ready':
      return 'queued for a slot';
    case 'blocked':
    case 'failed':
    case 'skipped':
      return task.error ? task.error.replace(/\n/g, ' ').slice(0, 90) : '';
    case 'interrupted':
      return 'was running when the process stopped — resume to re-queue';
    default:
      return task.touchedFiles.length ? task.touchedFiles.slice(0, 3).join(', ') : '';
  }
}

export function renderBoard(run: Run): string {
  const done = run.tasks.filter((t) => t.state === 'done').length;
  const tokens = run.tasks.reduce((sum, t) => sum + t.tokens, 0);
  const elapsed = (run.updatedAt || Date.now()) - run.createdAt;

  const header =
    `${run.runId} [${run.status}] · ${run.goal}\n` +
    `${done}/${run.tasks.length} done · ${shortTokens(tokens)} tok · ${shortMs(elapsed) || '0s'}` +
    (run.note ? ` · ${run.note}` : '');

  // Width is measured on the rendered label, indent included, or a delegated
  // task pushes every column after it out of line.
  const label = (task: RunTask) => `${'  '.repeat(Math.min(task.depth, 3))}${task.id}`;
  const idWidth = Math.max(4, ...run.tasks.map((t) => label(t).length));

  const rows = run.tasks.map((task) => {
    const kind = task.kind === 'checkpoint' ? 'checkpoint' : task.role || 'general';
    const cost = task.tokens ? `${shortTokens(task.tokens)} tok` : '';
    return [
      // 11 is the width of 'interrupted', the longest state there is.
      `  ${pad(task.state, 11)}`,
      pad(label(task), idWidth + 2),
      pad(kind, 11),
      pad(cost, 9),
      pad(shortMs(task.elapsedMs), 7),
      annotate(run, task),
    ]
      .join(' ')
      .trimEnd();
  });

  return `${header}\n\n${rows.join('\n')}\n\n${nextStep(run)}`;
}

/**
 * What the coordinator should do next.
 *
 * Stated explicitly because the alternative is inferring it from the table
 * every time, and the wrong inference on a `waiting` run is a run that sits
 * there until someone notices.
 */
export function nextStep(run: Run): string {
  const gates = run.tasks.filter((t) => t.state === 'awaiting');
  if (gates.length > 0) {
    const gate = gates[0];
    return (
      `Next: ${gate.kind === 'checkpoint' ? 'do what this checkpoint asks, then ' : ''}` +
      `orchestrate{action:"approve", run:"${run.runId}", task:"${gate.id}", note:"what you found"} ` +
      `or action:"reject".`
    );
  }

  switch (run.status) {
    case 'running':
      return `Next: orchestrate{action:"wait", run:"${run.runId}"}.`;
    case 'interrupted':
      return `Next: orchestrate{action:"resume", run:"${run.runId}"} to re-queue what was in flight.`;
    case 'failed': {
      const failed = run.tasks.filter((t) => t.state === 'failed').map((t) => t.id);
      return `Run finished with failures: ${failed.join(', ') || 'see above'}. Read them with action:"show".`;
    }
    case 'cancelled':
      return 'Run cancelled.';
    default:
      return `Run complete. Read any task's answer with orchestrate{action:"show", run:"${run.runId}", task:"<id>"}.`;
  }
}

/** One task in full, including the answer the board only counts. */
export function renderTask(task: RunTask): string {
  const meta = [
    `${task.id} [${task.state}] · ${task.kind === 'checkpoint' ? 'checkpoint' : task.role || 'general'}`,
    task.needs.length ? `needs: ${task.needs.join(', ')}` : '',
    task.parent ? `spawned by: ${task.parent} (depth ${task.depth})` : '',
    task.sessionId ? `session: ${task.sessionId}` : '',
    `${shortTokens(task.tokens)} tok · ${shortMs(task.elapsedMs)} · ${task.attempts} attempt(s)`,
    task.touchedFiles.length ? `files: ${task.touchedFiles.join(', ')}` : '',
  ].filter(Boolean);

  const body = task.error
    ? `\n\nerror:\n${task.error}`
    : task.result
      ? `\n\n${task.result}`
      : '\n\n(no answer yet)';

  return `${meta.join('\n')}${body}`;
}

/** A run's finished work, condensed — used when the whole run is reported at once. */
export function renderResults(run: Run): string {
  const answered = run.tasks.filter((t) => t.result || t.error);
  if (answered.length === 0) return '(nothing has produced an answer yet)';
  return answered
    .map((task) => {
      const body = (task.error ? `FAILED: ${task.error}` : task.result || '').replace(/\n+/g, ' ');
      return `- ${task.id} [${task.state}]: ${body.slice(0, RESULT_PREVIEW_CHARS)}${body.length > RESULT_PREVIEW_CHARS ? '…' : ''}`;
    })
    .join('\n');
}

export const STATE_ORDER: TaskState[] = [
  'running',
  'awaiting',
  'ready',
  'pending',
  'done',
  'failed',
  'blocked',
  'skipped',
  'interrupted',
  'cancelled',
];
