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

export interface CompetitorUrlResolutionResult {
  suggestions: CompetitorUrlSuggestion[];
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

/**
 * A deliberately conservative identity check: does the competitor's name
 * (or its single most distinctive token, for short/compound names like
 * "Cal.com" or "Notion Labs") actually appear in what the homepage itself
 * says about itself. This is the independent verification step that keeps
 * a hallucinated-but-real domain from ever being auto-filled -- passing
 * validatePublicWebsiteUrl only proves a URL is safe to fetch, not that it
 * is the right company.
 */
function identityMatches(competitorName: string, identityText: string): boolean {
  const normalizedName = normalizeForMatch(competitorName);
  if (!normalizedName) return false;
  const normalizedIdentity = normalizeForMatch(identityText);
  if (normalizedIdentity.includes(normalizedName)) return true;
  const tokens = normalizedName.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  const primaryToken = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), "");
  return primaryToken.length >= 3 && normalizedIdentity.includes(primaryToken);
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
 * continues from this screen) and is only kept if the homepage's own title/
 * description/metadata actually identifies as that company. A domain that
 * is real, public, and SSRF-safe but simply is not the named competitor is
 * caught here, not just at the URL-validation layer.
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
    return { suggestions: [], instrumentation: { modelLookupMs: 0, verificationMs: 0, resolvedCount: 0, totalCount: 0, totalMs: 0 } };
  }

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

  // Normalize, validate and dedupe before ever fetching anything.
  const seenHostnames = new Set<string>();
  const candidates: Array<{ name: string; url: string }> = [];
  for (const name of names) {
    const rawUrl = proposedByName.get(name);
    if (!rawUrl) continue;
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    try {
      const target = await validatePublicWebsiteUrl(withScheme, params.resolver);
      if (params.ownDomain && target.canonicalHostname === params.ownDomain) continue;
      if (seenHostnames.has(target.canonicalHostname)) continue;
      seenHostnames.add(target.canonicalHostname);
      candidates.push({ name, url: target.url.toString() });
    } catch {
      // Not a valid/unique/public/SSRF-safe destination -- dropped, not surfaced.
    }
  }

  const verificationStarted = performance.now();
  const verified = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const crawl = await crawlWebsite(candidate.url, {
          maxPages: 1,
          timeoutMs: 5_000,
          renderTimeoutMs: 8_000,
          resolver: params.resolver,
          fetchImpl: params.fetchImpl,
        });
        const homepage = crawl.pages[0];
        if (!homepage) return null;
        const identityText = [homepage.title, homepage.description ?? "", homepage.text.slice(0, 800)].join(" ");
        return identityMatches(candidate.name, identityText) ? candidate : null;
      } catch {
        return null;
      }
    }),
  );
  const verificationMs = performance.now() - verificationStarted;

  const verifiedByName = new Map(
    verified.filter((entry): entry is { name: string; url: string } => entry !== null).map((entry) => [entry.name, entry.url]),
  );
  const suggestions = names.map((name) => ({ name, url: verifiedByName.get(name) ?? null }));
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
    instrumentation: { modelLookupMs, verificationMs, resolvedCount, totalCount: names.length, totalMs },
  };
}
