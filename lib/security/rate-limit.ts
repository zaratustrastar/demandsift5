export interface RateLimitStore {
  increment(key: string, windowStartedAt: number, ttlMs: number): Promise<number>;
}

export interface RateLimitPolicy {
  namespace: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

export class RateLimitExceededError extends Error {
  readonly decision: RateLimitDecision;

  constructor(decision: RateLimitDecision) {
    super(`Rate limit exceeded. Retry in ${decision.retryAfterSeconds} seconds.`);
    this.name = "RateLimitExceededError";
    this.decision = decision;
  }
}

/**
 * Store-agnostic fixed-window limiter. Use a PostgreSQL/Redis implementation in
 * multi-instance production; the included memory store is for local/demo use.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  policy: RateLimitPolicy,
  subject: string,
  now = new Date(),
): Promise<RateLimitDecision> {
  if (!Number.isInteger(policy.limit) || policy.limit <= 0 || policy.windowMs < 1_000) {
    throw new Error("Rate-limit policy requires a positive limit and a window of at least one second.");
  }
  const current = now.getTime();
  const windowStartedAt = Math.floor(current / policy.windowMs) * policy.windowMs;
  const resetAtMs = windowStartedAt + policy.windowMs;
  const safeSubject = subject.trim();
  if (!safeSubject) throw new Error("A rate-limit subject is required.");
  const count = await store.increment(
    `${policy.namespace}:${safeSubject}`,
    windowStartedAt,
    resetAtMs - current + 1_000,
  );
  const allowed = count <= policy.limit;
  return {
    allowed,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetAt: new Date(resetAtMs),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - current) / 1_000)),
  };
}

export async function enforceRateLimit(
  store: RateLimitStore,
  policy: RateLimitPolicy,
  subject: string,
  now = new Date(),
): Promise<RateLimitDecision> {
  const decision = await checkRateLimit(store, policy, subject, now);
  if (!decision.allowed) throw new RateLimitExceededError(decision);
  return decision;
}

interface MemoryBucket {
  count: number;
  expiresAt: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, MemoryBucket>();

  async increment(key: string, windowStartedAt: number, ttlMs: number): Promise<number> {
    const now = Date.now();
    if (this.buckets.size > 5_000) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.expiresAt <= now) this.buckets.delete(bucketKey);
      }
    }
    const bucketKey = `${key}:${windowStartedAt}`;
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.expiresAt <= now) {
      this.buckets.set(bucketKey, { count: 1, expiresAt: now + ttlMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}
