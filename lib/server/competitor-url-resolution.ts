import type { AiProvider } from "@/lib/providers/contracts";
import type { ModelConfiguration } from "@/lib/domain/types";
import { crawlWebsite, validatePublicWebsiteUrl } from "@/lib/security/website-crawler";
import type { HostResolver, PinnedWebsiteFetch } from "@/lib/security/website-crawler";

export interface CompetitorUrlSuggestion {
  name: string;
  /** Null when no candidate survived validation and homepage identity
   * verification -- never a low-confidence guess presented as a fact. */
  url: string | null;
}

/** Full per-candidate trace, for diagnosing why a name did or didn't
 * resolve -- not returned in the normal production response, only when a
 * caller explicitly asks for it (see the API route's ?debug=1). */
export interface CompetitorUrlDiagnostic {
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
  finalUrl: string | null;
}

export interface CompetitorUrlResolutionResult {
  suggestions: CompetitorUrlSuggestion[];
  diagnostics: CompetitorUrlDiagnostic[];
  instrumentation: {
    modelLookupMs: number;
    verificationMs: number;
    resolvedCount: number;
    totalCount: number;
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
 * separately (title, og:title, og:site_name, description, then a body-text
 * prefix as the last resort) rather than one concatenated blob. Checking
 * fields independently, in order of how reliably they identify a site
 * (structured metadata first, free body text last), means a title or
 * og:site_name that cleanly says the company name still matches even when
 * the body-text prefix is noisy (cookie banners, nav labels, a framework's
 * loading skeleton) -- a single combined-string search would have diluted
 * a clean signal with that noise instead of checking it on its own.
 * Reports which field actually matched, for diagnostics.
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
 * Resolves up to 3 competitor names (from BusinessUnderstanding.competitors,
 * already produced by the existing website/context analysis -- this never
 * re-derives names of its own) to verified official homepage URLs, for
 * CompetitorsSetup.tsx to auto-fill as editable suggestions.
 *
 * Three independent safety layers, each able to fail without crashing the
 * Competitors screen: (1) one batched, low-effort model request proposes
 * candidates and is told to return null rather than guess; (2) every
 * candidate is normalized and run through the same validatePublicWebsiteUrl
 * used before crawling anything, rejecting anything unsafe, non-unique, or
 * equal to the user's own domain; (3) every surviving candidate gets one
 * lightweight single-page fetch (crawlWebsite with maxPages: 1 -- not the
 * multi-page competitor crawl, which still only runs later if the user
 * continues from this screen) and is only kept if the homepage's own
 * title/og:site_name/og:title/description identifies as that company. A
 * domain that is real, public, and SSRF-safe but simply is not the named
 * competitor is caught here, not just at the URL-validation layer.
 */
export async function resolveCompetitorUrls(params: {
  competitorNames: string[];
  ownBusinessSummary: string;
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
  const names = [...new Set(params.competitorNames.map((name) => name.trim()).filter(Boolean))].slice(0, 3);
  if (names.length === 0) {
    return { suggestions: [], diagnostics: [], instrumentation: { modelLookupMs: 0, verificationMs: 0, resolvedCount: 0, totalCount: 0, totalMs: 0 } };
  }

  const diagnostics = new Map<string, CompetitorUrlDiagnostic>(
    names.map((name) => [name, {
      name, proposedUrl: null, normalizedUrl: null, validation: "no_proposal",
      fetch: "not_attempted", identityMatch: null, finalUrl: null,
    }]),
  );

  const modelStarted = performance.now();
  let proposedByName = new Map<string, string | null>();
  try {
    const proposed = await params.aiProvider.resolveCompetitorDomains({
      workspaceId: params.workspaceId,
      ownBusinessSummary: params.ownBusinessSummary,
      competitorNames: names,
      models: params.models,
    });
    proposedByName = new Map(proposed.value.map((entry) => [entry.name, entry.url]));
  } catch {
    // A model-lookup failure degrades to "no suggestions" -- every
    // competitor field stays editable and empty, same as today.
  }
  const modelLookupMs = performance.now() - modelStarted;
  for (const [name, url] of proposedByName) {
    const diagnostic = diagnostics.get(name);
    if (diagnostic) diagnostic.proposedUrl = url;
  }

  // Normalize, validate and dedupe before ever fetching anything.
  const seenHostnames = new Set<string>();
  const candidates: Array<{ name: string; url: string }> = [];
  for (const name of names) {
    const diagnostic = diagnostics.get(name)!;
    const rawUrl = proposedByName.get(name);
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
      candidates.push({ name, url: target.url.toString() });
    } catch {
      diagnostic.validation = "invalid_or_unsafe_url";
    }
  }

  const verificationStarted = performance.now();
  await Promise.all(
    candidates.map(async (candidate) => {
      const diagnostic = diagnostics.get(candidate.name)!;
      try {
        const crawl = await crawlWebsite(candidate.url, {
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
        const { matched, matchedOn } = identityMatch(candidate.name, {
          title: diagnostic.homepageTitle,
          ogTitle: diagnostic.ogTitle,
          ogSiteName: diagnostic.ogSiteName,
          description: diagnostic.description,
          bodyTextPrefix: homepage.text.slice(0, 800),
        });
        diagnostic.identityMatch = matched;
        diagnostic.matchedOn = matchedOn;
        if (matched) diagnostic.finalUrl = candidate.url;
      } catch (error) {
        diagnostic.fetch = "failed";
        diagnostic.fetchError = error instanceof Error ? error.message : "Unknown error.";
      }
    }),
  );
  const verificationMs = performance.now() - verificationStarted;

  const suggestions = names.map((name) => ({ name, url: diagnostics.get(name)!.finalUrl }));
  const resolvedCount = suggestions.filter((suggestion) => suggestion.url !== null).length;
  const totalMs = performance.now() - totalStarted;

  console.info(JSON.stringify({
    type: "competitor_url_resolution",
    workspaceId: params.workspaceId,
    modelLookupMs: Math.round(modelLookupMs),
    verificationMs: Math.round(verificationMs),
    resolvedCount,
    totalCount: names.length,
    totalMs: Math.round(totalMs),
  }));

  return {
    suggestions,
    diagnostics: [...diagnostics.values()],
    instrumentation: { modelLookupMs, verificationMs, resolvedCount, totalCount: names.length, totalMs },
  };
}
