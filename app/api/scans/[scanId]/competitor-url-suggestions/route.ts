import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { normalizedBusinessHostname } from "@/lib/server/business-access";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { resolveCompetitorUrlsFromCrawl, buildCompactCompetitorEvidence } from "@/lib/server/competitor-url-resolution";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Suggested official homepage URLs for up to 3 likely direct competitors,
 * shown on CompetitorsSetup.tsx as editable, removable, replaceable
 * pre-fills, never as locked values. See
 * lib/server/competitor-url-resolution.ts for the actual suggestion +
 * verification pipeline; this route is only the cache-or-compute wrapper
 * around it.
 *
 * Deliberately its own endpoint rather than a field added to the existing
 * GET /api/scans/[scanId]/discovery-terms, which DiscoveryProfile.tsx also
 * calls for unrelated data (product terms, personas, etc.) -- adding this
 * work there would slow that screen down every time, for a result it
 * never uses.
 *
 * Suggestions are generated from compact crawl evidence (see
 * buildCompactCompetitorEvidence and resolveCompetitorUrlsFromCrawl), with
 * no dependency on BusinessUnderstanding.competitors, a completed business
 * profile, or analyzeBusiness finishing at all. This route only requires
 * the crawl -- not scan.discoveryProfile.business -- specifically so the
 * Competitors screen can appear (see the UX-level parallelization in
 * scan-workflow.ts's runFullWebsiteUnderstanding, which persists
 * scan.competitorSuggestions the moment that branch settles, well before
 * analyzeBusiness typically finishes) without waiting on analysis.
 *
 * scan.competitorSuggestions (a top-level field, never discoveryProfile --
 * see its doc comment in contracts.ts for why analysisReady's meaning must
 * never be put at risk here) is the primary read path; this route's own
 * on-demand computation is now mainly a fallback (an older scan from
 * before this existed, or a background pass that hit an unexpected error
 * and never got to mark itself ready).
 *
 * Only successfully verified suggestions are ever cached (see the save
 * below) -- a scan whose fallback computation here found zero verified
 * suggestions is retried on the next request rather than being
 * permanently remembered as "nothing here."
 *
 * ?debug=1 returns the full per-candidate diagnostic trail from
 * resolveCompetitorUrlsFromCrawl (proposed name/URL, validation outcome,
 * homepage identity signals, which one matched) instead of running
 * silently -- for diagnosing why a candidate didn't verify, not used by
 * CompetitorsSetup.tsx.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:competitor-url-suggestions", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const debug = new URL(request.url).searchParams.get("debug") === "1";

    const crawl = scan.websiteSnapshot?.crawl;
    if (!crawl) {
      throw new ApiError(
        "Crawl the website before suggesting competitor websites.",
        409,
        "website_not_analyzed",
      );
    }

    // Cached suggestions are keyed by whatever names the model proposed;
    // there's no fixed expected-name list to check against here (the
    // model decides the names), so "already marked ready" is the
    // fast-path condition instead of "every expected name is present."
    // Normally already populated by runFullWebsiteUnderstanding well
    // before this is ever called -- see the class doc comment above.
    const cached = scan.competitorSuggestions;
    if (!debug && cached?.status === "ready") {
      return Response.json(
        { suggestions: Object.entries(cached.suggestions).map(([name, url]) => ({ name, url })) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const capacity = aiCapacityFromEnv();
    const aiProvider = process.env.OPENAI_API_KEY?.trim()
      ? createOpenAiProviderFromEnv(process.env, {
          requestGate: globallyBoundedAiRequestGate({
            workspaceId: actor.workspaceId,
            localLimit: capacity.requestConcurrency,
            holderPrefix: `competitor-url:${actor.workspaceId}:${scanId}`,
          }),
        })
      : null;

    // No AI configured is the same conservative-fallback policy used
    // everywhere else in this funnel: every field stays empty and
    // editable, not an error.
    const resolution = aiProvider
      ? await resolveCompetitorUrlsFromCrawl({
          websiteUrl: scan.websiteUrl,
          canonicalDomain: crawl.canonicalDomain,
          pages: buildCompactCompetitorEvidence(crawl),
          ownDomain: normalizedBusinessHostname(scan.websiteUrl) ?? "",
          aiProvider,
          models: openAiModelsFromEnv(),
          workspaceId: actor.workspaceId,
        })
      : { suggestions: [], diagnostics: [], instrumentation: null };

    if (resolution.suggestions.length > 0) {
      const resolvedOnly = Object.fromEntries(resolution.suggestions.map((suggestion) => [suggestion.name, suggestion.url]));
      // Merge with whatever was already cached (rather than overwrite),
      // so a suggestion verified on an earlier visit isn't lost just
      // because this visit's batch happened to propose different names.
      await getStateRepository().saveScan({
        ...scan,
        competitorSuggestions: {
          status: "ready",
          suggestions: { ...cached?.suggestions, ...resolvedOnly },
          readyAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
    }

    return Response.json(
      {
        suggestions: resolution.suggestions,
        ...(debug
          ? {
              debug: {
                source: "fresh_resolution",
                aiConfigured: Boolean(aiProvider),
                businessName: scan.discoveryProfile?.business.name.value ?? crawl.canonicalDomain,
                ownDomain: normalizedBusinessHostname(scan.websiteUrl) ?? "",
                diagnostics: resolution.diagnostics,
                instrumentation: resolution.instrumentation,
                websiteUnderstandingTimeline: scan.discoveryProfile?.diagnosticTimeline,
                scanCreatedAtIso: scan.createdAt,
                analysisCompletedAtIso: scan.analysisCompletedAt,
                competitorSuggestionRequestCompletedAtIso: new Date().toISOString(),
              },
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
