import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentAccess, presentScan, presentScanLifecycle, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:read", { limit: 120, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const statusOnly = new URL(request.url).searchParams.get("statusOnly") === "1";
    if (statusOnly) {
      const repository = getStateRepository();
      const status = await repository.getScanStatus(scanId, actor.workspaceId);
      if (!status) throw new ApiError("Scan was not found.", 404, "scan_not_found");
      const { workspaceId, durableAccepted, ...scan } = status;
      return Response.json({ scan: { ...scan, durable: durableAccepted && repository.kind === "postgres" },
        access: await presentAccess(workspaceId, scan.websiteUrl), report: null,
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    if (!scan.result) {
      // Every other scan response shape (presentScan, including its own
      // no-result branch) includes "access" -- the client always reads it
      // unconditionally after a poll. Omitting it here previously produced a
      // response the frontend's ApiScanResponse type claimed could not
      // exist, crashing the page mid-scan.
      return Response.json(
        {
          scan: {
            ...presentScanLifecycle(scan),
            id: scan.id,
            status: scan.status,
            websiteUrl: scan.websiteUrl,
            inputMode: scan.inputMode ?? "website",
            contextText: scan.contextText ?? null,
            progress: scan.progress,
            createdAt: scan.createdAt,
            updatedAt: scan.updatedAt,
            error: scan.error,
            errorCode: scan.errorCode ?? null,
          },
          access: await presentAccess(scan.workspaceId, scan.websiteUrl),
          report: null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(await presentScan(scan), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
