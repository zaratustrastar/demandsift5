import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { presentScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

export async function GET(request: Request) {
  try {
    assertRateLimit(request, "scan:latest", { limit: 60, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const scan = await getStateRepository().getLatestScan(actor.workspaceId);
    if (!scan) throw new ApiError("No completed Market Scan is available yet.", 404, "scan_not_found");
    return Response.json(await presentScan(scan), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
