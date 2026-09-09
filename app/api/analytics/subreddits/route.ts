import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getAiVisibilitySettings, listAiVisibilityScans } from "@/lib/server/ai-visibility-repository";
import { listRedditMonitorRuns } from "@/lib/server/reddit-monitor-repository";
import { getStateRepository } from "@/lib/server/repository";
import {
  aggregateSubredditActivityTimeline,
  aggregateSubredditPerformance,
  collectSubredditConversations,
  computeDemandMix,
  selectBestOpportunitySource,
  selectTopAiCitedCommunities,
  summarizeSubredditAnalytics,
  topSubredditsByConversations,
} from "@/lib/server/subreddit-analytics";
import type { AiVisibilityAnswer } from "@/lib/server/contracts";

/**
 * Same recent-run bound Prompt 9A's own recommendedSubreddits already
 * uses (reddit-monitor-repository.ts) -- reused here rather than
 * inventing a second arbitrary limit. This aggregation is a bounded
 * recent window, never full history.
 */
const RECENT_RUN_LIMIT = 10;

/** Series count for the activity chart -- "top 3 as separate series,
 * everything else grouped into Other", as specified. */
const ACTIVITY_TOP_SERIES = 3;

function requireScanId(value: string | null): string {
  if (!value || !value.trim()) {
    throw new ApiError("scanId is required.", 400, "scan_id_required");
  }
  return value.trim();
}

export async function GET(request: Request) {
  try {
    assertRateLimit(request, "analytics:subreddits", { limit: 30, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const scanId = requireScanId(new URL(request.url).searchParams.get("scanId"));
    const seedScan = await requireOwnedScan(actor.workspaceId, scanId);

    const repository = getStateRepository();
    const recentRuns = await listRedditMonitorRuns(actor.workspaceId, seedScan.id, RECENT_RUN_LIMIT);
    const recentRunScans = (
      await Promise.all(recentRuns.filter((run) => run.scanId).map((run) => repository.getScan(run.scanId as string)))
    ).filter((scan): scan is NonNullable<typeof scan> => Boolean(scan));

    // Latest succeeded AI Visibility check only -- the same "most recent
    // result" scope the AI Visibility screen itself already shows, not a
    // separate history mechanism.
    let aiVisibilityAnswers: AiVisibilityAnswer[] = [];
    const visibilitySettings = await getAiVisibilitySettings(actor.workspaceId, seedScan.id);
    if (visibilitySettings) {
      const visibilityScans = await listAiVisibilityScans(actor.workspaceId, seedScan.id, RECENT_RUN_LIMIT);
      const latestSucceeded = visibilityScans.find((scan) => scan.status === "succeeded");
      if (latestSucceeded) aiVisibilityAnswers = latestSucceeded.answers;
    }

    const rows = aggregateSubredditPerformance({
      seedScan,
      recentRunScans,
      aiVisibilityAnswers,
    });

    // Everything below is derived purely from `rows` (already computed
    // above) or from the same underlying conversation collection --
    // no additional data fetching, no new scraping, no new AI calls.
    const summary = summarizeSubredditAnalytics(rows);
    const demandMix = computeDemandMix(rows);
    const bestOpportunitySource = selectBestOpportunitySource(rows);
    const aiCitedCommunities = selectTopAiCitedCommunities(rows);
    const topActivitySubreddits = topSubredditsByConversations(rows, ACTIVITY_TOP_SERIES);
    const bySubreddit = collectSubredditConversations(seedScan, recentRunScans);
    const activityTimeline = aggregateSubredditActivityTimeline(bySubreddit, topActivitySubreddits);

    return Response.json(
      {
        rows,
        summary,
        demandMix,
        bestOpportunitySource,
        aiCitedCommunities,
        activityTimeline: { series: topActivitySubreddits, points: activityTimeline },
        window: {
          recentRunCount: recentRunScans.length,
          hasAiVisibilityData: aiVisibilityAnswers.length > 0,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
