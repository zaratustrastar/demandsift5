import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { normalizedBusinessHostname } from "@/lib/server/business-access";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { resolveCompetitorUrls, resolveCompetitorUrlsFromCrawl, buildCompactCompetitorEvidence } from "@/lib/server/competitor-url-resolution";

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
 * Unlike an earlier version of this endpoint, competitor names are not
 * read from BusinessUnderstanding.competitors here at all -- that field's
 * evidence-based semantics (name a competitor only when the website
 * explicitly identifies it) mean it is empty for most real businesses
 * (a company's own marketing site essentially never names its rivals),
 * so it produced no suggestions in practice. Names and URLs are instead
 * proposed together, from the business's own profile, by
 * suggestCompetitors -- see that method's doc comment on AiProvider.
 *
 * Only successfully verified suggestions are ever cached (see the save
 * below) -- a scan with zero verified suggestions is retried on the next
 * request rather than being permanently remembered as "nothing here."
 *
 * ?debug=1 returns the full per-candidate diagnostic trail from
 * resolveCompetitorUrls (proposed name/URL, validation outcome, homepage
 * identity signals, which one matched) instead of running silently --
 * for diagnosing why a candidate didn't verify, not used by
 * CompetitorsSetup.tsx.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:competitor-url-suggestions", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const debug = new URL(request.url).searchParams.get("debug") === "1";
    const compareSuggestionSource = new URL(request.url).searchParams.get("compareSuggestionSource") === "1";

    const business = scan.discoveryProfile?.business;
    if (!business) {
      throw new ApiError(
        "Analyze the website before suggesting competitor websites.",
        409,
        "website_not_analyzed",
      );
    }

    // A/B comparison mode: runs both the OLD (business-profile-based) and
    // NEW (crawl-evidence-based) suggestion sources side by side, against
    // the already-persisted crawl snapshot -- no re-crawl, and never
    // writes to the suggestion cache, since this is purely a read-only
    // comparison for evaluating whether to switch. Not used by
    // CompetitorsSetup.tsx.
    if (compareSuggestionSource) {
      const crawl = scan.websiteSnapshot?.crawl;
      if (!crawl) {
        throw new ApiError("No crawl snapshot is available for this scan to compare against.", 409, "no_crawl_snapshot");
      }
      const capacity = aiCapacityFromEnv();
      const aiProvider = process.env.OPENAI_API_KEY?.trim()
        ? createOpenAiProviderFromEnv(process.env, {
            requestGate: globallyBoundedAiRequestGate({
              workspaceId: actor.workspaceId,
              localLimit: capacity.requestConcurrency,
              holderPrefix: `competitor-url-compare:${actor.workspaceId}:${scanId}`,
            }),
          })
        : null;
      if (!aiProvider) throw new ApiError("AI is not configured; cannot run the comparison.", 409, "ai_not_configured");
      const models = openAiModelsFromEnv();
      const ownDomain = normalizedBusinessHostname(scan.websiteUrl) ?? "";
      const compactEvidence = buildCompactCompetitorEvidence(crawl);
      const [oldResult, newResult] = await Promise.all([
        resolveCompetitorUrls({
          businessName: business.name.value, websiteUrl: scan.websiteUrl, summary: business.summary.value,
          productCategory: business.productCategory.value,
          targetAudience: business.targetAudiences.value.map((segment) => segment.name),
          problemsSolved: business.problemsSolved.value, ownDomain, aiProvider, models, workspaceId: actor.workspaceId,
        }),
        resolveCompetitorUrlsFromCrawl({
          websiteUrl: scan.websiteUrl, canonicalDomain: crawl.canonicalDomain, pages: compactEvidence,
          ownDomain, aiProvider, models, workspaceId: actor.workspaceId,
        }),
      ]);
      return Response.json(
        {
          businessName: business.name.value,
          old: { suggestions: oldResult.suggestions, diagnostics: oldResult.diagnostics, instrumentation: oldResult.instrumentation },
          new: { suggestions: newResult.suggestions, diagnostics: newResult.diagnostics, instrumentation: newResult.instrumentation },
          compactEvidencePromptChars: JSON.stringify({ websiteUrl: scan.websiteUrl, canonicalDomain: crawl.canonicalDomain, pages: compactEvidence }).length,
          oldPromptChars: JSON.stringify({
            businessName: business.name.value, websiteUrl: scan.websiteUrl, summary: business.summary.value,
            productCategory: business.productCategory.value, targetAudience: business.targetAudiences.value.map((segment) => segment.name),
            problemsSolved: business.problemsSolved.value,
          }).length,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Cached suggestions are keyed by whatever names the model proposed
    // on a prior successful run; there's no fixed expected-name list to
    // check against here (the model decides the names), so "anything
    // cached at all" is the fast-path condition instead of "every
    // expected name is present."
    const cached = scan.discoveryProfile?.competitorUrlSuggestions;
    if (!debug && cached && Object.keys(cached).length > 0) {
      return Response.json(
        { suggestions: Object.entries(cached).map(([name, url]) => ({ name, url })) },
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
      ? await resolveCompetitorUrls({
          businessName: business.name.value,
          websiteUrl: scan.websiteUrl,
          summary: business.summary.value,
          productCategory: business.productCategory.value,
          targetAudience: business.targetAudiences.value.map((segment) => segment.name),
          problemsSolved: business.problemsSolved.value,
          ownDomain: normalizedBusinessHostname(scan.websiteUrl) ?? "",
          aiProvider,
          models: openAiModelsFromEnv(),
          workspaceId: actor.workspaceId,
        })
      : { suggestions: [], diagnostics: [], instrumentation: null };

    if (scan.discoveryProfile && resolution.suggestions.length > 0) {
      const resolvedOnly = Object.fromEntries(resolution.suggestions.map((suggestion) => [suggestion.name, suggestion.url]));
      // Merge with whatever was already cached (rather than overwrite),
      // so a suggestion verified on an earlier visit isn't lost just
      // because this visit's batch happened to propose different names.
      await getStateRepository().saveScan({
        ...scan,
        discoveryProfile: {
          ...scan.discoveryProfile,
          competitorUrlSuggestions: { ...cached, ...resolvedOnly },
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
                businessName: business.name.value,
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
