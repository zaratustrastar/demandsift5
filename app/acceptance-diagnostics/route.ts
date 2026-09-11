import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { presentScan } from "@/lib/server/presenter";
import { getStateRepository } from "@/lib/server/repository";

function sanitizedPresentationError(error: unknown): { errorType: string; error: string } {
  const errorType = error instanceof Error ? error.name || "Error" : "Error";
  const raw = error instanceof Error ? error.message : "Unknown presentation failure.";
  return {
    errorType,
    error: raw
      .replace(/https?:\/\/\S+/giu, "[url]")
      .replace(/\b(?:scan|ws|reply|opp)_[a-z\d_-]+\b/giu, "[id]")
      .replace(/\b[A-Za-z\d_-]{32,}\b/gu, "[redacted]")
      .slice(0, 300),
  };
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

    let presentation:
      | { ok: true; hasReport: boolean; visibleOpportunities: number; visibleReplies: number }
      | ({ ok: false } & ReturnType<typeof sanitizedPresentationError>);
    try {
      const presented = await presentScan(scan);
      presentation = {
        ok: true,
        hasReport: Boolean(presented.report),
        visibleOpportunities: presented.report?.opportunities.length ?? 0,
        visibleReplies: presented.report?.replies.length ?? 0,
      };
    } catch (error) {
      presentation = { ok: false, ...sanitizedPresentationError(error) };
    }

    const payload = {
      scan: {
        id: scan.id,
        status: scan.status,
        websiteUrl: scan.websiteUrl,
        createdAt: scan.createdAt,
        updatedAt: scan.updatedAt,
        progress: scan.progress.map((stage) => ({ id: stage.id, status: stage.status })),
      },
      diagnostics: scan.result.diagnostics,
      presentation,
      decisionBreakdown: {
        triage: scan.result.processedRedditState.reduce<Record<string, number>>((counts, state) => {
          const key = [
            state.triage.worthEnriching ? "selected" : "not_selected",
            state.triage.intent,
            state.triage.demandSignal,
            state.triage.productFit,
            state.triage.timing,
          ].join("|");
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
        deepQualification: scan.result.processedRedditState.reduce<Record<string, number>>((counts, state) => {
          const deep = state.deepQualification;
          if (!deep) return counts;
          const key = [
            deep.leadStatus,
            deep.intent,
            deep.productFit,
            deep.timing,
            deep.evidenceQuality,
            deep.replyability,
          ].join("|");
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
      },
      retrieval: scan.result.retrievalDiagnostics
        ? {
            provider: scan.result.retrievalDiagnostics.provider,
            queryCount: scan.result.retrievalDiagnostics.queryCount,
            queryCountsByLane: scan.result.retrievalDiagnostics.queryCountsByLane,
            matchedCandidatesByLane: scan.result.retrievalDiagnostics.matchedCandidatesByLane,
            worthEnrichingByLane: scan.result.retrievalDiagnostics.worthEnrichingByLane,
            fetchedCandidates: scan.result.retrievalDiagnostics.fetchedCandidates,
            normalizedCandidates: scan.result.retrievalDiagnostics.normalizedCandidates,
            locallyMatchedCandidates: scan.result.retrievalDiagnostics.locallyMatchedCandidates,
            enrichmentAttempts: scan.result.retrievalDiagnostics.enrichmentAttempts,
            intelligenceCoverageReviews: scan.result.retrievalDiagnostics.intelligenceCoverageReviews,
            enrichedConversations: scan.result.retrievalDiagnostics.enrichedConversations,
            enrichmentFallbacks: scan.result.retrievalDiagnostics.enrichmentFallbacks,
            qualifiedOpportunities: scan.result.retrievalDiagnostics.qualifiedOpportunities,
          }
        : null,
      output: {
        opportunities: scan.result.opportunities.length,
        potentialCustomers: scan.result.potentialCustomers?.total ?? scan.result.opportunities.length,
        insights: scan.result.insights.length,
        competitorSignals: scan.result.competitorWeakness?.verified ? 1 : 0,
        marketIntelligence: scan.result.marketIntelligence.length,
        replies: scan.result.replies.filter(
          (reply) => typeof reply.content === "string" && reply.content.trim().length > 0,
        ).length,
      },
    };

    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
