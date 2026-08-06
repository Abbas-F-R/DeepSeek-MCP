import { logger } from '../logging/logger.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  timeoutMs?: number;
  /** Cancels the attempt in flight, and stops any further attempt being made. */
  signal?: AbortSignal;
}

/** True when a rejection is the caller cancelling rather than the call failing. */
export function isAbort(error: any): boolean {
  return (
    error?.name === 'AbortError' ||
    error?.name === 'APIUserAbortError' ||
    /aborted|cancell?ed/i.test(String(error?.message || ''))
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string = 'Operation'
): Promise<T> {
  let timer: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (error) {
    clearTimeout(timer!);
    throw error;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  operationName: string = 'Operation'
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;
  const timeoutMs = options.timeoutMs;

  const signal = options.signal;
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    if (signal?.aborted) throw new Error(`${operationName} was cancelled.`);
    attempt++;
    try {
      if (timeoutMs) {
        return await withTimeout(fn(), timeoutMs, `${operationName} (Attempt ${attempt})`);
      }
      return await fn();
    } catch (error: any) {
      // A cancelled call is not a failed call: retrying it would keep paying
      // for work whose result nobody is waiting for any more.
      if (signal?.aborted || isAbort(error)) {
        logger.info(`[Retry] ${operationName} cancelled; not retrying.`);
        throw new Error(`${operationName} was cancelled.`);
      }

      const isLastAttempt = attempt > maxRetries;
      logger.warn(`[Retry] ${operationName} failed (Attempt ${attempt}/${maxRetries + 1}): ${error.message || error}`);

      if (isLastAttempt) {
        logger.error(`[Retry] ${operationName} failed after ${attempt} attempts.`);
        throw error;
      }

      // Check if error is non-retryable (e.g., 401 Unauthorized / Invalid API Key)
      const status = error?.status || error?.response?.status;
      if (status === 401 || status === 403) {
        logger.error(`[Retry] Non-retryable auth error (${status}). Aborting retries.`);
        throw error;
      }

      logger.info(`[Retry] Waiting ${delay}ms before next attempt...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }
}
