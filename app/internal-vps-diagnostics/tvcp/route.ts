import { desc, ilike } from "drizzle-orm";

import { getDb } from "@/db";
import { runtimeScans } from "@/db/postgres/schema";

function isLoopbackRequest(request: Request): boolean {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return forwardedFor === "127.0.0.1" || forwardedFor === "::1" || forwardedFor === "::ffff:127.0.0.1";
}

function boundedText(value: unknown, limit = 500): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

export async function GET(request: Request) {
  if (!isLoopbackRequest(request)) {
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
    .limit(12);

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
      dataMode: result?.dataMode ?? null,
      diagnostics: result
        ? {
            retrieved: result.diagnostics.retrieved,
            normalized: result.diagnostics.normalized,
            deterministicSurvivors: result.diagnostics.deterministicSurvivors,
            submittedForTriage: result.diagnostics.submittedForTriage,
            triageReturned: result.diagnostics.triageReturned,
            worthEnriching: result.diagnostics.worthEnriching,
            requestedForEnrichment: result.diagnostics.requestedForEnrichment,
            enrichedSuccessfully: result.diagnostics.enrichedSuccessfully,
            enrichmentFailures: result.diagnostics.enrichmentFailures,
            submittedForDeepQualification: result.diagnostics.submittedForDeepQualification,
            deepQualificationsReturned: result.diagnostics.deepQualificationsReturned,
            potentialCustomerConversations: result.diagnostics.potentialCustomerConversations,
            uniquePotentialCustomers: result.diagnostics.uniquePotentialCustomers,
            repliesGenerated: result.diagnostics.repliesGenerated,
          }
        : null,
      retrieval: result?.retrievalDiagnostics
        ? {
            provider: result.retrievalDiagnostics.provider,
            queryCount: result.retrievalDiagnostics.queryCount,
            fetchedCandidates: result.retrievalDiagnostics.fetchedCandidates,
            normalizedCandidates: result.retrievalDiagnostics.normalizedCandidates,
            locallyMatchedCandidates: result.retrievalDiagnostics.locallyMatchedCandidates,
            enrichmentAttempts: result.retrievalDiagnostics.enrichmentAttempts,
            enrichedConversations: result.retrievalDiagnostics.enrichedConversations,
            qualifiedOpportunities: result.retrievalDiagnostics.qualifiedOpportunities,
          }
        : null,
      output: result
        ? {
            opportunities: result.opportunities.length,
            potentialCustomers: result.potentialCustomers?.total ?? result.opportunities.length,
            insights: result.insights.length,
            competitorSignals: result.competitorWeakness?.verified ? 1 : 0,
            replies: result.replies.filter(
              (reply) => typeof reply.content === "string" && reply.content.trim().length > 0,
            ).length,
          }
        : null,
    };
  });

  return Response.json(
    { scans },
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } },
  );
}
