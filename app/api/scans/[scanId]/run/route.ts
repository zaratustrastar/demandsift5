import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { enqueueScanRun, runScan } from "@/lib/server/scan-workflow";
import { approveScanRecord, assertReviewedVersion } from "@/lib/server/scan-lifecycle";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * The review click accepts exactly the profile version the user saw.
 * Production persists approval and the deduplicated job atomically.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:run", { limit: 6, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    if (scan.status === "complete") return Response.json(await presentScan(scan));
    const body = await readJson<{ reviewVersion?: string }>(request, 4_000);
    assertReviewedVersion(scan, body.reviewVersion);
    if (scan.status === "running") {
      return Response.json(await presentScan(scan), {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      });
    }
    // In queue mode the worker owns long-running execution; running inline
    // here would hold the HTTP request open for the whole Reddit scan.
    const workerMode = process.env.BACKGROUND_WORKER_MODE?.trim().toLowerCase();
    if (workerMode === "queue" && getStateRepository().kind === "postgres") {
      const accepted = await enqueueScanRun(scan, body.reviewVersion);
      return Response.json(
        { ...(await presentScan(accepted.scan)), job: { id: accepted.job.id, status: accepted.job.status } },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }
    const approved = approveScanRecord(scan, body.reviewVersion);
    if (approved !== scan) await getStateRepository().saveScan(approved);
    let completed;
    try {
      completed = await runScan(scan.id);
    } catch (runError) {
      // Preserve the specific reason runScan already wrote onto scan.error
      // (e.g. a Reddit discovery/enrichment or structured-AI failure)
      // instead of letting apiErrorResponse fall back to its generic
      // "Something went wrong" message for a plain, unbranded Error.
      if (runError instanceof ApiError) throw runError;
      const message = runError instanceof Error ? runError.message : "The scan could not be started.";
      throw new ApiError(message, 502, "scan_run_failed");
    }
    return Response.json(await presentScan(completed), {
      status: completed.status === "running" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
