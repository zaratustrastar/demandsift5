import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import { crawlWebsite } from "@/lib/security/website-crawler";
import type { CompetitorProfile } from "./contracts";
import { createId } from "./ids";

/**
 * Sidecar competitor analysis: a small addition alongside the primary
 * business pipeline, not a modification of it.
 *
 * By explicit request, a competitor's site is understood through the same
 * multi-page, full aiProvider.analyzeBusiness model the primary business's
 * own profile eventually gets (see runScan/refineDiscoveryProfile in
 * scan-workflow.ts) -- not the instant, homepage-only, cheap/fast pass this
 * used to share with the primary business's preview. Competitor analysis
 * already only runs once, synchronously, when the user presses Continue
 * with typed URLs (see CompetitorsSetup.tsx), so there was no separate
 * "instant preview" UX being protected here; the fast tier was only ever
 * saving a few seconds at the cost of the same terser, compressed-sounding
 * keyphrases/pain phrases the primary business's fast preview had.
 *
 * The result is intentionally a different shape (CompetitorProfile, not
 * BusinessUnderstanding/ScanBusinessProfile): a competitor's site describes
 * the competitor, never the user's own business, and callers must never
 * fold these fields into discoveryProfile or treat them as verified facts
 * about the business being scanned.
 */

export const MAX_COMPETITOR_URLS = 3;

function safeDomain(url: string): string {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

function competitorAnalysisFailure(url: string, message: string): CompetitorProfile {
  return {
    url,
    domain: safeDomain(url),
    name: safeDomain(url),
    summary: "",
    productCategory: "",
    keyphrases: [],
    painPhrases: [],
    status: "failed",
    error: message,
    analyzedAt: new Date().toISOString(),
  };
}

async function analyzeOneCompetitor(
  workspaceId: string,
  url: string,
): Promise<CompetitorProfile> {
  let crawl: Awaited<ReturnType<typeof crawlWebsite>>;
  try {
    crawl = await crawlWebsite(url, { maxPages: 4 });
  } catch (error) {
    return competitorAnalysisFailure(
      url,
      error instanceof Error ? error.message : "Could not safely read this competitor's website.",
    );
  }

  const homepage = crawl.pages[0];
  const analyzedAt = new Date().toISOString();
  const capacity = aiCapacityFromEnv();
  const aiProvider = process.env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv(process.env, {
    requestGate: globallyBoundedAiRequestGate({ workspaceId, localLimit: capacity.requestConcurrency,
      holderPrefix: `competitor:${workspaceId}:${crawl.canonicalDomain}` }),
  }) : null;

  if (!aiProvider) {
    // Same conservative-fallback policy as the primary business's own
    // analysis: no AI configured is not a failure, just a thinner result.
    return {
      url,
      domain: crawl.canonicalDomain,
      name: homepage.title || crawl.canonicalDomain,
      summary: homepage.description ?? "",
      productCategory: "",
      keyphrases: [],
      painPhrases: [],
      status: "ready",
      analyzedAt,
    };
  }

  try {
    const models = openAiModelsFromEnv();
    const pages = crawl.pages.map((page) => ({
      ...page,
      sourceId: `web_${page.contentHash.slice(0, 20)}`,
    }));
    const analyzed = await aiProvider.analyzeBusiness({
      workspaceId,
      businessId: createId("competitor"),
      websiteUrl: crawl.canonicalUrl,
      canonicalDomain: crawl.canonicalDomain,
      pages,
      models,
    });
    const business = analyzed.value;
    return {
      url,
      domain: crawl.canonicalDomain,
      name: business.name.value,
      summary: business.summary.value,
      productCategory: business.productCategory.value,
      keyphrases: business.productTerms.value,
      painPhrases: business.customerProblemLanguage.value,
      status: "ready",
      analyzedAt,
    };
  } catch (error) {
    return competitorAnalysisFailure(
      url,
      error instanceof Error ? error.message : "Could not analyze this competitor's website.",
    );
  }
}

/**
 * Analyzes up to MAX_COMPETITOR_URLS competitor homepages in parallel.
 * Each URL is isolated: one competitor's crawl/analysis failure never fails
 * the batch or drops the others, it just comes back with status: "failed"
 * so the review screen can show it and let the user retry or remove it.
 */
export async function analyzeCompetitorUrls(
  workspaceId: string,
  rawUrls: readonly string[],
): Promise<CompetitorProfile[]> {
  const urls = [...new Set(rawUrls.map((url) => url.trim()).filter(Boolean))].slice(
    0,
    MAX_COMPETITOR_URLS,
  );
  return Promise.all(urls.map((url) => analyzeOneCompetitor(workspaceId, url)));
}
