/**
 * Bounded retry with exponential backoff and jitter.
 *
 * Used for provider calls and reminder delivery. `sleep` is injectable so tests
 * verify the timing behaviour without actually waiting.
 */

export interface RetryOptions {
  /** Total attempts, including the first one. `1` disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Decides whether a given error is worth retrying. Defaults to `true`. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic tests can disable jitter. */
  jitter?: boolean;
  /** Hard ceiling for the whole operation. */
  totalTimeoutMs?: number;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: boolean): number {
  const raw = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, maxDelayMs);
  if (!jitter) return capped;
  // Full-ish jitter, capped at 25% of the delay, keeps retries from synchronising.
  return Math.round(capped * (1 + Math.random() * 0.25));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const attempts = Math.max(1, options.attempts);
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? true;
  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry ? options.shouldRetry(error, attempt) : true;
      const isLast = attempt >= attempts;
      if (!retryable || isLast) break;

      const delayMs = backoffDelay(attempt, options.baseDelayMs, maxDelayMs, jitter);
      if (options.totalTimeoutMs !== undefined && Date.now() - started + delayMs > options.totalTimeoutMs) {
        break;
      }
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
