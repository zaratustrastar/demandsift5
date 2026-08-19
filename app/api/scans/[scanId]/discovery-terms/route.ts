import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { sanitizeDiscoveryOverrides } from "@/lib/intelligence/discovery-overrides";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Review and edit what DemandSift should look for.
 *
 * Users may add, remove or replace the AI-derived discovery terms; DemandSift
 * remains responsible for compiling them into Reddit boolean searches. Edits
 * are only meaningful before retrieval, so this is rejected once the scan has
 * started rather than silently ignored.
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:discovery-terms", { limit: 30, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    // Editable between website analysis and Reddit retrieval. Requiring only
    // "queued" was not enough on its own: before analysis there is nothing to
    // review, and once retrieval has begun an edit would silently not apply.
    if (scan.status === "running" || scan.status === "retrying" || scan.status === "complete") {
      throw new ApiError(
        "Discovery terms can only be edited before the Reddit scan starts.",
        409,
        "scan_already_started",
      );
    }
    if (!scan.discoveryProfile) {
      throw new ApiError(
        "Analyze the website before editing what we should look for.",
        409,
        "website_not_analyzed",
      );
    }

    const overrides = sanitizeDiscoveryOverrides(await request.json().catch(() => null));
    if (!overrides) {
      throw new ApiError(
        "Provide at least one of productTerms, customerProblems, competitors or excludedTerms.",
        400,
        "invalid_discovery_terms",
      );
    }

    await getStateRepository().saveScan({ ...scan, discoveryOverrides: overrides, updatedAt: new Date().toISOString() });
    return Response.json({ discoveryOverrides: overrides }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** The current terms, so the UI can show what will actually be searched. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    // Read from the persisted analysis, not from `result`. A completed result
    // only exists after the scan these terms were meant to configure has
    // already run, so it can never be the source for the review step.
    const analysis = scan.discoveryProfile;
    const business = analysis?.business;

    return Response.json(
      {
        analyzed: Boolean(analysis),
        editable:
          Boolean(analysis) &&
          scan.status !== "running" &&
          scan.status !== "retrying" &&
          scan.status !== "complete",
        discoveryOverrides: scan.discoveryOverrides ?? null,
        profile: analysis?.profile ?? null,
        // Derived terms are shown so the user edits from what was found rather
        // than from a blank form.
        derived: business
          ? {
              productTerms: business.productTerms.value,
              customerProblems: business.customerProblemLanguage.value,
              competitors: business.competitors.value.map((competitor) => competitor.name),
              excludedTerms: business.irrelevantTopics.value,
              personas: business.targetAudiences.value.map((audience) => audience.name),
              useCases: business.jobsToBeDone?.value ?? [],
              purchaseTriggers: business.triggerEvents?.value ?? [],
              alternatives: business.likelyWorkarounds?.value ?? [],
            }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
