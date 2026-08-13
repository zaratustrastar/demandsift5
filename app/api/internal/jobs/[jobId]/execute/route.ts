import { apiErrorResponse, ApiError, readJson } from "@/lib/server/http";
import { OpenAiProviderError } from "@/lib/providers/openai.server";
import { getStateRepository } from "@/lib/server/repository";
import { runScan } from "@/lib/server/scan-workflow";

type RouteContext = { params: Promise<{ jobId: string }> | { jobId: string } };
type ExecuteBody = { workerId?: unknown };
type ExecutorSuccess = {
  ok: true;
  jobId: string;
  scanId: string;
  status: string;
  duplicate: boolean;
};
type ClaimedScanJob = { id: string };

const EXECUTOR_HEARTBEAT_MS = 15_000;

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

async function executeClaimedScan(
  job: ClaimedScanJob,
  scanId: string,
): Promise<ExecutorSuccess> {
  let completed;
  try {
    completed = await runScan(scanId);
  } catch (error) {
    if (error instanceof OpenAiProviderError && /structured (?:chat )?(?:JSON|output)/i.test(error.message)) {
      throw new ApiError(
        "The AI provider could not produce valid structured output after bounded recovery attempts.",
        502,
        "openai_structured_output_failed",
      );
    }
    throw error;
  }
  if (completed.status === "running") {
    throw new ApiError(
      "The scan is currently running in another request.",
      409,
      "scan_already_running",
    );
  }
  return {
    ok: true,
    jobId: job.id,
    scanId: completed.id,
    status: completed.status,
    duplicate: false,
  };
}

function streamScanExecution(job: ClaimedScanJob, scanId: string) {
  const encoder = new TextEncoder();
  let cancelled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send headers and one harmless JSON whitespace byte immediately. Further
      // whitespace heartbeats keep every HTTP hop active while the durable scan
      // advances in PostgreSQL. The worker parses the final object normally.
      controller.enqueue(encoder.encode("\n"));
      heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode("\n"));
      }, EXECUTOR_HEARTBEAT_MS);

      void executeClaimedScan(job, scanId)
        .then((payload) => {
          if (!cancelled) {
            controller.enqueue(encoder.encode(JSON.stringify(payload)));
            controller.close();
          }
        })
        .catch(async (error) => {
          const response = apiErrorResponse(error);
          const payload = await response.json().catch(() => ({
            error: { code: "internal_error", message: "The scan could not be completed." },
          }));
          if (!cancelled) {
            controller.enqueue(encoder.encode(JSON.stringify({
              ok: false,
              executorStatus: response.status,
              ...payload,
            })));
            controller.close();
          }
        })
        .finally(() => {
          if (heartbeat) clearInterval(heartbeat);
        });
    },
    cancel() {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      // The durable scan intentionally continues. A replacement worker can
      // observe its completed state without executing discovery a second time.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-accel-buffering": "no",
    },
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
      return Response.json({
        ok: true,
        jobId: job.id,
        scanId: scan.id,
        status: "complete",
        duplicate: true,
      });
    }
    return streamScanExecution(job, scan.id);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
