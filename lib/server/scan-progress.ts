import type { ScanRuntimeProgress } from "../domain/scan-progress";
import type { ScanRecord } from "./contracts";
import { scanPhase } from "./scan-lifecycle";

type ProgressSource = Pick<ScanRecord, "runtimeProgress" | "phase" | "status" | "createdAt" | "analysisCompletedAt" | "redditDiscovery" | "triageCoverage"> & {
  discoveryProfile?: { profileStage?: "fast" | "full" } | null;
  approval?: unknown;
  durableJob?: { acceptedAt: string };
  timing?: { finishedAt?: string };
  execution?: { heartbeatAt: string };
  completionNotice?: ScanRecord["completionNotice"];
};

export function runtimeProgress(scan: ProgressSource): ScanRuntimeProgress {
  return scan.runtimeProgress ??= {
    version: 1, phase: scanPhase(scan), acceptedAt: scan.durableJob?.acceptedAt ?? scan.createdAt,
    analysisStartedAt: null, analysisFinishedAt: scan.analysisCompletedAt ?? null, runStartedAt: null,
    finishedAt: scan.timing?.finishedAt ?? null, heartbeatAt: scan.execution?.heartbeatAt ?? null, lastWorkAt: null,
    queries: { planned: null, succeeded: null, active: null, retrying: null, failed: null, pending: null },
    fetched: null, canonicalEligible: null,
    triage: { expected: null, succeeded: null, unresolved: null, pending: null, promising: null },
    deepReview: { target: null, completed: null, threadsVerified: null }, insights: "unknown",
    results: { qualifiedPeople: null, relevantConversations: null, repliesReady: null },
    discoveryComplete: null, triageComplete: null, coverageComplete: null, partialResultsVersion: 0,
  };
}

/** Called at real stage/checkpoint boundaries, never by lease heartbeats or polls. */
export function recordScanWork(scan: ScanRecord, now = new Date().toISOString()) {
  runtimeProgress(scan).lastWorkAt = now;
}

export function refreshRuntimeProgress(scan: ProgressSource): ScanRuntimeProgress {
  const progress = runtimeProgress(scan);
  progress.phase = scanPhase(scan);
  progress.analysisFinishedAt = scan.analysisCompletedAt ?? progress.analysisFinishedAt;
  progress.finishedAt = scan.timing?.finishedAt ?? progress.finishedAt;
  progress.heartbeatAt = scan.execution?.heartbeatAt ?? progress.heartbeatAt;
  if (scan.redditDiscovery) progress.fetched = scan.redditDiscovery.diagnostics.fetchedCandidates;
  if (scan.triageCoverage) {
    Object.assign(progress.triage, { expected: scan.triageCoverage.expected, succeeded: scan.triageCoverage.succeeded,
      unresolved: scan.triageCoverage.unresolved, pending: scan.triageCoverage.pending });
    progress.triageComplete = scan.triageCoverage.complete;
  }
  // Do not infer full coverage from terminal status: old/degraded scans can
  // complete with missing searches. Thread verification stays a separate count.
  if (progress.discoveryComplete !== null && progress.triageComplete !== null && progress.deepReview.target !== null) {
    progress.coverageComplete = progress.discoveryComplete && progress.triageComplete
      && progress.deepReview.completed !== null && progress.deepReview.completed >= progress.deepReview.target;
  }
  return progress;
}

export type ScanStatusSnapshot = Pick<ScanRecord, "id" | "workspaceId" | "websiteUrl" | "inputMode" | "status" | "progress" | "createdAt" | "updatedAt" | "error" | "errorCode"> & {
  phase: ScanRuntimeProgress["phase"];
  analysisReady: boolean;
  durableAccepted: boolean;
  runtimeProgress: ScanRuntimeProgress;
  completionNotice: ScanRecord["completionNotice"] | null;
};

/** Same allow-list as the PostgreSQL projection. No evidence, profile, tokens or result bodies. */
export type ScanStatusSource = Pick<ScanRecord, "id" | "workspaceId" | "websiteUrl" | "inputMode" | "progress" | "updatedAt" | "error" | "errorCode"> & ProgressSource;
export function scanStatusSnapshot(scan: ScanStatusSource): ScanStatusSnapshot {
  return { id: scan.id, workspaceId: scan.workspaceId, websiteUrl: scan.websiteUrl, inputMode: scan.inputMode ?? "website",
    status: scan.status, phase: scanPhase(scan), progress: scan.progress, createdAt: scan.createdAt, updatedAt: scan.updatedAt,
    error: scan.error, errorCode: scan.errorCode ?? null,
    analysisReady: !!scan.discoveryProfile && scan.discoveryProfile.profileStage !== "fast", durableAccepted: !!scan.durableJob,
    runtimeProgress: refreshRuntimeProgress(scan), completionNotice: scan.completionNotice ?? null };
}
