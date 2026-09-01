import { ApiError, apiErrorResponse, readJson, requireWorkspace } from "@/lib/server/http";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:completion-notice", { limit: 30, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const body = await readJson<{ version?: unknown }>(request, 1_000);
    if (body.version !== "scan-complete-v1") {
      throw new ApiError("Completion notice version is invalid.", 400, "invalid_notice_version");
    }
    const notice = await getStateRepository().acknowledgeScanCompletion(scanId, actor.workspaceId, body.version);
    if (!notice) throw new ApiError("Completion notice was not found.", 404, "completion_notice_not_found");
    return Response.json({ notice }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
