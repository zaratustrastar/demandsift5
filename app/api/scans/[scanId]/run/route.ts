import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { enqueueScanRun, runScan } from "@/lib/server/scan-workflow";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Keeps the analysis request open while the browser polls the owned scan.
 * This exposes genuine backend stage transitions without granting access or
 * trusting client-side progress state.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:run", { limit: 6, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    if (scan.status === "complete") return Response.json(await presentScan(scan));
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
      const job = await enqueueScanRun(scan);
      return Response.json(
        { ...(await presentScan(scan)), job: { id: job.id, status: job.status } },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }
    const completed = await runScan(scan.id);
    return Response.json(await presentScan(completed), {
      status: completed.status === "running" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
