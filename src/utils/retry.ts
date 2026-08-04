import { logger } from '../logging/logger.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  timeoutMs?: number;
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

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    attempt++;
    try {
      if (timeoutMs) {
        return await withTimeout(fn(), timeoutMs, `${operationName} (Attempt ${attempt})`);
      }
      return await fn();
    } catch (error: any) {
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
