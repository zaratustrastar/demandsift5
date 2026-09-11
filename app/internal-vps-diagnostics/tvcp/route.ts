import { desc, ilike } from "drizzle-orm";

import { getDb } from "@/db";
import { runtimeScans } from "@/db/postgres/schema";

const TEMP_DIAGNOSTIC_KEY = "tvcp-20260816-6e6ad7887f1d4ba7a7f5d84b7c1dd95e";

function isAuthorizedDiagnosticRequest(request: Request): boolean {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const loopback = forwardedFor === "127.0.0.1" || forwardedFor === "::1" || forwardedFor === "::ffff:127.0.0.1";
  const temporaryKey = request.headers.get("x-vps-diagnostic-key") === TEMP_DIAGNOSTIC_KEY;
  return loopback || temporaryKey;
}

function boundedText(value: unknown, limit = 500): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

export async function GET(request: Request) {
  if (!isAuthorizedDiagnosticRequest(request)) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
  }

  const rows = await getDb()
    .select({
      id: runtimeScans.id,
      status: runtimeScans.status,
      websiteUrl: runtimeScans.websiteUrl,
      record: runtimeScans.record,
      createdAt: runtimeScans.createdAt,
      updatedAt: runtimeScans.updatedAt,
    })
    .from(runtimeScans)
    .where(ilike(runtimeScans.websiteUrl, "%tvcp.app%"))
    .orderBy(desc(runtimeScans.createdAt))
    .limit(8);

  const scans = rows.map((row) => {
    const scan = row.record;
    const result = scan.result;
    return {
      id: row.id,
      status: row.status,
      websiteUrl: row.websiteUrl,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      error: boundedText(scan.error),
      progress: scan.progress.map((stage) => ({ id: stage.id, status: stage.status })),
      profile: result
        ? {
            name: result.profile.name,
            productCategory: result.profile.productCategory ?? null,
            summary: boundedText(result.profile.summary, 600),
            targetAudience: result.profile.targetAudience.slice(0, 12),
            problemsSolved: result.profile.problemsSolved.slice(0, 12),
            jobsToBeDone: result.profile.jobsToBeDone?.slice(0, 12) ?? [],
            customerProblemLanguage: result.profile.customerProblemLanguage?.slice(0, 16) ?? [],
            features: result.profile.features.slice(0, 16),
            competitors: result.profile.competitors.slice(0, 12),
            irrelevantTopics: result.profile.irrelevantTopics.slice(0, 12),
            ambiguityRisks: result.profile.ambiguityRisks?.slice(0, 12) ?? [],
          }
        : null,
      searchPlan: result?.retrievalDiagnostics?.searchPlan ?? [],
      queryCountsByLane: result?.retrievalDiagnostics?.queryCountsByLane ?? {},
      matchedCandidatesByLane: result?.retrievalDiagnostics?.matchedCandidatesByLane ?? {},
      worthEnrichingByLane: result?.retrievalDiagnostics?.worthEnrichingByLane ?? {},
      matchedCandidatesByQuery: result?.retrievalDiagnostics?.matchedCandidatesByQuery ?? {},
      worthEnrichingByQuery: result?.retrievalDiagnostics?.worthEnrichingByQuery ?? {},
      candidates: result?.processedRedditState.map((candidate) => ({
        externalId: candidate.externalId,
        title: boundedText(candidate.title, 240),
        excerpt: boundedText(candidate.excerpt, 420),
        subreddit: candidate.subreddit,
        canonicalPermalink: candidate.canonicalPermalink,
        sourceCreatedAt: candidate.sourceCreatedAt,
        matchedQueries: candidate.matchedQueries,
        discoveryLanes: candidate.discoveryLanes,
        triage: {
          relevant: candidate.triage.relevant,
          intent: candidate.triage.intent,
          demandSignal: candidate.triage.demandSignal,
          problem: boundedText(candidate.triage.problem, 240),
          productFit: candidate.triage.productFit,
          timing: candidate.triage.timing,
          replyability: candidate.triage.replyability,
          worthEnriching: candidate.triage.worthEnriching,
          reason: boundedText(candidate.triage.reason, 420),
        },
      })) ?? [],
      dataMode: result?.dataMode ?? null,
      diagnostics: result?.diagnostics ?? null,
      output: result
        ? {
            opportunities: result.opportunities.length,
            potentialCustomers: result.potentialCustomers?.total ?? result.opportunities.length,
            insights: result.insights.length,
            competitorSignals: result.competitorWeakness?.verified ? 1 : 0,
            replies: result.replies.filter((reply) => reply.content.trim().length > 0).length,
          }
        : null,
    };
  });

  return Response.json(
    { scans },
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } },
  );
}
