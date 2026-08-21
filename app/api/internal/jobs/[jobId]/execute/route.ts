import { apiErrorResponse, ApiError, readJson } from "@/lib/server/http";
import { OpenAiProviderError } from "@/lib/providers/openai.server";
import { getStateRepository, type StateRepository } from "@/lib/server/repository";
import { runScan } from "@/lib/server/scan-workflow";
import { runRedditMonitorScan } from "@/lib/server/reddit-monitor-workflow";
import {
  getClaimedRedditMonitorJob,
  getRedditMonitorRun,
} from "@/lib/server/reddit-monitor-repository";
import { runAiVisibilityScan } from "@/lib/server/ai-visibility-workflow";
import {
  getAiVisibilityScan,
  getClaimedAiVisibilityJob,
} from "@/lib/server/ai-visibility-repository";
import type { ScanRecord } from "@/lib/server/contracts";

type RouteContext = { params: Promise<{ jobId: string }> | { jobId: string } };
type ExecuteBody = { workerId?: unknown };
type ClaimedJob = NonNullable<Awaited<ReturnType<StateRepository["getJob"]>>>;

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireWorker(request: Request) {
  const secret = process.env.BACKGROUND_WORKER_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(
      "Background worker authentication is not configured.",
      503,
      "worker_unavailable",
    );
  }
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(secret, supplied)) {
    throw new ApiError("Worker authentication failed.", 401, "unauthorized");
  }
}

async function requireClaimedScan(
  jobId: string,
  workerId: string,
): Promise<{ job: ClaimedJob; scan: ScanRecord }> {
  const repository = getStateRepository();
  if (repository.kind !== "postgres") {
    throw new ApiError("Persistent jobs require PostgreSQL.", 503, "worker_unavailable");
  }
  const job = await repository.getJob(jobId);
  if (!job || job.type !== "scan.run") {
    throw new ApiError("Job was not found.", 404, "job_not_found");
  }
  if (job.status !== "running" || job.lockedBy !== workerId) {
    throw new ApiError("Job is not claimed by this worker.", 409, "job_not_claimed");
  }
  const scan = await repository.getScan(job.payload.scanId);
  if (!scan || scan.workspaceId !== job.payload.workspaceId) {
    throw new ApiError("Job scan was not found.", 404, "scan_not_found");
  }
  return { job, scan };
}

function terminalScanFailure(scan: ScanRecord) {
  const message = scan.error?.trim() || "The scan failed unexpectedly.";
  // Prefer the structured code runScan already classified the error into;
  // only fall back to regexing the message for scan records written before
  // errorCode existed.
  const code =
    scan.errorCode ??
    (/structured (?:chat )?(?:json|output)/iu.test(message)
      ? "openai_structured_output_failed"
      : /reddit enrichment/iu.test(message)
        ? "reddit_enrichment_failed"
        : /reddit discovery/iu.test(message)
          ? "reddit_discovery_failed"
          : "scan_execution_failed");
  return {
    ok: false,
    executorStatus: 502,
    error: { code, message },
  };
}

const activeScanExecutions = new Map<string, Promise<void>>();
const activeMonitorExecutions = new Map<string, Promise<void>>();

async function executeClaimedScan(
  scanId: string,
  resumeRunning = false,
  jobAttempts?: number,
  jobMaxAttempts?: number,
): Promise<void> {
  try {
    await runScan(scanId, { resumeRunning, jobAttempts, jobMaxAttempts });
  } catch (error) {
    if (error instanceof OpenAiProviderError && /structured (?:chat )?(?:JSON|output)/i.test(error.message)) {
      console.error("Background scan exhausted structured AI recovery.");
      return;
    }
    console.error("Background scan execution failed.", error);
  }
}

function ensureClaimedScanExecution(
  scanId: string,
  resumeRunning = false,
  jobAttempts?: number,
  jobMaxAttempts?: number,
): Promise<void> {
  const existing = activeScanExecutions.get(scanId);
  if (existing) return existing;
  const execution = executeClaimedScan(scanId, resumeRunning, jobAttempts, jobMaxAttempts);
  activeScanExecutions.set(scanId, execution);
  void execution.finally(() => {
    if (activeScanExecutions.get(scanId) === execution) activeScanExecutions.delete(scanId);
  });
  return execution;
}

function executionSnapshot(job: ClaimedJob, scan: ScanRecord) {
  // "retrying" is not done executing from the job's point of view either --
  // this attempt still ended without a result, so the worker still needs to
  // see a failure response to run its own retry/backoff bookkeeping. The
  // difference already happened where it matters: the scan record itself
  // never sat at a terminal-looking "failed" while a retry was scheduled.
  if (scan.status === "failed" || scan.status === "retrying") return terminalScanFailure(scan);
  return {
    ok: true,
    jobId: job.id,
    scanId: scan.id,
    status: scan.status,
    complete: scan.status === "complete",
  };
}

function monitorExecutionSnapshot(jobId: string, run: NonNullable<Awaited<ReturnType<typeof getRedditMonitorRun>>>) {
  if (run.status === "failed") {
    return {
      ok: false,
      executorStatus: 502,
      error: { code: "reddit_monitor_failed", message: run.error || "Reddit monitoring failed." },
    };
  }
  return {
    ok: true,
    jobId,
    monitorRunId: run.id,
    scanId: run.scanId,
    status: run.status,
    complete: run.status === "succeeded",
  };
}

function ensureMonitorExecution(runId: string): Promise<void> {
  const existing = activeMonitorExecutions.get(runId);
  if (existing) return existing;
  const execution = runRedditMonitorScan(runId).then(() => undefined).catch((error) => {
    console.error("Background Reddit monitor execution failed.", error);
  });
  activeMonitorExecutions.set(runId, execution);
  void execution.finally(() => {
    if (activeMonitorExecutions.get(runId) === execution) activeMonitorExecutions.delete(runId);
  });
  return execution;
}

async function claimedMonitorSnapshot(jobId: string, workerId: string, start: boolean) {
  const job = await getClaimedRedditMonitorJob(jobId, workerId);
  if (!job) return null;
  const run = await getRedditMonitorRun(job.monitorRunId);
  if (!run || run.workspaceId !== job.workspaceId) {
    throw new ApiError("Reddit monitor run was not found.", 404, "monitor_run_not_found");
  }
  if (start && run.status !== "succeeded" && run.status !== "failed") {
    void ensureMonitorExecution(run.id);
  }
  const snapshot = monitorExecutionSnapshot(job.id, run);
  return Response.json(snapshot, {
    status: snapshot.ok && !snapshot.complete ? 202 : 200,
    headers: { "cache-control": "no-store" },
  });
}

const activeVisibilityExecutions = new Map<string, Promise<void>>();

function visibilityExecutionSnapshot(
  jobId: string,
  scan: NonNullable<Awaited<ReturnType<typeof getAiVisibilityScan>>>,
) {
  if (scan.status === "failed") {
    return {
      ok: false,
      executorStatus: 502,
      error: { code: "ai_visibility_scan_failed", message: scan.error || "AI visibility tracking failed." },
    };
  }
  return {
    ok: true,
    jobId,
    visibilityScanId: scan.id,
    status: scan.status,
    complete: scan.status === "succeeded",
  };
}

function ensureVisibilityExecution(visibilityScanId: string): Promise<void> {
  const existing = activeVisibilityExecutions.get(visibilityScanId);
  if (existing) return existing;
  const execution = runAiVisibilityScan(visibilityScanId).then(() => undefined).catch((error) => {
    console.error("Background AI visibility scan execution failed.", error);
  });
  activeVisibilityExecutions.set(visibilityScanId, execution);
  void execution.finally(() => {
    if (activeVisibilityExecutions.get(visibilityScanId) === execution) activeVisibilityExecutions.delete(visibilityScanId);
  });
  return execution;
}

async function claimedVisibilitySnapshot(jobId: string, workerId: string, start: boolean) {
  const job = await getClaimedAiVisibilityJob(jobId, workerId);
  if (!job) return null;
  const scan = await getAiVisibilityScan(job.visibilityScanId);
  if (!scan || scan.workspaceId !== job.workspaceId) {
    throw new ApiError("AI visibility scan was not found.", 404, "ai_visibility_scan_not_found");
  }
  if (start && scan.status !== "succeeded" && scan.status !== "failed") {
    void ensureVisibilityExecution(scan.id);
  }
  const snapshot = visibilityExecutionSnapshot(job.id, scan);
  return Response.json(snapshot, {
    status: snapshot.ok && !snapshot.complete ? 202 : 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireWorker(request);
    const body = await readJson<ExecuteBody>(request, 4_000);
    if (typeof body.workerId !== "string" || body.workerId.length < 3 || body.workerId.length > 160) {
      throw new ApiError("workerId is invalid.", 400, "invalid_worker_id");
    }
    const { jobId } = await context.params;
    const monitorResponse = await claimedMonitorSnapshot(jobId, body.workerId, true);
    if (monitorResponse) return monitorResponse;
    const visibilityResponse = await claimedVisibilitySnapshot(jobId, body.workerId, true);
    if (visibilityResponse) return visibilityResponse;
    const { job, scan } = await requireClaimedScan(jobId, body.workerId);
    if (scan.status === "complete" || scan.status === "failed") {
    return Response.json(executionSnapshot(job, scan), {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }
  if (scan.status === "running") {
    // If this web process restarted, no execution is registered for the
    // persisted running scan. Resume it instead of blocking the queue.
    void ensureClaimedScanExecution(scan.id, true, job.attempts, job.maxAttempts);
    return Response.json(executionSnapshot(job, scan), {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  }

  // The VPS is a persistent Node process, not a request-scoped serverless
    // function. Start the durable scan and release the HTTP request immediately.
    // Worker and browser status checks are then independent short requests, so
    // no proxy/server timeout can terminate a long-running scan. This also
    // covers a scan left at "retrying" by a prior attempt's failure: this
    // POST only happens once the worker has freshly reclaimed the job, so
    // it starts a brand-new attempt rather than resuming a stale one.
    void ensureClaimedScanExecution(scan.id, false, job.attempts, job.maxAttempts);
    return Response.json(
      { ok: true, jobId: job.id, scanId: scan.id, status: "starting", complete: false },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    requireWorker(request);
    const workerId = new URL(request.url).searchParams.get("workerId") ?? "";
    if (workerId.length < 3 || workerId.length > 160) {
      throw new ApiError("workerId is invalid.", 400, "invalid_worker_id");
    }
    const { jobId } = await context.params;
    const monitorResponse = await claimedMonitorSnapshot(jobId, workerId, false);
    if (monitorResponse) return monitorResponse;
    const visibilityResponse = await claimedVisibilitySnapshot(jobId, workerId, false);
    if (visibilityResponse) return visibilityResponse;
    const { job, scan } = await requireClaimedScan(jobId, workerId);
    return Response.json(executionSnapshot(job, scan), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
