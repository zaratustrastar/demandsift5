/** Bounded public read model. Null means unknown (not zero), especially on old scans. */
export type ScanRuntimeProgress = {
  version: 1;
  phase: "created" | "analysis_queued" | "analyzing" | "awaiting_review" | "scan_queued" | "scanning" | "complete" | "failed";
  acceptedAt: string;
  analysisStartedAt: string | null;
  analysisFinishedAt: string | null;
  runStartedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  lastWorkAt: string | null;
  queries: { planned: number | null; succeeded: number | null; active: number | null; retrying: number | null; failed: number | null; pending: number | null };
  fetched: number | null;
  canonicalEligible: number | null;
  triage: { expected: number | null; succeeded: number | null; unresolved: number | null; pending: number | null; promising: number | null };
  deepReview: { target: number | null; completed: number | null; threadsVerified: number | null };
  insights: "pending" | "active" | "complete" | "fallback" | "unknown";
  results: { qualifiedPeople: number | null; relevantConversations: number | null; repliesReady: number | null };
  discoveryComplete: boolean | null;
  triageComplete: boolean | null;
  /** Required discovery/triage/deep review coverage; not a claim of thread fetching. */
  coverageComplete: boolean | null;
  partialResultsVersion: number;
};
