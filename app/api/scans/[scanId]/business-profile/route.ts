import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { applyBusinessSummaryOverride, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

const MAX_SUMMARY_LENGTH = 600;

/**
 * Lets a user correct their own "what you sell" summary after a scan has
 * completed -- the one free-text sentence every qualification judgement and
 * reply draft is grounded in (see applyBusinessSummaryOverride's doc
 * comment). Distinct from PUT /api/scans/[scanId]/discovery-terms, which
 * edits *search terms* and only applies before a scan starts; this edits
 * the underlying self-description and only makes sense once there is a
 * result to correct.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:business-profile", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    if (!scan.result) {
      throw new ApiError(
        "There is nothing to correct until this scan has a result.",
        409,
        "scan_not_complete",
      );
    }

    const body = (await request.json().catch(() => null)) as { summary?: unknown } | null;
    const summary = typeof body?.summary === "string" ? body.summary.replace(/\s+/g, " ").trim() : "";
    if (!summary) {
      throw new ApiError("Provide a non-empty summary.", 400, "invalid_business_summary");
    }
    if (summary.length > MAX_SUMMARY_LENGTH) {
      throw new ApiError(
        `Keep it under ${MAX_SUMMARY_LENGTH} characters.`,
        400,
        "business_summary_too_long",
      );
    }

    const businessSummaryOverride = { summary, updatedAt: new Date().toISOString() };
    const updatedScan = {
      ...scan,
      businessSummaryOverride,
      updatedAt: new Date().toISOString(),
    };
    await getStateRepository().saveScan(updatedScan);

    return Response.json(
      { profile: applyBusinessSummaryOverride(updatedScan, scan.result.profile) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
