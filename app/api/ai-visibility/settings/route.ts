import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import {
  getAiVisibilitySettings,
  listAiVisibilityScans,
  updateAiVisibilitySettings,
} from "@/lib/server/ai-visibility-repository";

type UpdateBody = {
  enabled?: unknown;
  scanId?: unknown;
};

/**
 * scanId identifies which business's settings this request is for -- a
 * workspace can track several businesses (see migration 0013), so unlike
 * before, this can no longer default to "whichever one this workspace
 * tracks." Required, not optional: every caller (see the two loadAiVisibility
 * fetches in ThreadlineExperience.tsx) already has a current scan in view
 * by the time this route is ever called, so there is no legitimate request
 * for this data without one.
 */
function requireScanId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("scanId is required.", 400, "scan_id_required");
  }
  return value.trim();
}

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const scanId = requireScanId(new URL(request.url).searchParams.get("scanId"));
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const [settings, recentScans] = await Promise.all([
      getAiVisibilitySettings(actor.workspaceId, scan.id),
      // 1 page's worth of scan history (weekly cadence -- 8 is ~2 months)
      // for the AI visibility results view, not just the latest run.
      listAiVisibilityScans(actor.workspaceId, scan.id, 8),
    ]);
    if (!settings) {
      return Response.json({ visibility: null }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json(
      { visibility: settings, latestScan: recentScans[0] ?? null, recentScans },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertRateLimit(request, "ai-visibility:settings", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = await readJson<UpdateBody>(request, 2_000);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError("enabled must be true or false.", 400, "invalid_visibility_setting");
    }
    const scanId = requireScanId(body.scanId);
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const existing = await getAiVisibilitySettings(actor.workspaceId, scan.id);
    if (!existing) {
      throw new ApiError("Complete a Market Scan before configuring AI visibility tracking.", 409, "scan_required");
    }
    const settings = await updateAiVisibilitySettings({
      workspaceId: actor.workspaceId,
      seedScanId: scan.id,
      enabled: body.enabled,
    });
    const recentScans = await listAiVisibilityScans(actor.workspaceId, scan.id, 8);
    return Response.json(
      { visibility: settings, latestScan: recentScans[0] ?? null, recentScans },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
