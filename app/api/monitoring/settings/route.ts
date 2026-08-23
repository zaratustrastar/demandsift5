import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { assertRateLimit } from "@/lib/server/rate-limit";
import {
  defaultWatchTerms,
  getRedditMonitorSettings,
  latestRedditMonitorRun,
  listRedditMonitorRuns,
  saveRedditMonitorSettings,
} from "@/lib/server/reddit-monitor-repository";
import { getStateRepository } from "@/lib/server/repository";
import type { RedditWatchTerm } from "@/lib/server/contracts";

type UpdateBody = {
  enabled?: unknown;
  watchTerms?: unknown;
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

async function currentSettings(workspaceId: string) {
  const repository = getStateRepository();
  const seed = await repository.getLatestScan(workspaceId);
  if (!seed || seed.status !== "complete" || !seed.discoveryProfile) {
    throw new ApiError("Complete a Market Scan before configuring monitoring.", 409, "scan_required");
  }
  let settings = await getRedditMonitorSettings(workspaceId);
  // A workspace represents one monitored business. If the user replaces that
  // business with a new website scan, never carry the old brand/competitor
  // watches across silently.
  if (!settings || settings.websiteUrl !== seed.websiteUrl) {
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
    const [settings, latestRun, recentRuns] = await Promise.all([
      currentSettings(actor.workspaceId),
      latestRedditMonitorRun(actor.workspaceId),
      listRedditMonitorRuns(actor.workspaceId, 10),
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
    const existing = await currentSettings(actor.workspaceId);
    const repository = getStateRepository();
    const latest = await repository.getLatestScan(actor.workspaceId);
    const seed = latest?.status === "complete" && latest.discoveryProfile ? latest : await repository.getScan(existing.seedScanId);
    if (!seed || seed.workspaceId !== actor.workspaceId || seed.status !== "complete" || !seed.discoveryProfile) {
      throw new ApiError("The monitoring seed scan is unavailable.", 409, "scan_required");
    }
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
        latestRun: await latestRedditMonitorRun(actor.workspaceId),
        recentRuns: await listRedditMonitorRuns(actor.workspaceId, 10),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
