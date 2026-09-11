/**
 * Shared retry classification for Apify-backed providers (Harshmaur and the
 * Trudax `apify-test` fallback).
 *
 * A run can fail for reasons that will very likely succeed on a fresh
 * attempt (a gateway hiccup, a rate limit, a network blip, the actor itself
 * timing out before producing any usable records) and reasons that will
 * fail identically every time (bad credentials, an unknown actor id, a
 * malformed input schema). Retrying the first kind is the whole point of
 * this module; retrying the second kind would just burn Apify spend for a
 * guaranteed-identical failure. `ApifyTransientError` is how a provider
 * marks the former so the retry/backoff layer above it (see
 * `lib/server/resilience.ts`'s `withRetry`) knows which failures are worth
 * another attempt.
 */
export class ApifyTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApifyTransientError";
  }
}

/** HTTP statuses worth retrying: gateway/rate-limit/server errors, never 4xx auth/validation. */
export const APIFY_RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Apify run statuses that ended without ever producing a usable result. */
export const APIFY_RETRYABLE_RUN_STATUSES = new Set(["FAILED", "ABORTED", "TIMED-OUT"]);

export function isApifyRetryableHttpStatus(status: number): boolean {
  return APIFY_RETRYABLE_HTTP_STATUSES.has(status);
}
