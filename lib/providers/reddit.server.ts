import { MockRedditProvider } from "@/lib/providers/mock-reddit";
import {
  contentFingerprint,
  isUsefulSearchPhrase,
  normalizeSearchText,
} from "@/lib/intelligence/opportunity-ranking";
import type {
  RedditProvider,
  RedditSearchRequest,
  RedditSearchResponse,
} from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";
import type { RedditConversation } from "@/lib/domain/types";

type ApprovedProviderConversation = {
  externalId?: unknown;
  kind?: unknown;
  subreddit?: unknown;
  title?: unknown;
  body?: unknown;
  author?: unknown;
  permalink?: unknown;
  createdAt?: unknown;
  score?: unknown;
  comments?: unknown;
};

type ApprovedProviderResponse = {
  conversations?: unknown;
  nextCursor?: unknown;
};

type ApifyRedditItem = {
  id?: unknown;
  parsedId?: unknown;
  url?: unknown;
  username?: unknown;
  title?: unknown;
  communityName?: unknown;
  parsedCommunityName?: unknown;
  category?: unknown;
  body?: unknown;
  postId?: unknown;
  parentId?: unknown;
  numberOfComments?: unknown;
  numberOfReplies?: unknown;
  upVotes?: unknown;
  isAd?: unknown;
  over18?: unknown;
  createdAt?: unknown;
  scrapedAt?: unknown;
  dataType?: unknown;
};

type ApifySearchActorInput = {
  searches: string[];
  ignoreStartUrls: true;
  skipComments: true;
  skipUserPosts: true;
  skipCommunity: true;
  includeMediaLinks: false;
  searchPosts: true;
  searchComments: true;
  searchCommunities: false;
  searchUsers: false;
  searchMedia: false;
  sort: "relevance";
  time: "day" | "week" | "month" | "year" | "all";
  includeNSFW: false;
  maxItems: number;
  maxPostCount: number;
  maxComments: number;
  maxCommunitiesCount: 0;
  maxUserCount: 0;
  scrollTimeout: number;
  navigationTimeout: number;
  debugMode: false;
  searchCommunityName?: string;
  postDateLimit?: string;
  commentDateLimit?: string;
  proxy: {
    useApifyProxy: true;
    apifyProxyGroups: ["RESIDENTIAL"];
  };
};

type ApifyEnrichmentActorInput = {
  startUrls: Array<{ url: string }>;
  skipComments: false;
  skipUserPosts: true;
  skipCommunity: true;
  includeMediaLinks: true;
  includeNSFW: false;
  maxItems: number;
  maxPostCount: number;
  maxComments: number;
  maxCommunitiesCount: 0;
  maxUserCount: 0;
  scrollTimeout: number;
  navigationTimeout: number;
  debugMode: false;
  proxy: {
    useApifyProxy: true;
    apifyProxyGroups: ["RESIDENTIAL"];
  };
};

export type ApifyRedditActorInput = ApifySearchActorInput | ApifyEnrichmentActorInput;

type ApifyCandidate = {
  item: ApifyRedditItem;
  externalId: string;
  kind: "post" | "comment";
  permalink: string;
  subreddit: string;
  title?: string;
  body: string;
  author?: string;
  createdAt?: string;
  matchedQuery?: string;
};

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for the configured Reddit provider.`);
  return normalized;
}

function redditPermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Reddit provider returned an invalid permalink.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (host !== "reddit.com" && !host.endsWith(".reddit.com") && host !== "redd.it")
  ) {
    throw new Error("The approved provider returned a non-Reddit permalink.");
  }
  return url.toString();
}

function safeRedditPermalink(value: unknown): string | undefined {
  try {
    return redditPermalink(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown, maximumLength = 10_000): string {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function cleanSearchTerm(value: string): string {
  const withoutControls = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  return withoutControls
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const numeric = code[1]?.toLowerCase() === "x"
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return entity;
    }
  });
}

function cleanRedditText(value: unknown, maximumLength = 12_000): string {
  return decodeHtmlEntities(stringValue(value, maximumLength * 2))
    .replace(/\u00a0/g, " ")
    .replace(/\s+submitted by\s+\/?u\/[^\s]+\s+\[link\]\s+\[comments\]\s*$/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maximumLength);
}

function wordCount(value: string): number {
  return cleanSearchTerm(value).split(/\s+/).filter(Boolean).length;
}

function usefulShortPhrase(value: string, maximumWords = 7): boolean {
  return wordCount(value) <= maximumWords && isUsefulSearchPhrase(value);
}

function redditSearchAtom(value: string): string {
  const normalized = normalizeSearchText(cleanSearchTerm(value))
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  if (!normalized) return "";
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

function redditExclusions(values: readonly string[]): string {
  const atoms = [...new Set(values.map(redditSearchAtom).filter(Boolean))].slice(0, 5);
  return atoms.length > 0 ? ` NOT (${atoms.join(" OR ")})` : "";
}

const PROBLEM_TOKEN_STOP_WORDS = new Set([
  "about", "across", "and", "are", "for", "from", "have", "into", "our", "that",
  "the", "their", "this", "too", "using", "with", "without", "your",
]);

function problemSearchExpression(value: string): string {
  const tokens = normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !PROBLEM_TOKEN_STOP_WORDS.has(token))
    .slice(0, 4);
  if (tokens.length < 2) return "";
  return `(${tokens.join(" AND ")}) AND (tool OR software OR solution OR help)`;
}

function automatedAuthor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "automoderator" ||
    normalized === "[deleted]" ||
    normalized === "reddit" ||
    /(?:^|[-_])(bot|moderator)(?:$|[-_])/i.test(normalized) ||
    normalized.endsWith("bot")
  );
}

/** Build precise Reddit-native Boolean searches for the actor's discovery run. */
export function buildApifyRedditSearches(request: RedditSearchRequest): string[] {
  const productTerms = request.queries.productTerms
    .map(cleanSearchTerm)
    .filter(isUsefulSearchPhrase);
  const productCategories = (request.queries.productCategories ?? [])
    .map(cleanSearchTerm)
    .filter((term) => usefulShortPhrase(term, 6));
  const problems = request.queries.customerProblems
    .map(cleanSearchTerm)
    .filter((term) => usefulShortPhrase(term, 7));
  const competitors = request.queries.competitors
    .map(cleanSearchTerm)
    .filter(isUsefulSearchPhrase);
  const primaryProduct = productTerms[0] ?? "";
  const primaryCategory = productCategories[0] ?? productTerms[1] ?? "";
  const brand = redditSearchAtom(primaryProduct);
  const category = redditSearchAtom(primaryCategory);
  const exclusions = redditExclusions(request.queries.excludedTerms);
  const candidates = [
    category && `${category} AND (recommendations OR recommend OR alternative OR options)${exclusions}`,
    category && `${category} AND ("looking for" OR "need a" OR "what are you using" OR "which tool")${exclusions}`,
    brand && `${brand} AND (alternative OR switching OR frustrated OR problem OR issue OR notifications)${exclusions}`,
    brand && category && `${brand} AND ${category}${exclusions}`,
    ...problems.slice(0, 3).map((problem) => {
      const expression = problemSearchExpression(problem);
      return expression ? `${expression}${exclusions}` : "";
    }),
    ...competitors.slice(0, 2).map((name) => {
      const competitor = redditSearchAtom(name);
      if (!competitor) return "";
      return `${competitor} AND (alternative OR switching OR frustrated OR problem)${category ? ` AND ${category}` : ""}${exclusions}`;
    }),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const cleaned = candidate.replace(/\s+/g, " ").trim().slice(0, 280);
    const key = cleaned.toLowerCase();
    if (
      cleaned.length < 2 ||
      seen.has(key)
    ) return [];
    seen.add(key);
    return [cleaned];
  }).slice(0, 8);
}

function phraseEvidence(text: string, phrases: readonly string[]): boolean {
  return phrases.some((value) => {
    const phrase = normalizeSearchText(value);
    if (!phrase) return false;
    if (text.includes(phrase)) return true;
    const tokens = phrase
      .split(" ")
      .filter((token) => token.length >= 3 && !PROBLEM_TOKEN_STOP_WORDS.has(token));
    if (tokens.length < 2) return false;
    const matches = tokens.filter((token) => text.includes(token)).length;
    return matches >= Math.min(3, tokens.length) && matches / tokens.length >= 0.6;
  });
}

const DEMAND_SIGNAL_PATTERN = /\b(alternatives?|compare|comparing|frustrated|help|issues?|looking for|need|notifications?|problems?|recommend(?:ation)?s?|replace|switching|tools?|workarounds?)\b/i;

const STRONG_DEMAND_SIGNAL_PATTERN = /\b(alternatives?|any recommendations|compare|comparing|frustrated|looking for|need a|recommend(?:ation)?s?|replace|switching|what are you using|which tool)\b/i;

/**
 * Cheap deterministic gate before enrichment and AI calls. It intentionally
 * requires business context in addition to a brand token, which removes
 * homonyms such as a mountain "basecamp".
 */
export function isApifyCandidateRelevant(
  candidate: Pick<ApifyCandidate, "title" | "body">,
  request: RedditSearchRequest,
): boolean {
  const text = normalizeSearchText(`${candidate.title ?? ""}\n${candidate.body}`);
  if (!text) return false;
  const excluded = request.queries.excludedTerms
    .map(normalizeSearchText)
    .filter((term) => term.length >= 3);
  if (excluded.some((term) => text.includes(term))) return false;

  const productTerms = request.queries.productTerms.filter(isUsefulSearchPhrase);
  const categories = (request.queries.productCategories ?? []).filter(isUsefulSearchPhrase);
  const problems = request.queries.customerProblems.filter(isUsefulSearchPhrase);
  const competitors = request.queries.competitors.filter(isUsefulSearchPhrase);
  const brandMatch = phraseEvidence(text, productTerms.slice(0, 1));
  const productContext = phraseEvidence(text, productTerms.slice(1));
  const categoryMatch = phraseEvidence(text, categories);
  const problemMatch = phraseEvidence(text, problems);
  const competitorMatch = phraseEvidence(text, competitors);
  const demandSignal = DEMAND_SIGNAL_PATTERN.test(text);

  return (
    categoryMatch ||
    problemMatch ||
    productContext ||
    (brandMatch && demandSignal) ||
    (competitorMatch && (demandSignal || categoryMatch))
  );
}

function candidateDiscoveryScore(candidate: ApifyCandidate, request: RedditSearchRequest): number {
  const text = `${candidate.title ?? ""}\n${candidate.body}`;
  const normalized = normalizeSearchText(text);
  const title = normalizeSearchText(candidate.title ?? "");
  const brand = request.queries.productTerms[0] ?? "";
  const problems = request.queries.customerProblems.filter(isUsefulSearchPhrase);
  const competitors = request.queries.competitors.filter(isUsefulSearchPhrase);
  let score = 0;
  if (STRONG_DEMAND_SIGNAL_PATTERN.test(title)) score += 5;
  else if (STRONG_DEMAND_SIGNAL_PATTERN.test(normalized)) score += 3;
  if (phraseEvidence(normalized, problems)) score += 3;
  if (phraseEvidence(normalized, competitors)) score += 2;
  if (phraseEvidence(normalized, [brand]) && DEMAND_SIGNAL_PATTERN.test(normalized)) score += 2;
  if (candidate.kind === "post") score += 1;
  if (candidate.body.length >= 120) score += 1;
  return score;
}

function subredditFromItem(item: ApifyRedditItem, permalink: string | undefined): string {
  const fromUrl = permalink?.match(/\/r\/([^/]+)/i)?.[1] ?? "";
  const candidate =
    fromUrl ||
    stringValue(item.parsedCommunityName, 80) ||
    stringValue(item.communityName, 80).replace(/^r\//i, "") ||
    stringValue(item.category, 80).replace(/^r\//i, "");
  return /^[A-Za-z0-9_]{1,32}$/.test(candidate) ? candidate : "";
}

function matchedSearchQuery(
  title: string | undefined,
  body: string,
  searches: readonly string[],
): string | undefined {
  const text = normalizeSearchText(`${title ?? ""}\n${body}`);
  return searches.find((query) => {
    const quoted = [...query.matchAll(/"([^"]+)"/g)]
      .map((match) => normalizeSearchText(match[1] ?? ""))
      .filter(Boolean);
    if (quoted.some((phrase) => text.includes(phrase))) return true;
    const terms = normalizeSearchText(query.replace(/\b(?:AND|OR|NOT)\b/g, " "))
      .split(" ")
      .filter((term) => term.length >= 4 && !PROBLEM_TOKEN_STOP_WORDS.has(term));
    return terms.filter((term) => text.includes(term)).length >= Math.min(2, terms.length);
  });
}

function apifyCandidate(
  value: unknown,
  searches: readonly string[] = [],
): ApifyCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as ApifyRedditItem;
  const dataType = stringValue(item.dataType, 20).toLowerCase();
  if (dataType !== "post" && dataType !== "comment") return null;
  if (item.isAd === true || item.over18 === true) return null;

  const title = cleanRedditText(item.title, 500) || undefined;
  const body = cleanRedditText(item.body) || title || "";
  const permalink = safeRedditPermalink(item.url);
  const subreddit = subredditFromItem(item, permalink);
  if (!body || !permalink || !subreddit) return null;

  const author = cleanRedditText(item.username, 100) || undefined;
  if (author && automatedAuthor(author)) return null;
  if (/^\[(?:deleted|removed)\]$/i.test(body)) return null;
  const externalId =
    stringValue(item.parsedId, 200) ||
    stringValue(item.id, 200).replace(/^t[13]_/i, "") ||
    `derived_${contentFingerprint(`${permalink}\n${body}`)}`;
  const rawCreatedAt = stringValue(item.createdAt, 80);
  const parsedCreatedAt = Date.parse(rawCreatedAt);
  return {
    item,
    externalId,
    kind: dataType,
    permalink,
    subreddit,
    title,
    body,
    author,
    createdAt: Number.isFinite(parsedCreatedAt)
      ? new Date(parsedCreatedAt).toISOString()
      : undefined,
    matchedQuery: matchedSearchQuery(title, body, searches),
  };
}

/** Normalize one documented Trudax Reddit Scraper dataset item. */
export function normalizeApifyRedditItem(
  value: unknown,
  actorId: string,
  searches: readonly string[] = [],
  options: { fallback?: ApifyCandidate; threadContext?: string } = {},
): RedditConversation | null {
  const candidate = apifyCandidate(value, searches) ?? options.fallback;
  if (!candidate) return null;
  const item = candidate.item;
  const createdAt = candidate.createdAt ?? options.fallback?.createdAt;
  if (!createdAt) return null;
  const parentExternalId =
    stringValue(item.parentId, 200) || stringValue(item.postId, 200) || undefined;
  const observedAt = new Date().toISOString();
  const provider = `apify:${actorId}`;
  return {
    provider,
    sourceMode: "apify-test",
    externalId: candidate.externalId,
    kind: candidate.kind,
    parentExternalId,
    subreddit: candidate.subreddit,
    title: candidate.title,
    body: candidate.body,
    threadContext: options.threadContext?.trim().slice(0, 6_000) || undefined,
    author: candidate.author,
    permalink: candidate.permalink,
    createdAt,
    metrics: {
      score: nonNegativeInteger(item.upVotes),
      comments:
        candidate.kind === "comment"
          ? nonNegativeInteger(item.numberOfReplies)
          : nonNegativeInteger(item.numberOfComments),
    },
    matchedQuery: candidate.matchedQuery ?? options.fallback?.matchedQuery,
    provenance: {
      id: `reddit_apify_${contentFingerprint(candidate.externalId)}`,
      kind: "reddit",
      provider,
      providerExternalId: candidate.externalId,
      url: candidate.permalink,
      title: candidate.title,
      excerpt: candidate.body.slice(0, 280),
      contentHash: contentFingerprint(
        `${candidate.title ?? ""}\n${candidate.body}\n${options.threadContext ?? ""}`,
      ),
      observedAt,
      isMock: false,
      metadata: {
        actorId,
        testOnly: true,
        acquisitionMethod: "web-scraping",
      },
    },
  };
}

function redditPostIdFromPermalink(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    const id = commentsIndex >= 0 ? segments[commentsIndex + 1] : undefined;
    return id && /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function threadContextForCandidate(candidate: ApifyCandidate, payload: readonly unknown[]): string {
  const postId = redditPostIdFromPermalink(candidate.permalink);
  if (!postId) return "";
  const comments = payload.flatMap((value) => {
    const item = apifyCandidate(value);
    if (
      !item ||
      item.kind !== "comment" ||
      item.externalId === candidate.externalId ||
      redditPostIdFromPermalink(item.permalink) !== postId
    ) return [];
    return [`${item.author ? `${item.author}: ` : ""}${item.body}`];
  });
  return [...new Set(comments)].slice(0, 8).join("\n\n").slice(0, 6_000);
}

function enrichedItemForCandidate(
  candidate: ApifyCandidate,
  payload: readonly unknown[],
): unknown | undefined {
  const postId = redditPostIdFromPermalink(candidate.permalink);
  return payload.find((value) => {
    const item = apifyCandidate(value);
    if (!item || item.kind !== candidate.kind) return false;
    if (item.externalId.replace(/^t[13]_/i, "") === candidate.externalId.replace(/^t[13]_/i, "")) {
      return true;
    }
    return candidate.kind === "post" && postId !== undefined &&
      redditPostIdFromPermalink(item.permalink) === postId;
  });
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
}

function apifyActorId(value: string): string {
  const normalized = value.trim().replace("/", "~");
  if (!/^(?:[A-Za-z0-9_-]{5,80}|[A-Za-z0-9_-]{1,80}~[A-Za-z0-9_-]{1,100})$/.test(normalized)) {
    throw new Error("APIFY_REDDIT_ACTOR_ID is invalid.");
  }
  return normalized;
}

/**
 * Real-data MVP test adapter for Trudax's Reddit Scraper family. It is opt-in,
 * source-labeled, and intentionally not a production Reddit API provider.
 */
export class ApifyRedditTestProvider implements RedditProvider {
  readonly name = "apify-reddit-test";
  readonly sourceMode = "apify-test" as const;
  private readonly actorId: string;
  private readonly token: string;
  private readonly maximumItems: number;
  private readonly enrichmentLimit: number;
  private readonly enrichmentComments: number;
  private readonly timeoutMs: number;
  private readonly timeRange: ApifySearchActorInput["time"];
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    actorId: string;
    token: string;
    maximumItems?: number;
    enrichmentLimit?: number;
    enrichmentComments?: number;
    timeoutMs?: number;
    timeRange?: ApifySearchActorInput["time"];
    fetchImpl?: typeof fetch;
  }) {
    this.actorId = apifyActorId(input.actorId);
    this.token = input.token.trim();
    if (!this.token) throw new Error("APIFY_TOKEN is required for the Apify Reddit test provider.");
    this.maximumItems = Math.max(1, Math.min(100, Math.trunc(input.maximumItems ?? 40)));
    this.enrichmentLimit = Math.max(1, Math.min(20, Math.trunc(input.enrichmentLimit ?? 8)));
    this.enrichmentComments = Math.max(0, Math.min(20, Math.trunc(input.enrichmentComments ?? 6)));
    this.timeoutMs = Math.max(20_000, Math.min(290_000, Math.trunc(input.timeoutMs ?? 260_000)));
    this.timeRange = input.timeRange ?? "month";
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async runActor(actorInput: ApifyRedditActorInput): Promise<unknown[]> {
    const endpoint = new URL(
      `/v2/acts/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items`,
      "https://api.apify.com",
    );
    endpoint.searchParams.set("clean", "true");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("timeout", String(Math.floor(this.timeoutMs / 1_000)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("The Apify Reddit test run timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > 5_000_000) {
      throw new Error("The Apify Reddit test response exceeded the size limit.");
    }
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > 5_000_000) {
      throw new Error("The Apify Reddit test response exceeded the size limit.");
    }
    if (!response.ok) {
      throw new Error(`Apify Reddit test request failed with HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("The Apify Reddit test provider returned invalid JSON.");
    }
    if (!Array.isArray(payload)) {
      throw new Error("The Apify Reddit test provider returned an invalid dataset.");
    }
    return payload;
  }

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const searches = buildApifyRedditSearches(request);
    if (searches.length === 0) {
      throw new Error("The business profile did not produce any usable Reddit search terms.");
    }
    const maxItems = Math.min(
      this.maximumItems,
      Math.max(8, Math.min(100, request.limit * 2)),
    );
    const subreddit =
      request.subreddits?.length === 1
        ? request.subreddits[0]?.replace(/^r\//i, "").trim()
        : undefined;
    const postsPerSearch = Math.max(2, Math.ceil(maxItems / searches.length));
    const discoveryInput: ApifySearchActorInput = {
      searches,
      ignoreStartUrls: true,
      skipComments: true,
      skipUserPosts: true,
      skipCommunity: true,
      includeMediaLinks: false,
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      sort: "relevance",
      time: this.timeRange,
      includeNSFW: false,
      maxItems,
      maxPostCount: postsPerSearch,
      maxComments: 0,
      maxCommunitiesCount: 0,
      maxUserCount: 0,
      scrollTimeout: 20,
      navigationTimeout: 30,
      debugMode: false,
      proxy: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
      },
      ...(subreddit && /^[A-Za-z0-9_]{1,32}$/.test(subreddit)
        ? { searchCommunityName: subreddit }
        : {}),
      ...(request.since && Number.isFinite(Date.parse(request.since))
        ? {
            postDateLimit: request.since,
            commentDateLimit: request.since,
          }
        : {}),
    };
    const discoveryPayload = await this.runActor(discoveryInput);
    const discovered = discoveryPayload.flatMap((item) => {
      const candidate = apifyCandidate(item, searches);
      return candidate ? [candidate] : [];
    });
    const relevant = discovered
      .filter((candidate) => isApifyCandidateRelevant(candidate, request))
      .sort(
        (left, right) =>
          candidateDiscoveryScore(right, request) - candidateDiscoveryScore(left, request),
      );
    const uniqueCandidates: ApifyCandidate[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const candidate of relevant) {
      const key = `${candidate.kind}:${candidate.externalId}:${candidate.permalink}`;
      if (seenCandidateKeys.has(key)) continue;
      seenCandidateKeys.add(key);
      uniqueCandidates.push(candidate);
    }

    const selectedCandidates = uniqueCandidates.slice(
      0,
      Math.min(this.enrichmentLimit, request.limit),
    );
    let enrichmentPayload: unknown[] = [];
    let enrichmentFailed = false;
    if (selectedCandidates.length > 0) {
      const enrichmentInput: ApifyEnrichmentActorInput = {
        startUrls: selectedCandidates.map((candidate) => ({ url: candidate.permalink })),
        skipComments: false,
        skipUserPosts: true,
        skipCommunity: true,
        includeMediaLinks: true,
        includeNSFW: false,
        maxItems: Math.min(
          100,
          selectedCandidates.length * (this.enrichmentComments + 1),
        ),
        maxPostCount: selectedCandidates.length,
        maxComments: this.enrichmentComments,
        maxCommunitiesCount: 0,
        maxUserCount: 0,
        scrollTimeout: 20,
        navigationTimeout: 30,
        debugMode: false,
        proxy: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
        },
      };
      try {
        enrichmentPayload = await this.runActor(enrichmentInput);
      } catch (error) {
        enrichmentFailed = true;
        console.error("Apify Reddit thread enrichment failed; using complete discovery records", error);
      }
    }

    const validSince = request.since && Number.isFinite(Date.parse(request.since))
      ? Date.parse(request.since)
      : undefined;
    let enrichmentFallbacks = 0;
    let enrichedConversations = 0;
    let missingVerifiedTimestamps = 0;
    const seen = new Set<string>();
    const conversations = selectedCandidates.flatMap((candidate) => {
      const enriched = enrichmentFailed
        ? undefined
        : enrichedItemForCandidate(candidate, enrichmentPayload);
      if (!enriched) enrichmentFallbacks += 1;
      const normalized = normalizeApifyRedditItem(
        enriched ?? candidate.item,
        this.actorId,
        searches,
        {
          fallback: candidate,
          threadContext: enrichmentFailed
            ? ""
            : threadContextForCandidate(candidate, enrichmentPayload),
        },
      );
      if (enriched && normalized) enrichedConversations += 1;
      if (!normalized && !candidate.createdAt) missingVerifiedTimestamps += 1;
      if (
        !normalized ||
        (validSince !== undefined && Date.parse(normalized.createdAt) < validSince) ||
        seen.has(normalized.externalId)
      ) return [];
      seen.add(normalized.externalId);
      return [normalized];
    });
    return {
      conversations,
      sourceMode: "apify-test",
      diagnostics: {
        queryCount: searches.length,
        fetchedCandidates: discoveryPayload.length,
        normalizedCandidates: discovered.length,
        locallyMatchedCandidates: uniqueCandidates.length,
        enrichmentAttempts: selectedCandidates.length,
        enrichedConversations,
        verifiedRecentConversations: conversations.length,
        missingVerifiedTimestamps,
        rejectedCandidates: Math.max(0, discoveryPayload.length - uniqueCandidates.length),
        enrichmentFallbacks,
      },
    };
  }
}

function normalizedConversation(
  value: ApprovedProviderConversation,
  providerName: string,
): RedditConversation {
  const externalId = typeof value.externalId === "string" ? value.externalId.trim() : "";
  const subreddit = typeof value.subreddit === "string" ? value.subreddit.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (!externalId || !subreddit || !body || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("The approved provider returned an incomplete Reddit conversation.");
  }
  const kind = value.kind === "comment" ? "comment" : "post";
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
  const author = typeof value.author === "string" && value.author.trim() ? value.author.trim() : undefined;
  const score = Number(value.score);
  const comments = Number(value.comments);
  const permalink = redditPermalink(value.permalink);
  const observedAt = new Date().toISOString();
  const hash = contentFingerprint(`${title ?? ""}\n${body}`);
  return {
    provider: providerName,
    sourceMode: "live",
    externalId,
    kind,
    subreddit: subreddit.replace(/^r\//i, ""),
    title,
    body,
    author,
    permalink,
    createdAt: new Date(createdAt).toISOString(),
    metrics: {
      score: Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0,
      comments: Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : 0,
    },
    provenance: {
      id: `reddit_${providerName}_${contentFingerprint(externalId)}`,
      kind: "reddit",
      provider: providerName,
      providerExternalId: externalId,
      url: permalink,
      title,
      excerpt: body.slice(0, 280),
      contentHash: hash,
      observedAt,
      isMock: false,
    },
  };
}

/**
 * Normalized adapter for an approved Reddit API provider. The configured
 * service must expose POST /search and return provider-authorized public Reddit
 * records; this adapter never requests or parses Reddit HTML.
 */
export class ApprovedHttpRedditProvider implements RedditProvider {
  readonly name: string;
  readonly sourceMode = "live" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    name?: string;
    fetchImpl?: typeof fetch;
  }) {
    const base = new URL(input.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error("REDDIT_API_BASE_URL must be a credential-free HTTPS URL.");
    }
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.apiKey = input.apiKey;
    this.name = input.name ?? "approved-http";
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request, limit: Math.max(1, Math.min(request.limit, 100)) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > 2_000_000) {
      throw new Error("The approved Reddit provider response exceeded the size limit.");
    }
    const raw = await response.text();
    if (raw.length > 2_000_000) {
      throw new Error("The approved Reddit provider response exceeded the size limit.");
    }
    if (!response.ok) {
      throw new Error(`Approved Reddit provider request failed with HTTP ${response.status}.`);
    }
    const payload = JSON.parse(raw) as ApprovedProviderResponse;
    if (!Array.isArray(payload.conversations)) {
      throw new Error("The approved Reddit provider returned an invalid response.");
    }
    const conversations = payload.conversations.map((value) =>
      normalizedConversation(value as ApprovedProviderConversation, this.name),
    );
    return {
      conversations,
      nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : undefined,
      sourceMode: "live",
    };
  }
}

/**
 * Provider selection is deliberately explicit. Missing production credentials
 * never masquerade as live Reddit data: development must opt into `mock` and
 * production adapters must be registered by name.
 */
export function createRedditProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  liveProviders: Readonly<Record<string, RedditProvider>> = {},
): RedditProvider {
  const selected =
    env.REDDIT_PROVIDER?.trim().toLocaleLowerCase("en-US") ||
    (isProductionRuntime(env) ? "" : "mock");
  if (!selected) {
    throw new Error(
      "REDDIT_PROVIDER must explicitly select `mock`, `apify-test`, or an approved live provider.",
    );
  }
  if (selected === "mock") return new MockRedditProvider();
  if (selected === "apify-test" || selected === "apify") {
    if (env.APIFY_REDDIT_TEST_MODE?.trim().toLowerCase() !== "true") {
      throw new Error(
        "The Apify Reddit scraper is test-only. Set APIFY_REDDIT_TEST_MODE=true to opt in explicitly.",
      );
    }
    const allowedTimeRanges = new Set(["day", "week", "month", "year", "all"] as const);
    const configuredTimeRange = env.APIFY_REDDIT_TIME_RANGE?.trim().toLowerCase() || "month";
    if (!allowedTimeRanges.has(configuredTimeRange as "day" | "week" | "month" | "year" | "all")) {
      throw new Error("APIFY_REDDIT_TIME_RANGE must be day, week, month, year, or all.");
    }
    return new ApifyRedditTestProvider({
      actorId: required(env.APIFY_REDDIT_ACTOR_ID, "APIFY_REDDIT_ACTOR_ID"),
      token: required(env.APIFY_TOKEN, "APIFY_TOKEN"),
      maximumItems: positiveInteger(env.APIFY_REDDIT_MAX_RESULTS, 40, 1, 100),
      enrichmentLimit: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_LIMIT, 8, 1, 20),
      enrichmentComments: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_COMMENTS, 6, 0, 20),
      timeoutMs: positiveInteger(env.APIFY_REDDIT_TIMEOUT_MS, 260_000, 20_000, 290_000),
      timeRange: configuredTimeRange as "day" | "week" | "month" | "year" | "all",
    });
  }
  if (selected === "approved-http") {
    return new ApprovedHttpRedditProvider({
      baseUrl: required(env.REDDIT_API_BASE_URL, "REDDIT_API_BASE_URL"),
      apiKey: required(env.REDDIT_API_KEY, "REDDIT_API_KEY"),
    });
  }

  const provider = liveProviders[selected];
  if (!provider) {
    throw new Error(`The configured Reddit provider ${selected} is not registered.`);
  }
  if (provider.sourceMode !== "live") {
    throw new Error(`The configured provider ${selected} is not a live Reddit API provider.`);
  }
  return provider;
}
