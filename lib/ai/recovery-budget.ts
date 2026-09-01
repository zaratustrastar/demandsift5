import { abortableDelay } from "./bounded-dispatcher";

export type AiRecoveryEntry = { requests: number; firstRequestedAt: number; deadlineAt: number; notBefore?: Record<string, number> };
export type AiRecoveryLedger = Record<string, AiRecoveryEntry>;
export class AiRecoveryExhaustedError extends Error {
  readonly code = "ai_recovery_exhausted";
  constructor(readonly reason: "attempts" | "deadline") {
    super(`AI recovery ${reason === "attempts" ? "request budget" : "deadline"} exhausted. Saved judgments are retained; coverage is incomplete.`);
  }
}

/** Retry-After is a minimum, not a value to cap below the server's request. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header?.trim()) return undefined;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1_000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (/^[+-]?\d/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : undefined;
}

export type AiRecoveryScope = ReturnType<AiRecoveryBudget["scope"]>;

/** Exact-input counters persist across HTTP/repair/coverage/split/fallback/job
 * layers. Reservations are durable before dispatch; ambiguous transport does
 * not refund them. Successful judgments bypass the budget via checkpoints. */
export class AiRecoveryBudget {
  readonly maxRequests: number;
  readonly deadlineMs: number;
  constructor(private readonly options: {
    ledger: AiRecoveryLedger; onChange?: () => Promise<void>;
    maxRequests?: number; deadlineMs?: number; now?: () => number;
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }) {
    this.maxRequests = Number.isFinite(options.maxRequests) ? Math.max(3, Math.min(60, Math.floor(options.maxRequests!))) : 20;
    this.deadlineMs = Number.isFinite(options.deadlineMs) ? Math.max(30_000, Math.min(1_800_000, options.deadlineMs!)) : 900_000;
  }
  now() { return (this.options.now ?? Date.now)(); }
  scope(inputKeys: readonly string[]) {
    const keys = [...new Set(inputKeys)];
    if (!keys.length || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error("Recovery requires hashed exact input identities.");
    const now = () => this.now();
    const remaining = () => {
      const end = Math.min(...keys.map(key => this.options.ledger[key]?.deadlineAt ?? now() + this.deadlineMs));
      const ms = end - now();
      if (ms <= 0) throw new AiRecoveryExhaustedError("deadline");
      return ms;
    };
    const wait = async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (ms >= remaining()) throw new AiRecoveryExhaustedError("deadline");
      await (this.options.delay ?? abortableDelay)(ms, signal);
    };
    return {
      remaining,
      wait,
      waitUntilReady: async (route: string, signal?: AbortSignal) => {
        const notBefore = Math.max(...keys.map(key => this.options.ledger[key]?.notBefore?.[route] ?? 0));
        if (notBefore > now()) await wait(notBefore - now(), signal);
      },
      defer: async (route: string, ms: number) => {
        for (const key of keys) {
          const entry = this.options.ledger[key];
          if (!entry) continue;
          entry.notBefore ??= {};
          entry.notBefore[route] = Math.max(entry.notBefore[route] ?? 0, now() + ms);
        }
        await this.options.onChange?.();
      },
      reserve: async (signal?: AbortSignal) => {
        signal?.throwIfAborted(); remaining();
        for (const key of keys) if ((this.options.ledger[key]?.requests ?? 0) >= this.maxRequests) throw new AiRecoveryExhaustedError("attempts");
        const at = now();
        for (const key of keys) {
          const entry = this.options.ledger[key] ??= { requests: 0, firstRequestedAt: at, deadlineAt: at + this.deadlineMs };
          entry.requests++;
        }
        await this.options.onChange?.(); signal?.throwIfAborted();
        return Math.max(...keys.map(key => this.options.ledger[key].requests));
      },
    };
  }
}
