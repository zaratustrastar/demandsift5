import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { runScan } from "@/lib/server/scan-workflow";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Phase one of a scan: crawl the site and build the discovery profile, then
 * stop.
 *
 * Splitting this from Reddit retrieval is what makes the review step possible.
 * The user pastes a website, sees what DemandSift understood and what it plans
 * to search for, optionally edits it, and only then starts the scan. The
 * analysis is persisted on the scan record, so continuing later reuses exactly
 * the terms that were reviewed rather than re-deriving them.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:analyze", { limit: 6, windowMs: 10 * 60_000 });
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
    if (scan.discoveryProfile) {
      // Already analyzed; re-running would discard the reviewed terms.
      return Response.json(await presentScan(scan), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const analyzed = await runScan(scan.id, { stopAfterUnderstanding: true });
    if (!analyzed.discoveryProfile && analyzed.status === "failed") {
      throw new ApiError(
        analyzed.error ?? "Website analysis failed.",
        502,
        "website_analysis_failed",
      );
    }
    return Response.json(await presentScan(analyzed), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
