import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { analyzeCompetitorUrls, MAX_COMPETITOR_URLS } from "@/lib/server/competitor-analysis";

/**
 * Analyzes up to 3 competitor homepages and persists the results on the
 * scan, the same "fixed before Reddit retrieval starts" lifecycle as
 * discoveryProfile. Competitors are entirely optional -- a scan with none
 * analyzed behaves exactly as it did before this endpoint existed.
 *
 * Scoped by scanId in the request body rather than the URL: this sits
 * alongside the scan review step (not nested under /api/scans/[scanId]/...)
 * because it isn't part of that scan's website analysis, it's a sidecar the
 * review screen calls into.
 */
export async function POST(request: Request) {
  try {
    assertRateLimit(request, "competitors:analyze", { limit: 6, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = (await request.json().catch(() => null)) as
      | { scanId?: unknown; urls?: unknown }
      | null;

    const scanId = typeof body?.scanId === "string" ? body.scanId.trim() : "";
    if (!scanId) throw new ApiError("scanId is required.", 400, "scan_id_required");
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    if (scan.approval || scan.status === "running" || scan.status === "retrying" || scan.status === "complete") {
      throw new ApiError(
        "Competitors can only be analyzed before the Reddit scan starts.",
        409,
        "scan_already_started",
      );
    }

    const rawUrls = Array.isArray(body?.urls) ? body.urls : [];
    const urls = rawUrls
      .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
      .slice(0, MAX_COMPETITOR_URLS);
    if (urls.length === 0) {
      throw new ApiError(
        `Provide at least one competitor URL (up to ${MAX_COMPETITOR_URLS}).`,
        400,
        "no_competitor_urls",
      );
    }

    const competitorProfiles = await analyzeCompetitorUrls(actor.workspaceId, urls);
    await getStateRepository().saveScan({
      ...scan,
      competitorProfiles,
      updatedAt: new Date().toISOString(),
    });

    return Response.json({ competitorProfiles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
