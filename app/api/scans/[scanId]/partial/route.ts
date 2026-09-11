import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentAccess, presentPartialResults } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:read", { limit: 120, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const rawAfter = new URL(request.url).searchParams.get("afterVersion") ?? "0";
    const afterVersion = Number(rawAfter);
    if (!Number.isInteger(afterVersion) || afterVersion < 0) {
      throw new ApiError("afterVersion must be a non-negative integer.", 400, "invalid_partial_version");
    }
    const source = await getStateRepository().getScanPartialResults(scanId, actor.workspaceId);
    if (!source) throw new ApiError("Scan was not found.", 404, "scan_not_found");
    const access = await presentAccess(source.workspaceId, source.websiteUrl);
    const version = source.partialResults?.version ?? 0;
    return Response.json(version <= afterVersion
      ? { changed: false, version, access }
      : { changed: true, version, access, partial: presentPartialResults(source.partialResults, access, afterVersion) },
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
