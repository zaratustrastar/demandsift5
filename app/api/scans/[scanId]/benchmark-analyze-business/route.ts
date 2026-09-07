import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { pagesFromCrawl, assertWebsiteProfileEvidence } from "@/lib/server/scan-workflow";
import { createId } from "@/lib/server/ids";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * TEMPORARY, investigation-only endpoint -- not used by any production UI.
 * Runs analyzeBusiness() against a scan's already-persisted crawl snapshot
 * (no re-crawl) under 4 configurations (model x reasoningEffort), for a
 * direct latency/quality benchmark before considering any change to the
 * production configuration. Remove once that investigation concludes.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);
    const crawl = scan.websiteSnapshot?.crawl;
    if (!crawl) throw new ApiError("No crawl snapshot is available for this scan to benchmark against.", 409, "no_crawl_snapshot");

    const models = openAiModelsFromEnv();
    const allConfigs: Array<{ label: string; model: string; reasoningEffort: "low" | "medium" }> = [
      { label: "sol-medium (current baseline)", model: models.analysisModel, reasoningEffort: "medium" },
      { label: "sol-low", model: models.analysisModel, reasoningEffort: "low" },
      { label: "luna-medium", model: models.economyModel, reasoningEffort: "medium" },
      { label: "luna-low", model: models.economyModel, reasoningEffort: "low" },
    ];
    // Each config is one analyzeBusiness call that can itself take
    // 10-50+ seconds; running all 4 in a single request risks exceeding
    // typical client-side request timeouts. ?configIndex=0..3 runs just
    // one, so a caller can issue 4 separate requests instead.
    const configIndexParam = new URL(request.url).searchParams.get("configIndex");
    const configs = configIndexParam !== null ? [allConfigs[Number(configIndexParam)]] : allConfigs;
    if (configIndexParam !== null && !configs[0]) throw new ApiError("configIndex must be 0-3.", 400, "invalid_config_index");

    const { pages } = pagesFromCrawl(crawl);
    const inputCharCount = pages.reduce((sum, page) => sum + page.text.length, 0);

    const results = [];
    for (const config of configs) {
      const diagnosticEvents: string[] = [];
      const requestEvents: Array<{ phase: string; attempt?: number; model?: string }> = [];
      const capacity = aiCapacityFromEnv();
      const aiProvider = createOpenAiProviderFromEnv(process.env, {
        requestGate: globallyBoundedAiRequestGate({
          workspaceId: actor.workspaceId,
          localLimit: capacity.requestConcurrency,
          holderPrefix: `benchmark-analyze-business:${actor.workspaceId}:${scanId}:${config.label}`,
        }),
        onDiagnostic: (event) => { diagnosticEvents.push(event.kind); },
        onRequest: (event) => { requestEvents.push({ phase: event.phase, attempt: event.attempt, model: event.model }); },
      });

      const started = performance.now();
      let outcome: "success" | "error" = "success";
      let errorMessage: string | undefined;
      let evidenceValid = false;
      let businessValue: unknown = null;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      let actualModel: string | undefined;
      try {
        const analyzed = await aiProvider.analyzeBusiness({
          workspaceId: actor.workspaceId,
          businessId: createId("biz"),
          websiteUrl: scan.websiteUrl,
          canonicalDomain: crawl.canonicalDomain,
          pages,
          models: { ...models, analysisModel: config.model },
          reasoningEffortOverride: config.reasoningEffort,
        });
        usage = { inputTokens: analyzed.usage.inputTokens, outputTokens: analyzed.usage.outputTokens };
        actualModel = analyzed.model;
        try {
          assertWebsiteProfileEvidence(scan, analyzed.value);
          evidenceValid = true;
        } catch {
          evidenceValid = false;
        }
        businessValue = analyzed.value;
      } catch (error) {
        outcome = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      const latencyMs = performance.now() - started;

      const httpRequestCount = requestEvents.filter((event) => event.phase === "start").length;
      results.push({
        configLabel: config.label,
        requestedModel: config.model,
        actualModel,
        reasoningEffort: config.reasoningEffort,
        latencyMs: Math.round(latencyMs),
        outcome,
        errorMessage,
        evidenceValid,
        usage,
        httpRequestCount,
        retryOrFallbackDetected: httpRequestCount > 1 || diagnosticEvents.length > 0,
        diagnosticEvents,
        business: businessValue,
      });
    }

    return Response.json(
      {
        scanId,
        websiteUrl: scan.websiteUrl,
        pageCount: pages.length,
        inputCharCount,
        results,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
