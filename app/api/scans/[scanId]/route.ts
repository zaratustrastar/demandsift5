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
    return Response.json(await presentScan(scan), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
