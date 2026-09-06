import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { normalizedBusinessHostname } from "@/lib/server/business-access";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { resolveCompetitorUrls } from "@/lib/server/competitor-url-resolution";
import { MAX_COMPETITOR_URLS } from "@/lib/server/competitor-analysis";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Suggested official homepage URLs for the top competitor names the
 * existing website/context analysis already identified -- shown on
 * CompetitorsSetup.tsx as editable, removable, replaceable pre-fills,
 * never as locked values. See lib/server/competitor-url-resolution.ts for
 * the actual resolution + verification pipeline; this route is only the
 * cache-or-compute wrapper around it.
 *
 * Deliberately its own endpoint rather than a field added to the existing
 * GET /api/scans/[scanId]/discovery-terms, which DiscoveryProfile.tsx also
 * calls for unrelated data (product terms, personas, etc.) -- adding this
 * work there would slow that screen down every time, for a result it
 * never uses.
 *
 * Only successfully-resolved names are ever cached (see the save below) --
 * a name that resolved to null is retried on the next request rather than
 * being permanently remembered as "nothing here." A model hiccup or a
 * homepage that briefly failed to fetch would otherwise never get a
 * second chance for the lifetime of the scan.
 *
 * ?debug=1 returns the full per-candidate diagnostic trail from
 * resolveCompetitorUrls (proposed URL, validation outcome, homepage
 * identity signals, which one matched) instead of running silently --
 * for diagnosing why a name didn't resolve, not used by CompetitorsSetup.tsx.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:competitor-url-suggestions", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const debug = new URL(request.url).searchParams.get("debug") === "1";

    const business = scan.discoveryProfile?.business;
    if (!business) {
      throw new ApiError(
        "Analyze the website before suggesting competitor websites.",
        409,
        "website_not_analyzed",
      );
    }

    const names = business.competitors.value.map((competitor) => competitor.name).slice(0, MAX_COMPETITOR_URLS);
    if (names.length === 0) {
      return Response.json(
        { suggestions: [], ...(debug ? { debug: { competitorNames: [], source: "no_competitors_detected" } } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const cached = scan.discoveryProfile?.competitorUrlSuggestions;
    if (!debug && cached && names.every((name) => name in cached)) {
      return Response.json(
        { suggestions: names.map((name) => ({ name, url: cached[name] ?? null })) },
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
          competitorNames: names,
          ownBusinessSummary: business.summary.value,
          ownDomain: normalizedBusinessHostname(scan.websiteUrl) ?? "",
          aiProvider,
          models: openAiModelsFromEnv(),
          workspaceId: actor.workspaceId,
        })
      : { suggestions: names.map((name) => ({ name, url: null })), diagnostics: [], instrumentation: null };

    if (scan.discoveryProfile) {
      const resolvedOnly = Object.fromEntries(
        resolution.suggestions.filter((suggestion) => suggestion.url !== null).map((suggestion) => [suggestion.name, suggestion.url]),
      );
      // Merge with whatever was already cached (rather than overwrite),
      // so a name resolved on an earlier visit isn't lost just because
      // this visit's batch happened to not re-resolve it.
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
                competitorNames: names,
                ownBusinessSummary: business.summary.value,
                ownDomain: normalizedBusinessHostname(scan.websiteUrl) ?? "",
                diagnostics: resolution.diagnostics,
                instrumentation: resolution.instrumentation,
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
