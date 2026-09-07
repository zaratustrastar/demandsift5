import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { resumeScanWithManualContext } from "@/lib/server/scan-workflow";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

// Mirrors POST /api/scans's own contextText bounds exactly, so a manual
// description entered here is held to the same standard as one entered
// at initial submission through the "Describe your market / idea" tab.
const MIN_CONTEXT_TEXT_LENGTH = 20;
const MAX_CONTEXT_TEXT_LENGTH = 4_000;

/**
 * Recovery path for a scan whose website could not be read at all --
 * see resumeScanWithManualContext's doc comment in scan-workflow.ts.
 * Only valid for a scan that failed before ever producing a
 * discoveryProfile; a scan that already has one (even a since-failed
 * later stage, e.g. Reddit enrichment) has nothing website-related left
 * to recover from a manual description, and re-running understanding
 * would just discard real, already-reviewed work.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:describe", { limit: 10, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    if (scan.inputMode === "context") {
      throw new ApiError("This scan is already using a manual description.", 409, "scan_already_context_mode");
    }
    if (scan.discoveryProfile) {
      throw new ApiError("This scan already has an analyzed profile; a manual description would discard it.", 409, "scan_already_analyzed");
    }
    if (scan.status !== "failed") {
      throw new ApiError("This scan isn't in a state that can switch to a manual description.", 409, "scan_not_failed");
    }

    const body = (await request.json().catch(() => null)) as { contextText?: unknown } | null;
    const contextText = typeof body?.contextText === "string" ? body.contextText.trim() : "";
    if (contextText.length < MIN_CONTEXT_TEXT_LENGTH) {
      throw new ApiError(
        "Tell us a bit more -- a sentence or two about your business, market or idea.",
        400,
        "context_text_too_short",
      );
    }
    if (contextText.length > MAX_CONTEXT_TEXT_LENGTH) {
      throw new ApiError("That description is too long.", 400, "context_text_too_long");
    }

    const resumed = await resumeScanWithManualContext(scan, contextText);
    return Response.json(await presentScan(resumed), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
