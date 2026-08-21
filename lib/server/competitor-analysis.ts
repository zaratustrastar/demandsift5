import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { crawlWebsite } from "@/lib/security/website-crawler";
import type { CompetitorProfile } from "./contracts";
import { createId } from "./ids";

/**
 * Sidecar competitor-homepage analysis: a small addition alongside the
 * primary business pipeline, not a modification of it.
 *
 * A competitor's homepage is understood through exactly the same
 * homepage-only, cheap/fast pass as the primary business's own fast profile
 * (see runFastUnderstanding in scan-workflow.ts): the same SSRF/DNS-pinned
 * crawlWebsite() with maxPages: 1, and the same aiProvider.analyzeBusinessFast
 * schema/model. Reusing that pipeline rather than inventing a second one
 * keeps this genuinely a sidecar -- there is exactly one "fast website
 * understanding" code path, just called on a different URL.
 *
 * The result is intentionally a different shape (CompetitorProfile, not
 * BusinessUnderstanding/ScanBusinessProfile): a competitor's homepage
 * describes the competitor, never the user's own business, and callers must
 * never fold these fields into discoveryProfile or treat them as verified
 * facts about the business being scanned.
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
    crawl = await crawlWebsite(url, { maxPages: 1, timeoutMs: 6_000 });
  } catch (error) {
    return competitorAnalysisFailure(
      url,
      error instanceof Error ? error.message : "Could not safely read this competitor's website.",
    );
  }

  const homepage = crawl.pages[0];
  const analyzedAt = new Date().toISOString();
  const aiProvider = process.env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv() : null;

  if (!aiProvider) {
    // Same conservative-fallback policy as the primary business's own fast
    // pass: no AI configured is not a failure, just a thinner result.
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
    const analyzed = await aiProvider.analyzeBusinessFast({
      workspaceId,
      businessId: createId("competitor"),
      websiteUrl: crawl.canonicalUrl,
      canonicalDomain: crawl.canonicalDomain,
      pages: [{ ...homepage, sourceId: `web_${homepage.contentHash.slice(0, 20)}` }],
      models,
    });
    const fast = analyzed.value;
    return {
      url,
      domain: crawl.canonicalDomain,
      name: fast.name,
      summary: fast.summary,
      productCategory: fast.productCategory,
      keyphrases: fast.productTerms,
      painPhrases: fast.customerProblemLanguage,
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
