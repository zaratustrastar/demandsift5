import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { getStateRepository } from "@/lib/server/repository";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const scan = await getStateRepository().getLatestScan(actor.workspaceId);
    if (!scan?.result) {
      throw new ApiError("No completed Market Scan is available yet.", 404, "scan_not_found");
    }
    if (scan.result.dataMode !== "apify-test") {
      throw new ApiError("Acceptance diagnostics are unavailable for this scan.", 404, "not_found");
    }

    const payload = {
      scan: {
        id: scan.id,
        status: scan.status,
        websiteUrl: scan.websiteUrl,
        createdAt: scan.createdAt,
        updatedAt: scan.updatedAt,
        progress: scan.progress,
      },
      diagnostics: scan.result.diagnostics,
      retrievalDiagnostics: scan.result.retrievalDiagnostics,
      processedRedditState: scan.result.processedRedditState.map((state) => ({
        externalId: state.externalId,
        author: state.author,
        title: state.title,
        excerpt: state.excerpt,
        subreddit: state.subreddit,
        sourceCreatedAt: state.sourceCreatedAt,
        canonicalPermalink: state.canonicalPermalink,
        matchedQueries: state.matchedQueries,
        discoveryLanes: state.discoveryLanes,
        triage: state.triage,
        deepQualification: state.deepQualification,
        replyStatus: state.replyStatus,
      })),
      output: {
        opportunities: scan.result.opportunities.length,
        marketIntelligence: scan.result.marketIntelligence.length,
        replies: scan.result.replies.length,
      },
    };

    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Acceptance diagnostics</title></head><body><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
