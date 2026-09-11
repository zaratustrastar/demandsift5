import { createHash } from "node:crypto";
import { BoundedBatchDispatcher } from "./bounded-dispatcher";
import type { AiProvider, TriageConversationsRequest, TriageConversationsResult, TriagedConversation } from "@/lib/providers/contracts";
import type { RedditDiscoveryCandidate } from "@/lib/domain/types";

export const TRIAGE_INPUT_VERSION = "triage-v1-full-evidence";
export const TRIAGE_COMPACT_INPUT_VERSION = "triage-v2-full-evidence-compact-explanations";

/** Stable object keys, preserved array order and evidence values. Deliberately
 * hashes the complete candidate (including metadata), not only its body. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function triageInputVersion(request: Pick<TriageConversationsRequest, "business" | "models" | "compactOutput">, candidate: RedditDiscoveryCandidate): string {
  return createHash("sha256").update(canonicalJson({ version: request.compactOutput ? TRIAGE_COMPACT_INPUT_VERSION : TRIAGE_INPUT_VERSION,
    business: request.business, models: request.models, candidate })).digest("hex");
}

/** One instance per scan, not one pool per discovery chunk. The provider retains
 * parsing, repair, fallback, coverage, and output semantics. Exact versions are
 * captured before dispatch; later discovery cannot mutate in-flight evidence. */
export function createTriageDispatcher(
  provider: Pick<AiProvider, "triageConversations">,
  request: Omit<TriageConversationsRequest, "candidates">,
  options: {
    batchSize?: number; concurrency?: number; now?: () => number;
    onJudgments?: (items: readonly TriagedConversation[], versions: ReadonlyMap<string, string>) => void | Promise<void>;
  } = {},
) {
  const context = { ...request, business: structuredClone(request.business), models: structuredClone(request.models) };
  const submitted = new Map<string, string>();
  const dispatcher = new BoundedBatchDispatcher<RedditDiscoveryCandidate, TriageConversationsResult>({
    batchSize: options.batchSize ?? 25, concurrency: options.concurrency ?? 4, signal: request.signal, now: options.now,
    process: (items, signal) => {
      const versions = new Map(items.map(item => [item.value.externalId, item.key]));
      return provider.triageConversations({ ...context, signal, candidates: items.map(item => item.value),
        onBatchSucceeded: async judgments => {
          await request.onBatchSucceeded?.(judgments);
          await options.onJudgments?.(judgments, versions);
        },
      });
    },
  });
  return {
    submit(candidates: readonly RedditDiscoveryCandidate[]) {
      // A single batch must not contain two versions of the same external ID.
      // Flush the earlier version first; the dispatcher still deduplicates keys.
      for (const candidate of candidates) {
        const key = triageInputVersion(context, candidate);
        const previous = submitted.get(candidate.externalId);
        if (previous === key) continue;
        if (previous) dispatcher.flush();
        submitted.set(candidate.externalId, key);
        dispatcher.submit([{ key, value: candidate }]);
      }
    },
    flush: () => dispatcher.flush(), drain: () => dispatcher.drain(),
    cancel: (reason?: unknown) => dispatcher.cancel(reason), dispose: () => dispatcher.dispose(),
    get signal() { return dispatcher.signal; },
    get queuedItems() { return dispatcher.queuedItems; },
    get activeBatches() { return dispatcher.activeBatches; },
    get completedBatches() { return dispatcher.completedBatches; },
  };
}
