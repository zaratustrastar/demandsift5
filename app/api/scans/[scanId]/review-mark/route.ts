import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

const ALLOWED_STATUSES = new Set(["reviewed", "declined", "replied"]);

/**
 * Lets the person mark what they've personally done with a result on the
 * Reddit opportunity carousel -- decline / mark as reviewed / mark as
 * replied -- and undo/change that mark freely. Stored on
 * ScanRecord.reviewMarks (see its doc comment in contracts.ts for why this
 * is a separate concept from the triage-prefixed AI-relevance fields
 * elsewhere): a personal workflow note, never a signal fed back into
 * ranking, matching, or reply generation.
 *
 * Only valid once the scan has a result -- the carousel this feeds
 * (OpportunityCarousel in ProductDashboard.tsx) is only ever shown on the
 * completed-scan report screen, never during a live-running scan.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:review-mark", { limit: 120, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    if (!scan.result) {
      throw new ApiError(
        "There is nothing to mark until this scan has a result.",
        409,
        "scan_not_complete",
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { itemId?: unknown; status?: unknown }
      | null;
    const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : "";
    if (!itemId) {
      throw new ApiError("Provide the id of the result to mark.", 400, "invalid_review_mark_item");
    }
    // null clears the mark (undo) -- everything else must be one of the
    // three real statuses; anything not recognized is rejected rather than
    // silently coerced.
    const rawStatus = body?.status;
    if (
      rawStatus !== null &&
      (typeof rawStatus !== "string" || !ALLOWED_STATUSES.has(rawStatus))
    ) {
      throw new ApiError(
        "status must be \"reviewed\", \"declined\", \"replied\", or null to clear it.",
        400,
        "invalid_review_mark_status",
      );
    }
    const status = rawStatus as "reviewed" | "declined" | "replied" | null;

    const reviewMarks = { ...(scan.reviewMarks ?? {}) };
    if (status === null) delete reviewMarks[itemId];
    else reviewMarks[itemId] = status;

    const updatedScan = { ...scan, reviewMarks, updatedAt: new Date().toISOString() };
    await getStateRepository().saveScan(updatedScan);

    return Response.json({ reviewMarks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
