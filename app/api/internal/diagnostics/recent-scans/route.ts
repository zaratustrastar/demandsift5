import { desc, ilike } from "drizzle-orm";

import { getDb } from "@/db";
import { runtimeScans } from "@/db/postgres/schema";
import { apiErrorResponse, ApiError } from "@/lib/server/http";

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireWorker(request: Request) {
  const secret = process.env.BACKGROUND_WORKER_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError("Background worker authentication is not configured.", 503, "worker_unavailable");
  }
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(secret, supplied)) throw new ApiError("Worker authentication failed.", 401, "unauthorized");
}

function triageBreakdown(record: (typeof runtimeScans.$inferSelect)["record"]) {
  const states = record.result?.processedRedditState ?? [];
  return states.reduce<Record<string, number>>((counts, state) => {
    const key = [
      state.triage.worthEnriching ? "selected" : "not_selected",
      state.triage.intent,
      state.triage.demandSignal,
      state.triage.productFit,
      state.triage.timing,
    ].join("|");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function deepBreakdown(record: (typeof runtimeScans.$inferSelect)["record"]) {
  const states = record.result?.processedRedditState ?? [];
  return states.reduce<Record<string, number>>((counts, state) => {
    const deep = state.deepQualification;
    if (!deep) return counts;
    const key = [deep.leadStatus, deep.intent, deep.productFit, deep.timing, deep.evidenceQuality].join("|");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export async function GET(request: Request) {
  try {
    requireWorker(request);
    const url = new URL(request.url);
    const domain = url.searchParams.get("domain")?.trim().toLowerCase() ?? "";
    const inspect = url.searchParams.get("inspect") === "1";
    const scanId = url.searchParams.get("scanId")?.trim() ?? "";
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw new ApiError("domain is invalid.", 400, "invalid_domain");
    }

    const rows = await getDb()
      .select({
        id: runtimeScans.id,
        status: runtimeScans.status,
        record: runtimeScans.record,
        createdAt: runtimeScans.createdAt,
        updatedAt: runtimeScans.updatedAt,
      })
      .from(runtimeScans)
      .where(ilike(runtimeScans.websiteUrl, `%${domain}%`))
      .orderBy(desc(runtimeScans.createdAt))
      .limit(8);

    return Response.json({
      scans: rows.map((row) => {
        const result = row.record.result;
        const includeInspection = Boolean(inspect && result && (!scanId || row.id === scanId));
        return {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          progress: row.record.progress.map((stage) => ({ id: stage.id, status: stage.status, detail: stage.detail })),
          windowDays: result?.potentialCustomers.windowDays ?? null,
          diagnostics: result?.diagnostics ?? null,
          retrieval: result?.retrievalDiagnostics
            ? {
                queryCount: result.retrievalDiagnostics.queryCount,
                matchedCandidatesByLane: result.retrievalDiagnostics.matchedCandidatesByLane,
                worthEnrichingByLane: result.retrievalDiagnostics.worthEnrichingByLane,
                fetchedCandidates: result.retrievalDiagnostics.fetchedCandidates,
                normalizedCandidates: result.retrievalDiagnostics.normalizedCandidates,
                locallyMatchedCandidates: result.retrievalDiagnostics.locallyMatchedCandidates,
                enrichmentAttempts: result.retrievalDiagnostics.enrichmentAttempts,
                enrichedConversations: result.retrievalDiagnostics.enrichedConversations,
              }
            : null,
          triageBreakdown: triageBreakdown(row.record),
          deepBreakdown: deepBreakdown(row.record),
          inspection: includeInspection && result
            ? {
                profile: {
                  name: result.profile.name,
                  summary: result.profile.summary,
                  productCategory: result.profile.productCategory,
                  targetAudience: result.profile.targetAudience,
                  problemsSolved: result.profile.problemsSolved,
                  jobsToBeDone: result.profile.jobsToBeDone ?? [],
                  likelyWorkarounds: result.profile.likelyWorkarounds ?? [],
                  triggerEvents: result.profile.triggerEvents ?? [],
                  customerProblemLanguage: result.profile.customerProblemLanguage ?? [],
                  features: result.profile.features,
                  competitors: result.profile.competitors,
                  irrelevantTopics: result.profile.irrelevantTopics,
                  ambiguityRisks: result.profile.ambiguityRisks ?? [],
                },
                searchPlan: result.retrievalDiagnostics?.searchPlan ?? [],
                candidates: result.processedRedditState.slice(0, 40).map((state) => ({
                  externalId: state.externalId,
                  subreddit: state.subreddit,
                  title: (state.title ?? "").slice(0, 180),
                  excerpt: state.excerpt.slice(0, 700),
                  matchedQueries: state.matchedQueries,
                  discoveryLanes: state.discoveryLanes,
                  sourceCreatedAt: state.sourceCreatedAt,
                  triage: state.triage,
                  deepQualification: state.deepQualification,
                })),
              }
            : null,
          output: result
            ? {
                opportunities: result.opportunities.length,
                insights: result.insights.length,
                marketIntelligence: result.marketIntelligence.length,
                competitorSignals: result.competitorWeakness.verified ? 1 : 0,
                replies: result.replies.filter((reply) => reply.content.trim()).length,
              }
            : null,
        };
      }),
    }, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
