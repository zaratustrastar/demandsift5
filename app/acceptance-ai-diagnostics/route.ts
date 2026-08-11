import type { BusinessUnderstanding, RedditDiscoveryCandidate } from "@/lib/domain/types";
import {
  createOpenAiProviderFromEnv,
  openAiModelsFromEnv,
  OpenAiProviderError,
  type OpenAiProviderDiagnosticEvent,
} from "@/lib/providers/openai.server";
import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { getStateRepository } from "@/lib/server/repository";

/**
 * Temporary, workspace-protected acceptance probe. It replays only the AI
 * triage boundary from already stored scan records and never starts Reddit
 * discovery, returns conversation text, or exposes provider credentials.
 */
export async function POST(request: Request) {
  const diagnosticEvents: OpenAiProviderDiagnosticEvent[] = [];

  try {
    const actor = await requireWorkspace(request);
    const scan = await getStateRepository().getLatestScan(actor.workspaceId);
    if (!scan?.result || scan.result.dataMode !== "apify-test") {
      throw new ApiError("No completed Apify acceptance scan is available.", 404, "scan_not_found");
    }

    const profile = scan.result.profile;
    const states = scan.result.processedRedditState.slice(0, 10);
    if (states.length === 0) {
      throw new ApiError("The completed scan has no stored candidates to replay.", 409, "probe_unavailable");
    }

    const cited = <T,>(value: T) => ({ value, confidence: 0.8, provenanceIds: profile.sourceIds });
    const business: BusinessUnderstanding = {
      businessId: "acceptance-ai-probe",
      workspaceId: actor.workspaceId,
      websiteUrl: profile.websiteUrl,
      canonicalDomain: new URL(profile.websiteUrl).hostname,
      name: cited(profile.name),
      summary: cited(profile.summary),
      productCategory: cited(profile.productCategory ?? profile.features[0] ?? profile.name),
      targetAudiences: cited(profile.targetAudience.map((name) => ({ name, description: name, pains: [] }))),
      problemsSolved: cited(profile.problemsSolved),
      jobsToBeDone: cited(profile.jobsToBeDone ?? []),
      likelyWorkarounds: cited(profile.likelyWorkarounds ?? []),
      triggerEvents: cited(profile.triggerEvents ?? []),
      features: cited(profile.features.map((name) => ({ name, description: name, verified: true }))),
      competitors: cited(profile.competitors.map((name) => ({
        name,
        relationship: "unknown" as const,
        verification: "website_claim" as const,
      }))),
      irrelevantTopics: cited(profile.irrelevantTopics),
      productTerms: cited([profile.name, profile.productCategory ?? "", ...profile.features.slice(0, 3)].filter(Boolean)),
      brandTerms: cited(profile.brandTerms?.length ? profile.brandTerms : [profile.name]),
      customerProblemLanguage: cited(profile.customerProblemLanguage?.length
        ? profile.customerProblemLanguage
        : profile.problemsSolved),
      ambiguityRisks: cited(profile.ambiguityRisks ?? []),
      version: 3,
      generatedAt: new Date().toISOString(),
    };
    const candidates: RedditDiscoveryCandidate[] = states.map((state) => ({
      provider: state.provider,
      sourceMode: "apify-test",
      externalId: state.externalId,
      kind: state.externalId.startsWith("t1_") ? "comment" : "post",
      subreddit: state.subreddit,
      title: state.title ?? undefined,
      body: state.excerpt,
      author: state.author ?? undefined,
      permalink: state.canonicalPermalink ?? undefined,
      createdAt: state.sourceCreatedAt,
      metrics: { score: 0, comments: state.commentCount },
      matchedQuery: state.matchedQueries[0],
      matchedQueries: state.matchedQueries,
      discoveryLanes: state.discoveryLanes,
      provenance: {
        id: `acceptance:${state.contentHash}`,
        kind: "reddit",
        provider: state.provider,
        providerExternalId: state.externalId,
        url: state.canonicalPermalink ?? undefined,
        title: state.title ?? undefined,
        excerpt: state.excerpt,
        contentHash: state.contentHash,
        observedAt: state.lastSeenAt,
        isMock: false,
      },
    }));

    const provider = createOpenAiProviderFromEnv(process.env, {
      onDiagnostic: (event) => diagnosticEvents.push(event),
    });
    const models = openAiModelsFromEnv();
    const result = await provider.triageConversations({
      business,
      candidates,
      models,
      coverageRetries: 0,
    });

    return Response.json({
      ok: true,
      model: result.model,
      candidateCount: candidates.length,
      resultCount: result.value.length,
      relevantCount: result.value.filter((item) => item.triage.relevant).length,
      worthEnrichingCount: result.value.filter((item) => item.triage.worthEnriching).length,
      usage: result.usage,
      diagnosticEvents,
    }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
  } catch (error) {
    if (error instanceof Error) {
      const providerError = error as OpenAiProviderError;
      return Response.json({
        ok: false,
        errorType: error.name || "Error",
        error: error.message.slice(0, 500),
        requestId: typeof providerError.requestId === "string" ? providerError.requestId : null,
        diagnosticEvents,
      }, { status: 502, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
    }
    return apiErrorResponse(error);
  }
}

// Browser-controlled acceptance cannot issue arbitrary in-page network calls.
// Keep the temporary replay accessible through an authenticated navigation too.
export const GET = POST;
