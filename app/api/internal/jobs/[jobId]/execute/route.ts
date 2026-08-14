import { apiErrorResponse, ApiError, readJson } from "@/lib/server/http";
import { OpenAiProviderError } from "@/lib/providers/openai.server";
import { getStateRepository, type StateRepository } from "@/lib/server/repository";
import { runScan } from "@/lib/server/scan-workflow";
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
  const code = /structured (?:chat )?(?:json|output)/iu.test(message)
    ? "openai_structured_output_failed"
    : /reddit enrichment/iu.test(message)
      ? "reddit_enrichment_failed"
      : "scan_execution_failed";
  return {
    ok: false,
    executorStatus: 502,
    error: { code, message },
  };
}

const activeScanExecutions = new Map<string, Promise<void>>();

async function executeClaimedScan(scanId: string, resumeRunning = false): Promise<void> {
  try {
    await runScan(scanId, { resumeRunning });
  } catch (error) {
    if (error instanceof OpenAiProviderError && /structured (?:chat )?(?:JSON|output)/i.test(error.message)) {
      console.error("Background scan exhausted structured AI recovery.");
      return;
    }
    console.error("Background scan execution failed.", error);
  }
}

function ensureClaimedScanExecution(scanId: string, resumeRunning = false): Promise<void> {
  const existing = activeScanExecutions.get(scanId);
  if (existing) return existing;
  const execution = executeClaimedScan(scanId, resumeRunning);
  activeScanExecutions.set(scanId, execution);
  void execution.finally(() => {
    if (activeScanExecutions.get(scanId) === execution) activeScanExecutions.delete(scanId);
  });
  return execution;
}

function executionSnapshot(job: ClaimedJob, scan: ScanRecord) {
  if (scan.status === "failed") return terminalScanFailure(scan);
  return {
    ok: true,
    jobId: job.id,
    scanId: scan.id,
    status: scan.status,
    complete: scan.status === "complete",
  };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireWorker(request);
    const body = await readJson<ExecuteBody>(request, 4_000);
    if (typeof body.workerId !== "string" || body.workerId.length < 3 || body.workerId.length > 160) {
      throw new ApiError("workerId is invalid.", 400, "invalid_worker_id");
    }
    const { jobId } = await context.params;
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
    void ensureClaimedScanExecution(scan.id, true);
    return Response.json(executionSnapshot(job, scan), {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  }

  // The VPS is a persistent Node process, not a request-scoped serverless
    // function. Start the durable scan and release the HTTP request immediately.
    // Worker and browser status checks are then independent short requests, so
    // no proxy/server timeout can terminate a long-running scan.
    void ensureClaimedScanExecution(scan.id, false);
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
    const { job, scan } = await requireClaimedScan(jobId, workerId);
    return Response.json(executionSnapshot(job, scan), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
