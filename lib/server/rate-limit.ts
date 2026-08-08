import { ApiError } from "./http";

type Bucket = { count: number; resetAt: number };
type RateLimitState = Map<string, Bucket>;
const RATE_LIMIT_KEY = "__signalScoutRateLimits";

function state(): RateLimitState {
  const globalState = globalThis as typeof globalThis & {
    [RATE_LIMIT_KEY]?: RateLimitState;
  };
  globalState[RATE_LIMIT_KEY] ??= new Map();
  return globalState[RATE_LIMIT_KEY];
}

function requestAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function assertRateLimit(
  request: Request,
  scope: string,
  options: { limit: number; windowMs: number },
) {
  const now = Date.now();
  const key = `${scope}:${requestAddress(request)}`;
  const limits = state();
  const existing = limits.get(key);
  const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : existing;
  bucket.count += 1;
  limits.set(key, bucket);
  if (bucket.count > options.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw new ApiError(
      `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      429,
      "rate_limited",
    );
  }
}
