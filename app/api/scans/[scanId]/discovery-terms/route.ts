import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import { sanitizeDiscoveryOverrides } from "@/lib/intelligence/discovery-overrides";
import { scanReviewVersion } from "@/lib/server/scan-lifecycle";

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
    if (scan.approval || scan.status === "running" || scan.status === "retrying" || scan.status === "complete") {
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

    const updated = { ...scan, discoveryOverrides: overrides, updatedAt: new Date().toISOString() };
    await getStateRepository().saveScan(updated);
    return Response.json({ discoveryOverrides: overrides, reviewVersion: scanReviewVersion(updated) }, { headers: { "Cache-Control": "no-store" } });
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
        reviewVersion: scanReviewVersion(scan),
        editable:
          Boolean(analysis) &&
          !scan.approval &&
          scan.status !== "running" &&
          scan.status !== "retrying" &&
          scan.status !== "complete",
        discoveryOverrides: scan.discoveryOverrides ?? null,
        profile: analysis?.profile ?? null,
        // "fast" means this is still the homepage-only preview; a fuller
        // analysis is (or was) refining in the background. Absent/"full"
        // both mean the complete analysis. The review screen uses this to
        // silently refresh an untouched profile once refinement lands,
        // without clobbering anything the user has already edited.
        profileStage: analysis?.profileStage ?? (analysis ? "full" : null),
        // Optional competitor homepages the user has analyzed on the
        // Competitors tab. Empty until they add and analyze any -- see
        // POST /api/competitors/analyze.
        competitorProfiles: scan.competitorProfiles ?? [],
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
