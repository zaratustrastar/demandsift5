import { createTriageDispatcher, triageInputVersion } from "../ai/triage-dispatcher";
import { cleanDiscoveryCandidates } from "../intelligence/reddit-pipeline";
import { isUsableTriageJudgment } from "../providers/openai.server";
import type { AiProvider, TriageConversationsRequest } from "../providers/contracts";
import type { ConversationTriage, RedditDiscoveryCandidate } from "../domain/types";

export type DiscoveryTriageCheckpoint = {
  version: 1;
  /** Bounded reservation ledger across attempts, including superseded versions. */
  submittedVersions: string[];
  judgments: Record<string, { externalId: string; triage: ConversationTriage }>;
};
export const newDiscoveryTriageCheckpoint = (): DiscoveryTriageCheckpoint => ({ version: 1, submittedVersions: [], judgments: {} });

/** Speculation is optional and bounded. Final cleaning + global embedding
 * selection remain outside this coordinator and authoritative. No shortlist,
 * negative decision or completion status is inferred from this early pool. */
export function createDiscoveryTriageCoordinator(options: {
  provider: Pick<AiProvider, "triageConversations">;
  request: Omit<TriageConversationsRequest, "candidates" | "resumeFrom" | "resumeProcessing">;
  since: string; checkpoint: DiscoveryTriageCheckpoint;
  maxCandidates?: number; flushDelayMs?: number; now?: () => Date;
  batchSize?: number; concurrency?: number;
  onCheckpoint: () => Promise<void>;
  onProgress?: (progress: { eligible: number; succeeded: number; promising: number }) => void;
}) {
  const maximum = Number.isFinite(options.maxCandidates) ? Math.max(0, Math.min(200, Math.floor(options.maxCandidates!))) : 100;
  const delay = Number.isFinite(options.flushDelayMs) ? Math.max(0, Math.min(10_000, options.flushDelayMs!)) : 1_000;
  const reserved = new Set(options.checkpoint.submittedVersions);
  let latest: RedditDiscoveryCandidate[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false, failed = false;
  const updateProgress = () => {
    const successful = latest.flatMap(candidate => {
      const saved = options.checkpoint.judgments[triageInputVersion(options.request, candidate)];
      return saved?.externalId === candidate.externalId && isUsableTriageJudgment(saved.triage, candidate.externalId) ? [saved.triage] : [];
    });
    options.onProgress?.({ eligible: latest.length, succeeded: successful.length,
      promising: successful.filter(item => item.worthEnriching).length });
  };
  const dispatcher = createTriageDispatcher(options.provider, options.request, {
    batchSize: options.batchSize, concurrency: options.concurrency,
    onJudgments: async (items, versions) => {
      for (const item of items) {
        const version = versions.get(item.externalId);
        if (version && reserved.has(version) && isUsableTriageJudgment(item.triage, item.externalId)) {
          options.checkpoint.judgments[version] = { externalId: item.externalId, triage: item.triage };
        }
      }
      updateProgress(); await options.onCheckpoint();
    },
  });
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    offer(cumulative: readonly RedditDiscoveryCandidate[]) {
      if (closed || failed || options.request.signal?.aborted) return;
      // Re-clean at the current wall clock. Later timestamps and richer
      // duplicates can legitimately become eligible; no creation-time ceiling.
      latest = cleanDiscoveryCandidates({ candidates: [...cumulative], business: options.request.business,
        since: options.since, now: options.now?.() ?? new Date() }).survivors;
      const fresh: RedditDiscoveryCandidate[] = [];
      for (const candidate of latest) {
        const version = triageInputVersion(options.request, candidate);
        if (reserved.has(version) || reserved.size >= maximum) continue;
        reserved.add(version); options.checkpoint.submittedVersions.push(version); fresh.push(candidate);
      }
      try { dispatcher.submit(fresh); }
      catch { failed = true; }
      updateProgress();
      if (!timer && dispatcher.queuedItems && !failed) timer = setTimeout(() => { timer = undefined; dispatcher.flush(); }, delay);
    },
    async finish(finalCandidates: readonly RedditDiscoveryCandidate[]) {
      closed = true; clearTimer();
      latest = [...finalCandidates];
      try { await dispatcher.drain(); }
      catch { failed = true; options.request.signal?.throwIfAborted(); }
      finally { dispatcher.dispose(); }
      const retained = new Map<string, ConversationTriage>();
      const finalVersions = new Set<string>();
      for (const candidate of finalCandidates) {
        const version = triageInputVersion(options.request, candidate); finalVersions.add(version);
        const saved = options.checkpoint.judgments[version];
        if (saved?.externalId === candidate.externalId && isUsableTriageJudgment(saved.triage, candidate.externalId)) retained.set(candidate.externalId, saved.triage);
      }
      return { retained, results: dispatcher.completedBatches.map(batch => batch.result), failed,
        submitted: reserved.size, reused: retained.size,
        supersededOrExcluded: [...reserved].filter(version => !finalVersions.has(version)).length };
    },
    async stop() {
      closed = true; clearTimer(); dispatcher.cancel();
      try { await dispatcher.drain(); } catch { /* Preserve the scan's primary failure. */ }
      finally { dispatcher.dispose(); }
    },
  };
}
