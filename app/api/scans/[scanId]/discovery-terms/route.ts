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

    if (scan.status !== "queued") {
      throw new ApiError(
        "Discovery terms can only be edited before the scan starts.",
        409,
        "scan_already_started",
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
    const profile = scan.result?.profile;

    return Response.json(
      {
        editable: scan.status === "queued",
        discoveryOverrides: scan.discoveryOverrides ?? null,
        // Derived terms are shown so the user edits from what was found rather
        // than from a blank form.
        derived: profile
          ? {
              // ScanBusinessProfile exposes brand terms rather than the raw
              // productTerms seed list, so that is what the UI edits from.
              productTerms: profile.brandTerms ?? [],
              customerProblems: profile.customerProblemLanguage ?? [],
              competitors: profile.competitors ?? [],
              excludedTerms: profile.irrelevantTopics ?? [],
            }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
