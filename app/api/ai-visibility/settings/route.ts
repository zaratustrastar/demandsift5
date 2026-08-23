import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { assertRateLimit } from "@/lib/server/rate-limit";
import {
  getAiVisibilitySettings,
  listAiVisibilityScans,
  updateAiVisibilitySettings,
} from "@/lib/server/ai-visibility-repository";

type UpdateBody = {
  enabled?: unknown;
};

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const [settings, recentScans] = await Promise.all([
      getAiVisibilitySettings(actor.workspaceId),
      // 1 page's worth of scan history (weekly cadence -- 8 is ~2 months)
      // for the AI visibility results view, not just the latest run.
      listAiVisibilityScans(actor.workspaceId, 8),
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
    const existing = await getAiVisibilitySettings(actor.workspaceId);
    if (!existing) {
      throw new ApiError("Complete a Market Scan before configuring AI visibility tracking.", 409, "scan_required");
    }
    const settings = await updateAiVisibilitySettings({
      workspaceId: actor.workspaceId,
      enabled: body.enabled,
    });
    const recentScans = await listAiVisibilityScans(actor.workspaceId, 8);
    return Response.json(
      { visibility: settings, latestScan: recentScans[0] ?? null, recentScans },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
