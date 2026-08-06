import { logger } from '../logging/logger.js';

/**
 * Which orchestrated task owns which file.
 *
 * Two coder subagents running in parallel will happily write the same file and
 * the second one wins silently — the first agent's work disappears with no
 * error anywhere. A claim makes that collision an explicit refusal the model
 * can react to, instead of a lost edit nobody notices until review.
 *
 * Claims exist only inside a run. A plain `agent` call has no claim context and
 * is never affected.
 */

export interface Claimant {
  runId: string;
  taskId: string;
}

const claims = new Map<string, Claimant>();

/**
 * Take ownership of a file for a task, or report who already holds it.
 * Re-claiming a file you already own is a no-op, so repeated writes are fine.
 */
export function claimFile(relativePath: string, by: Claimant): { ok: true } | { ok: false; heldBy: Claimant } {
  const held = claims.get(relativePath);
  if (!held) {
    claims.set(relativePath, by);
    return { ok: true };
  }
  if (held.runId === by.runId && held.taskId === by.taskId) return { ok: true };
  return { ok: false, heldBy: held };
}

/** Drop every claim held by a task. Called when the task settles, however it settles. */
export function releaseTask(runId: string, taskId: string): void {
  let released = 0;
  for (const [file, held] of claims) {
    if (held.runId === runId && held.taskId === taskId) {
      claims.delete(file);
      released++;
    }
  }
  if (released > 0) logger.info(`[Claims] Released ${released} file claim(s) from ${runId}/${taskId}`);
}

/** Drop every claim held by a run. */
export function releaseRun(runId: string): void {
  for (const [file, held] of claims) {
    if (held.runId === runId) claims.delete(file);
  }
}

export function claimRefusal(relativePath: string, heldBy: Claimant): string {
  return (
    `Error: '${relativePath}' is being written by task '${heldBy.taskId}' in this run, so it is not yours to change. ` +
    `Report what you need changed in your answer and let that task own the edit, or work on a different file.`
  );
}

/** Test seam. */
export function clearClaims(): void {
  claims.clear();
}
