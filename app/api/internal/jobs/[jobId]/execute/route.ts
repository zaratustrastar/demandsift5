import { apiErrorResponse, ApiError, readJson } from "@/lib/server/http";
import { getStateRepository } from "@/lib/server/repository";
import { runScan } from "@/lib/server/scan-workflow";

type RouteContext = { params: Promise<{ jobId: string }> | { jobId: string } };
type ExecuteBody = { workerId?: unknown };

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

export async function POST(request: Request, context: RouteContext) {
  try {
    requireWorker(request);
    const body = await readJson<ExecuteBody>(request, 4_000);
    if (typeof body.workerId !== "string" || body.workerId.length < 3 || body.workerId.length > 160) {
      throw new ApiError("workerId is invalid.", 400, "invalid_worker_id");
    }
    const { jobId } = await context.params;
    const repository = getStateRepository();
    if (repository.kind !== "postgres") {
      throw new ApiError("Persistent jobs require PostgreSQL.", 503, "worker_unavailable");
    }
    const job = await repository.getJob(jobId);
    if (!job || job.type !== "scan.run") {
      throw new ApiError("Job was not found.", 404, "job_not_found");
    }
    if (job.status !== "running" || job.lockedBy !== body.workerId) {
      throw new ApiError("Job is not claimed by this worker.", 409, "job_not_claimed");
    }
    const scan = await repository.getScan(job.payload.scanId);
    if (!scan || scan.workspaceId !== job.payload.workspaceId) {
      throw new ApiError("Job scan was not found.", 404, "scan_not_found");
    }
    if (scan.status === "complete") {
      return Response.json({ jobId: job.id, scanId: scan.id, status: "complete", duplicate: true });
    }
    const completed = await runScan(scan.id);
    if (completed.status === "running") {
      throw new ApiError(
        "The scan is currently running in another request.",
        409,
        "scan_already_running",
      );
    }
    return Response.json({
      jobId: job.id,
      scanId: completed.id,
      status: completed.status,
      duplicate: false,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
