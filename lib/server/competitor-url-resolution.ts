import type { AiProvider } from "@/lib/providers/contracts";
import type { ModelConfiguration } from "@/lib/domain/types";
import { crawlWebsite, validatePublicWebsiteUrl } from "@/lib/security/website-crawler";
import type { HostResolver, PinnedWebsiteFetch } from "@/lib/security/website-crawler";

export interface CompetitorUrlSuggestion {
  name: string;
  url: string;
}

/** Full per-candidate trace, for diagnosing why a candidate did or didn't
 * verify -- not returned in the normal production response, only when a
 * caller explicitly asks for it (see the API route's ?debug=1). */
export interface CompetitorUrlDiagnostic {
  /** The name as the model proposed it -- unlike the old
   * names-known-in-advance design, this is itself a hypothesis here, not
   * a given. */
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
  /** Which signal the match was found on, when identityMatch is true. */
  matchedOn?: "title" | "ogTitle" | "ogSiteName" | "description" | "bodyText";
  /** True only once both the URL and the identity match are confirmed --
   * this is what actually gets surfaced as a suggestion. An unverified
   * candidate (bad name, bad URL, or a failed identity check) is dropped
   * entirely, not shown as a name-only placeholder: unlike the previous
   * BusinessUnderstanding.competitors-based design, the name itself is
   * also just a model hypothesis here, so there is no part of an
   * unverified candidate worth presenting as fact. */
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
 * blob. Checking fields independently, in order of how reliably they
 * identify a site (structured metadata first, free body text last),
 * means a title or og:site_name that cleanly says the company name still
 * matches even when the body-text prefix is noisy (cookie banners, nav
 * labels, a framework's loading skeleton) -- a single combined-string
 * search would have diluted a clean signal with that noise instead of
 * checking it on its own. Reports which field actually matched, for
 * diagnostics.
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
 * Suggests up to 3 direct competitors for CompetitorsSetup.tsx to
 * auto-fill, from the business's own context -- not from
 * BusinessUnderstanding.competitors, whose evidence-based semantics
 * (name a competitor only when the website explicitly identifies it)
 * stay untouched and unused here. See the AiProvider.suggestCompetitors
 * doc comment for why.
 *
 * One batched request proposes name+URL pairs together (not two
 * sequential calls); every candidate then goes through the same
 * independent verification regardless of where it came from: normalized
 * and run through validatePublicWebsiteUrl (rejects unsafe/unsafe,
 * non-unique, or the user's own domain), then one lightweight single-page
 * fetch (crawlWebsite with maxPages: 1 -- not the multi-page competitor
 * crawl, which still only runs later if the user continues from this
 * screen) and an identity check against the homepage's own title/
 * og:site_name/og:title/description. Only a candidate whose URL AND
 * identity both verify is ever surfaced; since the name itself is also
 * just a model hypothesis in this design (unlike the old
 * names-already-known approach), an unverified candidate contributes
 * nothing trustworthy and is dropped entirely rather than shown as a
 * partial suggestion.
 */
export async function resolveCompetitorUrls(params: {
  businessName: string;
  websiteUrl: string;
  summary: string;
  productCategory?: string;
  targetAudience: string[];
  problemsSolved: string[];
  /** Canonical hostname of the user's own scanned site, "" for a context-mode scan with no website. */
  ownDomain: string;
  aiProvider: AiProvider;
  models: ModelConfiguration;
  workspaceId: string;
  /** Test-only injection points, matching website-crawler.ts's own
   * pattern -- unset in production, where the real resolver/fetch apply. */
  resolver?: HostResolver;
  fetchImpl?: PinnedWebsiteFetch;
}): Promise<CompetitorUrlResolutionResult> {
  const totalStarted = performance.now();

  const modelStarted = performance.now();
  let proposed: Array<{ name: string; url: string | null }> = [];
  try {
    const result = await params.aiProvider.suggestCompetitors({
      workspaceId: params.workspaceId,
      businessName: params.businessName,
      websiteUrl: params.websiteUrl,
      summary: params.summary,
      productCategory: params.productCategory,
      targetAudience: params.targetAudience,
      problemsSolved: params.problemsSolved,
      models: params.models,
    });
    proposed = result.value;
  } catch {
    // A model-lookup failure degrades to "no suggestions" -- the
    // Competitors screen falls back to its own single empty row, same
    // as a genuine zero-candidates result.
  }
  const modelLookupMs = performance.now() - modelStarted;

  const diagnostics: CompetitorUrlDiagnostic[] = proposed.map((entry) => ({
    name: entry.name, proposedUrl: entry.url, normalizedUrl: null, validation: "no_proposal",
    fetch: "not_attempted", identityMatch: null, verified: false,
  }));

  // Normalize, validate and dedupe before ever fetching anything.
  const seenHostnames = new Set<string>();
  const candidates: Array<{ name: string; url: string; diagnostic: CompetitorUrlDiagnostic }> = [];
  for (const diagnostic of diagnostics) {
    const rawUrl = diagnostic.proposedUrl;
    if (!rawUrl) continue; // stays "no_proposal"
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
  const totalMs = performance.now() - totalStarted;

  console.info(JSON.stringify({
    type: "competitor_suggestion",
    workspaceId: params.workspaceId,
    modelLookupMs: Math.round(modelLookupMs),
    candidatesReturned: proposed.length,
    verificationMs: Math.round(verificationMs),
    verifiedCount: suggestions.length,
    totalMs: Math.round(totalMs),
  }));

  return {
    suggestions,
    diagnostics,
    instrumentation: {
      modelLookupMs, candidatesReturned: proposed.length, verificationMs,
      verifiedCount: suggestions.length, totalMs,
    },
  };
}
