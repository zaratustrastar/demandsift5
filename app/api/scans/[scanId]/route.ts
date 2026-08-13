import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:read", { limit: 120, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const statusOnly = new URL(request.url).searchParams.get("statusOnly") === "1";
    if (statusOnly || !scan.result) {
      return Response.json(
        {
          scan: {
            id: scan.id,
            status: scan.status,
            websiteUrl: scan.websiteUrl,
            progress: scan.progress,
            createdAt: scan.createdAt,
            updatedAt: scan.updatedAt,
            error: scan.error,
          },
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
