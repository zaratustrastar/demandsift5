import type { ScanRuntimeProgress } from "../domain/scan-progress";

/** Persisted intervals exclude time waiting for the user's review and queue acceptance. */
export function scanElapsedMs(progress: ScanRuntimeProgress | undefined, now: number): number | null {
  if (!progress?.analysisStartedAt && !progress?.runStartedAt) return null;
  const interval = (start: string | null, end: string | null) => {
    if (!start) return 0;
    const from = Date.parse(start), to = end ? Date.parse(end) : now;
    return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
  };
  return interval(progress.analysisStartedAt, progress.analysisFinishedAt ?? progress.finishedAt)
    + interval(progress.runStartedAt, progress.finishedAt);
}
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function progressDetail(id: string, progress: ScanRuntimeProgress | undefined, fallback: string): string {
  if (!progress) return fallback;
  const { queries, triage, deepReview, results } = progress;
  if (id === "discovery" && queries.planned !== null) {
    return `${queries.succeeded ?? 0} of ${queries.planned} searches finished.`
      + (queries.retrying ? ` ${queries.retrying} ${queries.retrying === 1 ? "search is" : "searches are"} retrying; other work can continue.` : "")
      + (queries.failed ? ` ${queries.failed} ${queries.failed === 1 ? "search has" : "searches have"} not completed successfully. Coverage is limited.` : "");
  }
  if (id === "triage" && triage.succeeded !== null) {
    return `${triage.succeeded} discussions reviewed${progress.discoveryComplete === false ? "; more results may arrive" : ""}.`
      + (triage.promising !== null ? ` ${triage.promising} look promising for deeper review.` : "")
      + (triage.unresolved ? ` ${triage.unresolved} checks remain unresolved—not rejected as irrelevant.` : "");
  }
  if (id === "enrichment" && deepReview.target !== null) return `${deepReview.target} conversations selected for deeper checks. ${deepReview.threadsVerified ?? 0} additional public threads verified.`;
  if (id === "qualification" && deepReview.target !== null) return `${deepReview.completed ?? 0} of ${deepReview.target} selected conversations checked in depth.`
    + (results.qualifiedPeople !== null ? ` ${results.qualifiedPeople} potential customers identified.` : "");
  if (id === "replies" && results.repliesReady !== null) return `${results.repliesReady} reply drafts saved. Replies are only prepared where appropriate.`;
  return fallback;
}
