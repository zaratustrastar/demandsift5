import type { AiProvider } from "@/lib/providers/contracts";
import type { ModelConfiguration } from "@/lib/domain/types";
import { crawlWebsite, validatePublicWebsiteUrl } from "@/lib/security/website-crawler";
import type { HostResolver, PinnedWebsiteFetch, WebsiteCrawlResult } from "@/lib/security/website-crawler";

export interface CompetitorUrlSuggestion {
  name: string;
  url: string;
}

/** Full per-candidate trace, for diagnosing why a candidate did or didn't
 * verify -- not returned in the normal production response, only when a
 * caller explicitly asks for it (see the API route's ?debug=1). */
export interface CompetitorUrlDiagnostic {
  /** The name as the model proposed it -- itself a hypothesis here, not a given. */
  name: string;
  proposedUrl: string | null;
  normalizedUrl: string | null;
  validation: "no_proposal" | "invalid_or_unsafe_url" | "own_domain" | "duplicate_domain" | "valid";
  validatedHostname?: string;
  fetch: "not_attempted" | "success" | "failed";
  fetchError?: string;
  homepageTitle?: string;
  ogTitle?: string;
  ogSiteName?: string;
  description?: string;
  bodyTextPrefix?: string;
  identityMatch: boolean | null;
  matchedOn?: "title" | "ogTitle" | "ogSiteName" | "description" | "bodyText";
  /** True only once both the URL and the identity match are confirmed --
   * an unverified candidate is dropped entirely, not shown as a
   * partial/name-only suggestion, since the name itself is also just a
   * model hypothesis in this design, not evidence-based fact. */
  verified: boolean;
}

export interface CompetitorUrlResolutionResult {
  suggestions: CompetitorUrlSuggestion[];
  diagnostics: CompetitorUrlDiagnostic[];
  instrumentation: {
    modelLookupMs: number;
    candidatesReturned: number;
    verificationMs: number;
    verifiedCount: number;
    totalMs: number;
  };
}

/** Strips corporate suffixes and punctuation so "Cal.com, Inc." and "cal
 * com" compare equal, without needing a real NLP dependency for a task
 * this small. */
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|labs|technologies|technology|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function textIncludesName(competitorName: string, text: string | undefined): boolean {
  if (!text) return false;
  const normalizedName = normalizeForMatch(competitorName);
  if (!normalizedName) return false;
  const normalizedText = normalizeForMatch(text);
  if (normalizedText.includes(normalizedName)) return true;
  const tokens = normalizedName.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  const primaryToken = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), "");
  return primaryToken.length >= 3 && normalizedText.includes(primaryToken);
}

/**
 * A deliberately conservative identity check, done against each signal
 * separately (title, og:site_name, og:title, description, then a
 * body-text prefix as the last resort) rather than one concatenated
 * blob -- see the git history for the full rationale. Reports which
 * field actually matched, for diagnostics.
 */
function identityMatch(
  competitorName: string,
  identity: { title?: string; ogTitle?: string; ogSiteName?: string; description?: string; bodyTextPrefix?: string },
): { matched: boolean; matchedOn?: CompetitorUrlDiagnostic["matchedOn"] } {
  const order: Array<[CompetitorUrlDiagnostic["matchedOn"], string | undefined]> = [
    ["title", identity.title],
    ["ogSiteName", identity.ogSiteName],
    ["ogTitle", identity.ogTitle],
    ["description", identity.description],
    ["bodyText", identity.bodyTextPrefix],
  ];
  for (const [field, value] of order) {
    if (textIncludesName(competitorName, value)) return { matched: true, matchedOn: field };
  }
  return { matched: false };
}

/**
 * The shared verification stage, independent of how the {name, url}
 * candidates were proposed (from a completed BusinessUnderstanding, or
 * directly from compact crawl evidence -- see the two callers below,
 * currently kept side by side for an A/B comparison rather than one
 * replacing the other outright). Every candidate is normalized and run
 * through the same validatePublicWebsiteUrl used before crawling
 * anything, then one lightweight single-page fetch (crawlWebsite with
 * maxPages: 1, not the multi-page competitor crawl) and an identity
 * check against the homepage's own title/og:site_name/og:title/
 * description. Only a candidate whose URL AND identity both verify is
 * ever surfaced.
 */
async function verifyProposedCompetitors(
  proposed: Array<{ name: string; url: string | null }>,
  params: { ownDomain: string; resolver?: HostResolver; fetchImpl?: PinnedWebsiteFetch },
): Promise<{ suggestions: CompetitorUrlSuggestion[]; diagnostics: CompetitorUrlDiagnostic[]; verificationMs: number }> {
  const diagnostics: CompetitorUrlDiagnostic[] = proposed.map((entry) => ({
    name: entry.name, proposedUrl: entry.url, normalizedUrl: null, validation: "no_proposal",
    fetch: "not_attempted", identityMatch: null, verified: false,
  }));

  const seenHostnames = new Set<string>();
  const candidates: Array<{ name: string; url: string; diagnostic: CompetitorUrlDiagnostic }> = [];
  for (const diagnostic of diagnostics) {
    const rawUrl = diagnostic.proposedUrl;
    if (!rawUrl) continue;
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    diagnostic.normalizedUrl = withScheme;
    try {
      const target = await validatePublicWebsiteUrl(withScheme, params.resolver);
      if (params.ownDomain && target.canonicalHostname === params.ownDomain) {
        diagnostic.validation = "own_domain";
        diagnostic.validatedHostname = target.canonicalHostname;
        continue;
      }
      if (seenHostnames.has(target.canonicalHostname)) {
        diagnostic.validation = "duplicate_domain";
        diagnostic.validatedHostname = target.canonicalHostname;
        continue;
      }
      seenHostnames.add(target.canonicalHostname);
      diagnostic.validation = "valid";
      diagnostic.validatedHostname = target.canonicalHostname;
      candidates.push({ name: diagnostic.name, url: target.url.toString(), diagnostic });
    } catch {
      diagnostic.validation = "invalid_or_unsafe_url";
    }
  }

  const verificationStarted = performance.now();
  await Promise.all(
    candidates.map(async ({ name, url, diagnostic }) => {
      try {
        const crawl = await crawlWebsite(url, {
          maxPages: 1,
          timeoutMs: 5_000,
          renderTimeoutMs: 8_000,
          resolver: params.resolver,
          fetchImpl: params.fetchImpl,
        });
        const homepage = crawl.pages[0];
        if (!homepage) {
          diagnostic.fetch = "failed";
          diagnostic.fetchError = "No page returned.";
          return;
        }
        diagnostic.fetch = "success";
        diagnostic.homepageTitle = homepage.identity?.title ?? homepage.title;
        diagnostic.ogTitle = homepage.identity?.ogTitle;
        diagnostic.ogSiteName = homepage.identity?.ogSiteName;
        diagnostic.description = homepage.identity?.description ?? homepage.description;
        diagnostic.bodyTextPrefix = homepage.text.slice(0, 300);
        const { matched, matchedOn } = identityMatch(name, {
          title: diagnostic.homepageTitle,
          ogTitle: diagnostic.ogTitle,
          ogSiteName: diagnostic.ogSiteName,
          description: diagnostic.description,
          bodyTextPrefix: homepage.text.slice(0, 800),
        });
        diagnostic.identityMatch = matched;
        diagnostic.matchedOn = matchedOn;
        diagnostic.verified = matched;
      } catch (error) {
        diagnostic.fetch = "failed";
        diagnostic.fetchError = error instanceof Error ? error.message : "Unknown error.";
      }
    }),
  );
  const verificationMs = performance.now() - verificationStarted;

  const suggestions: CompetitorUrlSuggestion[] = candidates
    .filter(({ diagnostic }) => diagnostic.verified)
    .map(({ name, url }) => ({ name, url }));

  return { suggestions, diagnostics, verificationMs };
}

const MAX_EVIDENCE_PAGES = 4;
const MAX_TEXT_EXCERPT_CHARS = 600;

export interface CompactCompetitorEvidencePage {
  url: string;
  title: string;
  description?: string;
  textExcerpt: string;
}

/**
 * Builds a small, capped evidence set from an already-crawled site --
 * enough to understand product, audience, and positioning, deliberately
 * far short of what analyzeBusiness receives (up to 28,000 chars per
 * page there vs. 600 here). Up to the same 4 pages the crawl already
 * selected; no new crawling or page selection of its own.
 */
export function buildCompactCompetitorEvidence(crawl: WebsiteCrawlResult): CompactCompetitorEvidencePage[] {
  return crawl.pages.slice(0, MAX_EVIDENCE_PAGES).map((page) => ({
    url: page.url,
    title: page.title,
    description: page.description,
    textExcerpt: page.text.slice(0, MAX_TEXT_EXCERPT_CHARS),
  }));
}

/**
 * Suggests competitors directly from compact crawl evidence (see
 * buildCompactCompetitorEvidence), with no dependency on
 * BusinessUnderstanding at all -- adopted after an A/B comparison against
 * the prior BusinessUnderstanding-based approach showed comparable-to-
 * better results across several different business types, while letting
 * this run concurrently with analyzeBusiness in
 * scan-workflow.ts's runFullWebsiteUnderstanding instead of waiting on it.
 */
export async function resolveCompetitorUrlsFromCrawl(params: {
  websiteUrl: string;
  canonicalDomain: string;
  pages: CompactCompetitorEvidencePage[];
  ownDomain: string;
  aiProvider: AiProvider;
  models: ModelConfiguration;
  workspaceId: string;
  resolver?: HostResolver;
  fetchImpl?: PinnedWebsiteFetch;
}): Promise<CompetitorUrlResolutionResult> {
  const totalStarted = performance.now();
  const modelStarted = performance.now();
  let proposed: Array<{ name: string; url: string | null }> = [];
  try {
    const result = await params.aiProvider.suggestCompetitorsFromCrawl({
      workspaceId: params.workspaceId,
      websiteUrl: params.websiteUrl,
      canonicalDomain: params.canonicalDomain,
      pages: params.pages,
      models: params.models,
    });
    proposed = result.value;
  } catch {
    // Same conservative degrade as the OLD path above.
  }
  const modelLookupMs = performance.now() - modelStarted;

  const { suggestions, diagnostics, verificationMs } = await verifyProposedCompetitors(proposed, params);
  const totalMs = performance.now() - totalStarted;

  console.info(JSON.stringify({
    type: "competitor_suggestion", source: "crawl_evidence", workspaceId: params.workspaceId,
    modelLookupMs: Math.round(modelLookupMs), candidatesReturned: proposed.length,
    verificationMs: Math.round(verificationMs), verifiedCount: suggestions.length, totalMs: Math.round(totalMs),
  }));

  return {
    suggestions, diagnostics,
    instrumentation: { modelLookupMs, candidatesReturned: proposed.length, verificationMs, verifiedCount: suggestions.length, totalMs },
  };
}
