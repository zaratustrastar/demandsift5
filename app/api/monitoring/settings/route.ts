import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import {
  defaultWatchTerms,
  getRedditMonitorSettings,
  latestRedditMonitorRun,
  listRedditMonitorRuns,
  saveRedditMonitorSettings,
} from "@/lib/server/reddit-monitor-repository";
import type { RedditWatchTerm, ScanRecord } from "@/lib/server/contracts";

type UpdateBody = {
  enabled?: unknown;
  watchTerms?: unknown;
  scanId?: unknown;
};

function parseWatchTerms(value: unknown): RedditWatchTerm[] {
  if (!Array.isArray(value)) throw new ApiError("watchTerms must be an array.", 400, "invalid_watch_terms");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError("Each watch term must be an object.", 400, "invalid_watch_terms");
    }
    const object = item as Record<string, unknown>;
    if (typeof object.value !== "string") {
      throw new ApiError("Each watch term requires text.", 400, "invalid_watch_terms");
    }
    return {
      value: object.value,
      kind: object.kind === "brand" || object.kind === "competitor" ? object.kind : "keyword",
      active: object.active !== false,
    };
  });
}

/**
 * scanId identifies which business this request is for -- a workspace can
 * track several businesses (see migration 0013), so unlike before, this
 * can no longer default to "whichever one this workspace's latest scan
 * happens to be." Required, not optional: every caller (see the two
 * loadRedditMonitoring fetches in ThreadlineExperience.tsx) already has a
 * current scan in view by the time this route is ever called.
 */
function requireScanId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("scanId is required.", 400, "scan_id_required");
  }
  return value.trim();
}

async function currentSettings(workspaceId: string, seed: ScanRecord) {
  if (seed.status !== "complete" || !seed.discoveryProfile) {
    throw new ApiError("Complete a Market Scan before configuring monitoring.", 409, "scan_required");
  }
  let settings = await getRedditMonitorSettings(workspaceId, seed.id);
  if (!settings) {
    settings = await saveRedditMonitorSettings({
      workspaceId,
      seedScanId: seed.id,
      websiteUrl: seed.websiteUrl,
      enabled: false,
      watchTerms: defaultWatchTerms(seed),
    });
  }
  return settings;
}

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const scanId = requireScanId(new URL(request.url).searchParams.get("scanId"));
    const seed = await requireOwnedScan(actor.workspaceId, scanId);
    const [settings, latestRun, recentRuns] = await Promise.all([
      currentSettings(actor.workspaceId, seed),
      latestRedditMonitorRun(actor.workspaceId, seed.id),
      listRedditMonitorRuns(actor.workspaceId, seed.id, 10),
    ]);
    return Response.json({ monitoring: settings, latestRun, recentRuns }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertRateLimit(request, "reddit-monitor:settings", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = await readJson<UpdateBody>(request, 20_000);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError("enabled must be true or false.", 400, "invalid_monitoring_setting");
    }
    const scanId = requireScanId(body.scanId);
    const seed = await requireOwnedScan(actor.workspaceId, scanId);
    const existing = await currentSettings(actor.workspaceId, seed);
    const watchTerms = body.watchTerms === undefined
      ? existing.watchTerms
      : parseWatchTerms(body.watchTerms);
    const settings = await saveRedditMonitorSettings({
      workspaceId: actor.workspaceId,
      seedScanId: seed.id,
      websiteUrl: seed.websiteUrl,
      enabled: body.enabled,
      watchTerms,
    });
    return Response.json(
      {
        monitoring: settings,
        latestRun: await latestRedditMonitorRun(actor.workspaceId, seed.id),
        recentRuns: await listRedditMonitorRuns(actor.workspaceId, seed.id, 10),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
