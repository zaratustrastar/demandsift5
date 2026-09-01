import { randomUUID } from "node:crypto";

/** Deliberately closed metadata vocabulary. Never accept arbitrary payloads. */
export type TraceAttributes = {
  provider?: string; model?: string; route?: string; operation?: string; stage?: string;
  category?: string; configId?: string; revision?: string; actorRunId?: string;
  attempt?: number; statusCode?: number; candidates?: number; pages?: number;
  queries?: number; completed?: number; unresolved?: number; inputTokens?: number;
  outputTokens?: number; cachedInputTokens?: number; retryDelayMs?: number;
  queueWaitMs?: number; firstResult?: boolean;
  triageBudget?: number; reviewBudget?: number; acquisitionTarget?: number; embeddingFloor?: number;
  requiredFullContext?: number; websitePageBudget?: number; replyConcurrency?: number;
  providerTimeoutMs?: number; triageConcurrency?: number; triageBatchSize?: number;
  actorConcurrency?: number; postsPerQuery?: number;
};
export type TraceEvent = {
  version: 1; scanId: string; jobId?: string; executionId: string; jobAttempt: number;
  spanId?: string; event: "start" | "end" | "milestone"; name: string; at: string;
  durationMs?: number; outcome?: "succeeded" | "failed"; attributes: TraceAttributes;
};

const numericKeys = new Set([
  "attempt", "statusCode", "candidates", "pages", "queries", "completed", "unresolved",
  "inputTokens", "outputTokens", "cachedInputTokens", "retryDelayMs", "queueWaitMs",
  "triageBudget", "reviewBudget", "acquisitionTarget", "embeddingFloor", "requiredFullContext",
  "websitePageBudget", "replyConcurrency", "providerTimeoutMs", "triageConcurrency", "triageBatchSize", "actorConcurrency", "postsPerQuery",
]);
const stringKeys = new Set([
  "provider", "model", "route", "operation", "stage", "category", "configId", "revision", "actorRunId",
]);
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)
    && !/^(sk-|Bearer|eyJ)/i.test(value) && !value.includes("://") ? value : undefined;
}
function attributes(input: TraceAttributes): TraceAttributes {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (numericKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    if (stringKeys.has(key)) { const safe = identifier(value); if (safe) result[key] = safe; }
    if (key === "firstResult" && typeof value === "boolean") result[key] = value;
  }
  return result;
}

export function createScanTrace(context: { scanId: string; jobId?: string; jobAttempt?: number }, options: {
  sink?: (event: TraceEvent) => void | Promise<void>;
  monotonicNow?: () => number;
  wallNow?: () => string;
} = {}) {
  const executionId = randomUUID();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date().toISOString());
  const sink = options.sink ?? ((event) => { console.info(JSON.stringify({ type: "scan_trace", ...event })); });
  const emit = (event: Omit<TraceEvent, "version" | "scanId" | "jobId" | "executionId" | "jobAttempt" | "at">) => {
    // Do not await a collector: both rejection and a hung collector are harmless.
    try {
      void Promise.resolve(sink({ version: 1, scanId: identifier(context.scanId) ?? "redacted",
        ...(identifier(context.jobId) ? { jobId: identifier(context.jobId) } : {}), executionId,
        jobAttempt: Math.max(1, context.jobAttempt ?? 1), at: wallNow(), ...event,
        name: identifier(event.name) ?? "unknown", attributes: attributes(event.attributes),
      })).catch(() => {});
    } catch { /* Observability must never change scan execution. */ }
  };
  const start = (name: string, initial: TraceAttributes = {}) => {
    const spanId = randomUUID();
    const began = monotonicNow();
    let finished = false;
    emit({ event: "start", name, spanId, attributes: initial });
    return (outcome: "succeeded" | "failed", final: TraceAttributes = {}) => {
      if (finished) return;
      finished = true;
      emit({ event: "end", name, spanId, outcome, durationMs: Math.max(0, monotonicNow() - began), attributes: { ...initial, ...final } });
    };
  };
  return {
    executionId, start,
    milestone(name: string, data: TraceAttributes = {}) { emit({ event: "milestone", name, attributes: data }); },
    async measure<T>(name: string, work: () => Promise<T>, data: TraceAttributes = {}): Promise<T> {
      const finish = start(name, data);
      try { const value = await work(); finish("succeeded"); return value; }
      catch (error) { finish("failed", { category: "operation_failed" }); throw error; }
    },
  };
}

export type ScanTrace = ReturnType<typeof createScanTrace>;

/** One span per public provider operation, not additive fake stage durations. */
export function traceProvider<T extends object>(provider: T, trace: ScanTrace, methods: readonly string[]): T {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (!methods.includes(String(property))) return value.bind(target);
      return (...args: unknown[]) => {
        const request = args[0] as { candidates?: unknown[]; conversations?: unknown[]; pages?: unknown[] } | undefined;
        return trace.measure(String(property), () => value.apply(target, args), {
          candidates: request?.candidates?.length ?? request?.conversations?.length,
          pages: request?.pages?.length,
        });
      };
    },
  });
}
