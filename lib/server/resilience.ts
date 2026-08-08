export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  jitter?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Bounded exponential retry helper for idempotent provider and job operations. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 8));
  const initialDelayMs = Math.max(0, Math.min(options.initialDelayMs ?? 400, 10_000));
  const maximumDelayMs = Math.max(initialDelayMs, Math.min(options.maximumDelayMs ?? 8_000, 30_000));
  const jitter = Math.max(0, Math.min(options.jitter ?? 0.2, 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      const retry = attempt < attempts && (options.shouldRetry?.(error, attempt) ?? true);
      if (!retry) throw error;
      const baseDelay = Math.min(initialDelayMs * 2 ** (attempt - 1), maximumDelayMs);
      const randomizedDelay = Math.round(baseDelay * (1 - jitter + Math.random() * jitter * 2));
      await options.onRetry?.(error, attempt, randomizedDelay);
      await wait(randomizedDelay, options.signal);
    }
  }
  throw new Error("Retry loop ended unexpectedly.");
}
