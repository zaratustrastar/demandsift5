import { MockRedditProvider } from "@/lib/providers/mock-reddit";
import {
  contentFingerprint,
  isUsefulSearchPhrase,
  normalizeSearchText,
} from "@/lib/intelligence/opportunity-ranking";
import type {
  ProviderRejectionReason,
  RedditDiscoveryDiagnostics,
  RedditDiscoveryResponse,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchPlanEntry,
  RedditSearchRequest,
  RedditSearchResponse,
} from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";
import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditConversation,
  RedditDiscoveryCandidate,
  RedditSearchLane,
  RedditStructuredContext,
} from "@/lib/domain/types";

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

type ApifyCandidate = RedditDiscoveryCandidate & { item: ApifyRedditItem };

type CandidateParseResult =
  | { candidate: ApifyCandidate; reason?: never }
  | { candidate?: never; reason: ProviderRejectionReason };

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
  return withoutControls.replace(/\s+/g, " ").trim().slice(0, 120);
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

function usefulShortPhrase(value: string, maximumWords = 8): boolean {
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

const PROBLEM_TOKEN_STOP_WORDS = new Set([
  "about", "across", "and", "are", "can", "for", "from", "have", "into", "our", "that",
  "the", "their", "this", "too", "using", "with", "without", "your",
]);

function problemTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !PROBLEM_TOKEN_STOP_WORDS.has(token))
    .slice(0, 4);
}

function problemPainExpression(value: string): string {
  const tokens = problemTokens(value);
  if (tokens.length < 2) return "";
  return `(${tokens.join(" AND ")}) AND (problem OR struggling OR manual OR spreadsheet OR nightmare OR difficult OR help OR solution)`;
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

function boundedPlanEntry(
  lane: RedditSearchLane,
  query: string,
  seed?: string,
): RedditSearchPlanEntry | null {
  const cleaned = query.replace(/\s+/g, " ").trim().slice(0, 300);
  return cleaned.length >= 2 ? { lane, query: cleaned, ...(seed ? { seed } : {}) } : null;
}

/**
 * Build explicit retrieval lanes. AI supplies semantic seeds in the company
 * context pack; Reddit/Apify syntax remains deterministic and bounded.
 */
export function buildApifyRedditSearchPlan(request: RedditSearchRequest): RedditSearchPlanEntry[] {
  const productTerms = request.queries.productTerms
    .map(cleanSearchTerm)
    .filter(isUsefulSearchPhrase);
  const brandTerms = (request.queries.brandTerms?.length
    ? request.queries.brandTerms
    : productTerms.slice(0, 1))
    .map(cleanSearchTerm)
    .filter(isUsefulSearchPhrase);
  const categories = (request.queries.productCategories ?? [])
    .map(cleanSearchTerm)
    .filter((term) => usefulShortPhrase(term, 6));
  const problems = request.queries.customerProblems
    .map(cleanSearchTerm)
    .filter((term) => usefulShortPhrase(term, 8));
  const competitors = request.queries.competitors
    .map(cleanSearchTerm)
    .filter(isUsefulSearchPhrase);

  const category = redditSearchAtom(categories[0] ?? productTerms[1] ?? "");
  const brand = redditSearchAtom(brandTerms[0] ?? productTerms[0] ?? "");
  const entries: Array<RedditSearchPlanEntry | null> = [];

  if (category) {
    entries.push(
      boundedPlanEntry(
        "direct_buying_intent",
        `${category} AND ("looking for" OR "need a" OR "which tool" OR "what are you using" OR "recommend a")`,
        categories[0],
      ),
      boundedPlanEntry(
        "category_recommendation",
        `${category} AND (recommendations OR recommend OR alternatives OR options OR compare)`,
        categories[0],
      ),
    );
  }

  for (const problem of problems.slice(0, 4)) {
    const expression = problemPainExpression(problem);
    if (expression) {
      entries.push(boundedPlanEntry("problem_pain", expression, problem));
    }
  }

  for (const competitorName of competitors.slice(0, 3)) {
    const competitor = redditSearchAtom(competitorName);
    if (!competitor) continue;
    entries.push(
      boundedPlanEntry(
        "competitor_switching",
        `${competitor} AND (alternative OR switching OR replace OR frustrated OR expensive OR overkill OR problem OR issue)`,
        competitorName,
      ),
      boundedPlanEntry(
        "brand_competitor_mentions",
        `${competitor} AND (problem OR issue OR pricing OR missing OR difficult OR comparison)`,
        competitorName,
      ),
    );
  }

  if (brand) {
    entries.push(
      boundedPlanEntry(
        "brand_competitor_mentions",
        `${brand} AND (alternative OR switching OR frustrated OR problem OR issue OR pricing OR recommend)`,
        brandTerms[0] ?? productTerms[0],
      ),
    );
  }

  const seen = new Set<string>();
  const deduped = entries.flatMap((entry) => {
    if (!entry) return [];
    const key = `${entry.lane}:${entry.query.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [entry];
  });

  const lanes = new Set(deduped.map((entry) => entry.lane));
  if (!lanes.has("problem_pain") && category) {
    const fallback = boundedPlanEntry(
      "problem_pain",
      `${category} AND (struggling OR manual OR spreadsheet OR nightmare OR problem OR issue OR help)`,
      categories[0],
    );
    if (fallback) deduped.push(fallback);
  }
  if (!lanes.has("direct_buying_intent") && brand) {
    const fallback = boundedPlanEntry(
      "direct_buying_intent",
      `${brand} AND ("looking for" OR "need a" OR recommend OR alternative)`,
      brandTerms[0],
    );
    if (fallback) deduped.push(fallback);
  }

  return deduped.slice(0, 12);
}

/** Compatibility helper for tests/callers that only need query strings. */
export function buildApifyRedditSearches(request: RedditSearchRequest): string[] {
  return buildApifyRedditSearchPlan(request).map((entry) => entry.query);
}

function searchPlanMatches(
  title: string | undefined,
  body: string,
  plan: readonly RedditSearchPlanEntry[],
): RedditSearchPlanEntry[] {
  const text = normalizeSearchText(`${title ?? ""}\n${body}`);
  const scored = plan.flatMap((entry) => {
    const quoted = [...entry.query.matchAll(/"([^"]+)"/g)]
      .map((match) => normalizeSearchText(match[1] ?? ""))
      .filter(Boolean);
    const terms = normalizeSearchText(entry.query.replace(/\b(?:AND|OR|NOT)\b/gi, " "))
      .split(" ")
      .filter((term) => term.length >= 4 && !PROBLEM_TOKEN_STOP_WORDS.has(term));
    const quotedMatches = quoted.filter((phrase) => text.includes(phrase)).length;
    const tokenMatches = terms.filter((term) => text.includes(term)).length;
    const score = quotedMatches * 3 + tokenMatches;
    return score >= 2 ? [{ entry, score }] : [];
  });
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((row) => row.score));
  return scored.filter((row) => row.score >= Math.max(2, best - 2)).map((row) => row.entry);
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

function candidateFromApify(
  value: unknown,
  plan: readonly RedditSearchPlanEntry[] = [],
): CandidateParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "invalid_record" };
  }
  const item = value as ApifyRedditItem;
  const dataType = stringValue(item.dataType, 20).toLowerCase();
  if (dataType !== "post" && dataType !== "comment") return { reason: "invalid_record" };
  if (item.isAd === true) return { reason: "invalid_record" };
  if (item.over18 === true) return { reason: "nsfw" };

  const title = cleanRedditText(item.title, 500) || undefined;
  const body = cleanRedditText(item.body) || title || "";
  const permalink = safeRedditPermalink(item.url);
  if (!permalink) return { reason: "invalid_url" };
  const subreddit = subredditFromItem(item, permalink);
  if (!body || !subreddit) return { reason: "invalid_record" };

  const author = cleanRedditText(item.username, 100) || undefined;
  if (author && automatedAuthor(author)) return { reason: "bot_author" };
  if (/^\[(?:deleted|removed)\]$/i.test(body)) return { reason: "deleted" };

  const rawCreatedAt = stringValue(item.createdAt, 80);
  const parsedCreatedAt = Date.parse(rawCreatedAt);
  if (!Number.isFinite(parsedCreatedAt)) return { reason: "missing_timestamp" };

  const externalId =
    stringValue(item.parsedId, 200) ||
    stringValue(item.id, 200).replace(/^t[13]_/i, "") ||
    `derived_${contentFingerprint(`${permalink}\n${body}`)}`;
  const matches = searchPlanMatches(title, body, plan);
  const matchedQueries = [...new Set(matches.map((entry) => entry.query))];
  const discoveryLanes = [...new Set(matches.map((entry) => entry.lane))];
  const provider = "apify-test";
  const observedAt = new Date().toISOString();

  return {
    candidate: {
      item,
      provider,
      sourceMode: "apify-test",
      externalId,
      kind: dataType,
      parentExternalId: stringValue(item.parentId, 200) || stringValue(item.postId, 200) || undefined,
      subreddit,
      title,
      body,
      author,
      permalink,
      createdAt: new Date(parsedCreatedAt).toISOString(),
      metrics: {
        score: nonNegativeInteger(item.upVotes),
        comments: dataType === "comment"
          ? nonNegativeInteger(item.numberOfReplies)
          : nonNegativeInteger(item.numberOfComments),
      },
      matchedQuery: matchedQueries[0],
      matchedQueries,
      discoveryLanes,
      provenance: {
        id: `reddit_apify_${contentFingerprint(externalId)}`,
        kind: "reddit",
        provider,
        providerExternalId: externalId,
        url: permalink,
        title,
        excerpt: body.slice(0, 280),
        contentHash: contentFingerprint(`${title ?? ""}\n${body}`),
        observedAt,
        isMock: false,
        metadata: {
          testOnly: true,
          acquisitionMethod: "web-scraping",
        },
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

function rawExternalId(item: ApifyRedditItem): string {
  return stringValue(item.parsedId, 200) || stringValue(item.id, 200).replace(/^t[13]_/i, "");
}

function contextMessage(value: unknown): RedditContextMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as ApifyRedditItem;
  const dataType = stringValue(item.dataType, 20).toLowerCase();
  if (dataType !== "post" && dataType !== "comment") return null;
  if (item.isAd === true || item.over18 === true) return null;
  const body = cleanRedditText(item.body) || cleanRedditText(item.title, 500);
  const externalId = rawExternalId(item);
  if (!body || !externalId || /^\[(?:deleted|removed)\]$/i.test(body)) return null;
  const createdAtRaw = stringValue(item.createdAt, 80);
  const createdAtMs = Date.parse(createdAtRaw);
  return {
    externalId,
    kind: dataType,
    author: cleanRedditText(item.username, 100) || undefined,
    body,
    parentExternalId: stringValue(item.parentId, 200) || stringValue(item.postId, 200) || undefined,
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : undefined,
  };
}

function postIdForItem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as ApifyRedditItem;
  const direct = stringValue(item.postId, 200).replace(/^t3_/i, "");
  if (direct) return direct.toLowerCase();
  const permalink = safeRedditPermalink(item.url);
  return permalink ? redditPostIdFromPermalink(permalink) : undefined;
}

function structuredContextForCandidate(
  candidate: RedditDiscoveryCandidate,
  payload: readonly unknown[],
): RedditStructuredContext {
  const postId = candidate.permalink ? redditPostIdFromPermalink(candidate.permalink) : undefined;
  const messages = payload.flatMap((value) => {
    const message = contextMessage(value);
    if (!message || (postId && postIdForItem(value) !== postId)) return [];
    return [{ value, message }];
  });
  const byId = new Map(messages.map((row) => [row.message.externalId.replace(/^t[13]_/i, ""), row.message]));
  const matched = byId.get(candidate.externalId.replace(/^t[13]_/i, "")) ?? {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  const originalPost = messages.find((row) => row.message.kind === "post")?.message ??
    (candidate.kind === "post" ? matched : undefined);

  const parentChain: RedditContextMessage[] = [];
  let parentId = matched.parentExternalId?.replace(/^t[13]_/i, "");
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId) && parentChain.length < 6) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parentChain.unshift(parent);
    parentId = parent.parentExternalId?.replace(/^t[13]_/i, "");
  }

  const replies = messages
    .map((row) => row.message)
    .filter((message) =>
      message.kind === "comment" &&
      message.parentExternalId?.replace(/^t[13]_/i, "") === candidate.externalId.replace(/^t[13]_/i, ""),
    )
    .slice(0, 6);
  const used = new Set([
    matched.externalId,
    ...parentChain.map((message) => message.externalId),
    ...replies.map((message) => message.externalId),
    ...(originalPost ? [originalPost.externalId] : []),
  ]);
  const surroundingComments = messages
    .map((row) => row.message)
    .filter((message) => message.kind === "comment" && !used.has(message.externalId))
    .slice(0, 6);

  return { originalPost, matched, parentChain, replies, surroundingComments };
}

function flattenStructuredContext(context: RedditStructuredContext): string {
  const sections: string[] = [];
  if (context.originalPost && context.originalPost.externalId !== context.matched.externalId) {
    sections.push(`Original post${context.originalPost.author ? ` by ${context.originalPost.author}` : ""}: ${context.originalPost.body}`);
  }
  if (context.parentChain.length > 0) {
    sections.push(`Parent chain:\n${context.parentChain.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  if (context.replies.length > 0) {
    sections.push(`Replies:\n${context.replies.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  if (context.surroundingComments.length > 0) {
    sections.push(`Other comments:\n${context.surroundingComments.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  return sections.join("\n\n").slice(0, 8_000);
}

function enrichedItemForCandidate(
  candidate: RedditDiscoveryCandidate,
  payload: readonly unknown[],
): unknown | undefined {
  const postId = candidate.permalink ? redditPostIdFromPermalink(candidate.permalink) : undefined;
  return payload.find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as ApifyRedditItem;
    const dataType = stringValue(item.dataType, 20).toLowerCase();
    if (dataType !== candidate.kind) return false;
    const itemId = rawExternalId(item).replace(/^t[13]_/i, "");
    if (itemId && itemId === candidate.externalId.replace(/^t[13]_/i, "")) return true;
    const permalink = safeRedditPermalink(item.url);
    return candidate.kind === "post" && Boolean(postId && permalink && redditPostIdFromPermalink(permalink) === postId);
  });
}

function enrichedConversation(
  candidate: RedditDiscoveryCandidate,
  enrichedValue: unknown,
  payload: readonly unknown[],
  provider: string,
): EnrichedRedditConversation | null {
  if (!enrichedValue || typeof enrichedValue !== "object" || Array.isArray(enrichedValue)) return null;
  const item = enrichedValue as ApifyRedditItem;
  const context = structuredContextForCandidate(candidate, payload);
  const threadContext = flattenStructuredContext(context);
  const contentHash = contentFingerprint(
    `${candidate.title ?? ""}\n${candidate.body}\n${JSON.stringify(context)}`,
  );
  return {
    provider,
    sourceMode: candidate.sourceMode,
    externalId: candidate.externalId,
    kind: candidate.kind,
    parentExternalId: stringValue(item.parentId, 200) || candidate.parentExternalId,
    subreddit: candidate.subreddit,
    title: cleanRedditText(item.title, 500) || candidate.title,
    body: cleanRedditText(item.body) || candidate.body,
    threadContext: threadContext || undefined,
    structuredContext: context,
    author: cleanRedditText(item.username, 100) || candidate.author,
    permalink: candidate.permalink,
    createdAt: candidate.createdAt,
    metrics: {
      score: nonNegativeInteger(item.upVotes) || candidate.metrics.score,
      comments: candidate.kind === "comment"
        ? nonNegativeInteger(item.numberOfReplies) || candidate.metrics.comments
        : nonNegativeInteger(item.numberOfComments) || candidate.metrics.comments,
    },
    matchedQuery: candidate.matchedQuery,
    matchedQueries: candidate.matchedQueries,
    discoveryLanes: candidate.discoveryLanes,
    provenance: {
      ...candidate.provenance,
      provider,
      contentHash,
      observedAt: new Date().toISOString(),
      metadata: {
        ...(candidate.provenance.metadata ?? {}),
        enriched: true,
      },
    },
  };
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

function emptyProviderRejections(): Record<ProviderRejectionReason, number> {
  return {
    invalid_record: 0,
    invalid_url: 0,
    bot_author: 0,
    deleted: 0,
    nsfw: 0,
    missing_timestamp: 0,
    outside_window: 0,
  };
}

/**
 * Real-data MVP test adapter for Trudax's Reddit Scraper family. Discovery and
 * enrichment are intentionally separate; the scan workflow owns the budget.
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
    this.maximumItems = Math.max(1, Math.min(100, Math.trunc(input.maximumItems ?? 50)));
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
      if (controller.signal.aborted) throw new Error("The Apify Reddit test run timed out.");
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

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const searchPlan = buildApifyRedditSearchPlan(request);
    if (searchPlan.length === 0) {
      throw new Error("The company context did not produce any usable Reddit search lanes.");
    }
    const searches = searchPlan.map((entry) => entry.query);
    const maxItems = Math.min(
      this.maximumItems,
      Math.max(30, Math.min(100, request.limit * 2)),
    );
    const subreddit = request.subreddits?.length === 1
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
        ? { postDateLimit: request.since, commentDateLimit: request.since }
        : {}),
    };

    const payload = await this.runActor(discoveryInput);
    const rejectedByReason = emptyProviderRejections();
    const sinceMs = request.since && Number.isFinite(Date.parse(request.since))
      ? Date.parse(request.since)
      : null;
    const parsed: ApifyCandidate[] = [];
    for (const value of payload) {
      const result = candidateFromApify(value, searchPlan);
      if (!result.candidate) {
        rejectedByReason[result.reason] += 1;
        continue;
      }
      if (sinceMs !== null && Date.parse(result.candidate.createdAt) < sinceMs) {
        rejectedByReason.outside_window += 1;
        continue;
      }
      parsed.push(result.candidate);
    }

    const byKey = new Map<string, ApifyCandidate>();
    for (const candidate of parsed) {
      const key = `${candidate.kind}:${candidate.externalId}`;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, candidate);
        continue;
      }
      byKey.set(key, {
        ...current,
        matchedQuery: current.matchedQuery ?? candidate.matchedQuery,
        matchedQueries: [...new Set([...current.matchedQueries, ...candidate.matchedQueries])],
        discoveryLanes: [...new Set([...current.discoveryLanes, ...candidate.discoveryLanes])],
      });
    }

    const candidates = [...byKey.values()].slice(0, maxItems).map(({ item: _item, ...candidate }) => candidate);
    const laneQueryCounts: Partial<Record<RedditSearchLane, number>> = {};
    for (const entry of searchPlan) laneQueryCounts[entry.lane] = (laneQueryCounts[entry.lane] ?? 0) + 1;
    const diagnostics: RedditDiscoveryDiagnostics = {
      queryCount: searchPlan.length,
      fetchedCandidates: payload.length,
      normalizedCandidates: parsed.length,
      verifiedRecentCandidates: candidates.length,
      rejectedByReason,
      laneQueryCounts,
    };
    return { candidates, searchPlan, sourceMode: this.sourceMode, diagnostics };
  }

  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const candidates = request.candidates.slice(0, this.enrichmentLimit);
    if (candidates.length === 0) {
      return {
        conversations: [],
        sourceMode: this.sourceMode,
        diagnostics: { requested: 0, enriched: 0, failed: 0, fallbackUsed: 0 },
      };
    }
    const maxComments = Math.max(
      0,
      Math.min(request.maxComments ?? this.enrichmentComments, 20),
    );
    const input: ApifyEnrichmentActorInput = {
      startUrls: candidates.flatMap((candidate) => candidate.permalink ? [{ url: candidate.permalink }] : []),
      skipComments: false,
      skipUserPosts: true,
      skipCommunity: true,
      includeMediaLinks: true,
      includeNSFW: false,
      maxItems: Math.min(100, candidates.length * (maxComments + 1)),
      maxPostCount: candidates.length,
      maxComments,
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

    let payload: unknown[];
    try {
      payload = await this.runActor(input);
    } catch (error) {
      console.error("Apify Reddit thread enrichment failed", error);
      return {
        conversations: [],
        sourceMode: this.sourceMode,
        diagnostics: {
          requested: candidates.length,
          enriched: 0,
          failed: candidates.length,
          fallbackUsed: 0,
        },
      };
    }

    let failed = 0;
    const conversations = candidates.flatMap((candidate) => {
      const enriched = enrichedItemForCandidate(candidate, payload);
      if (!enriched) {
        failed += 1;
        return [];
      }
      const conversation = enrichedConversation(candidate, enriched, payload, `apify:${this.actorId}`);
      if (!conversation) {
        failed += 1;
        return [];
      }
      return [conversation];
    });
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: candidates.length,
        enriched: conversations.length,
        failed,
        fallbackUsed: 0,
      },
    };
  }

  /** Deprecated compatibility path. The active scan uses discover -> AI -> enrich. */
  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const discovery = await this.discover(request);
    const selected = discovery.candidates.slice(0, Math.min(this.enrichmentLimit, request.limit));
    const enrichment = await this.enrich({ candidates: selected });
    return {
      conversations: enrichment.conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: discovery.diagnostics.queryCount,
        fetchedCandidates: discovery.diagnostics.fetchedCandidates,
        normalizedCandidates: discovery.diagnostics.normalizedCandidates,
        locallyMatchedCandidates: discovery.candidates.length,
        enrichmentAttempts: enrichment.diagnostics.requested,
        enrichedConversations: enrichment.diagnostics.enriched,
        verifiedRecentConversations: enrichment.conversations.length,
        missingVerifiedTimestamps: discovery.diagnostics.rejectedByReason.missing_timestamp,
        rejectedCandidates: Object.values(discovery.diagnostics.rejectedByReason).reduce((sum, count) => sum + count, 0),
        enrichmentFallbacks: enrichment.diagnostics.fallbackUsed,
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
    matchedQueries: [],
    discoveryLanes: [],
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

function discoveryCandidateFromConversation(conversation: RedditConversation): RedditDiscoveryCandidate {
  return {
    provider: conversation.provider,
    sourceMode: conversation.sourceMode,
    externalId: conversation.externalId,
    kind: conversation.kind,
    parentExternalId: conversation.parentExternalId,
    subreddit: conversation.subreddit,
    title: conversation.title,
    body: conversation.body,
    author: conversation.author,
    permalink: conversation.permalink,
    createdAt: conversation.createdAt,
    metrics: conversation.metrics,
    matchedQuery: conversation.matchedQuery,
    matchedQueries: conversation.matchedQueries ?? (conversation.matchedQuery ? [conversation.matchedQuery] : []),
    discoveryLanes: conversation.discoveryLanes ?? [],
    provenance: conversation.provenance,
  };
}

function matchedOnlyEnriched(candidate: RedditDiscoveryCandidate): EnrichedRedditConversation {
  const matched: RedditContextMessage = {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  return {
    ...candidate,
    structuredContext: {
      originalPost: candidate.kind === "post" ? matched : undefined,
      matched,
      parentChain: [],
      replies: [],
      surroundingComments: [],
    },
  };
}

/**
 * Normalized adapter for an approved Reddit API provider. Discovery uses its
 * existing /search contract. Until an approved provider exposes a thread API,
 * enrichment preserves the matched record as structured context without
 * inventing surrounding comments.
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

  private async rawSearch(request: RedditSearchRequest): Promise<{ conversations: RedditConversation[]; nextCursor?: string }> {
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
    if (raw.length > 2_000_000) throw new Error("The approved Reddit provider response exceeded the size limit.");
    if (!response.ok) throw new Error(`Approved Reddit provider request failed with HTTP ${response.status}.`);
    const payload = JSON.parse(raw) as ApprovedProviderResponse;
    if (!Array.isArray(payload.conversations)) {
      throw new Error("The approved Reddit provider returned an invalid response.");
    }
    return {
      conversations: payload.conversations.map((value) =>
        normalizedConversation(value as ApprovedProviderConversation, this.name),
      ),
      nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : undefined,
    };
  }

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const raw = await this.rawSearch(request);
    const candidates = raw.conversations.map(discoveryCandidateFromConversation);
    return {
      candidates,
      nextCursor: raw.nextCursor,
      searchPlan: [],
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: 0,
        fetchedCandidates: candidates.length,
        normalizedCandidates: candidates.length,
        verifiedRecentCandidates: candidates.length,
        rejectedByReason: emptyProviderRejections(),
        laneQueryCounts: {},
      },
    };
  }

  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const conversations = request.candidates.map(matchedOnlyEnriched);
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: request.candidates.length,
        enriched: conversations.length,
        failed: 0,
        fallbackUsed: conversations.length,
      },
    };
  }

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const discovery = await this.discover(request);
    return {
      conversations: discovery.candidates.map(matchedOnlyEnriched),
      nextCursor: discovery.nextCursor,
      sourceMode: this.sourceMode,
    };
  }
}

/** Provider selection is deliberately explicit; missing credentials never masquerade as live data. */
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
      maximumItems: positiveInteger(env.APIFY_REDDIT_MAX_RESULTS, 50, 1, 100),
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
  if (!provider) throw new Error(`The configured Reddit provider ${selected} is not registered.`);
  if (provider.sourceMode !== "live") {
    throw new Error(`The configured provider ${selected} is not a live Reddit API provider.`);
  }
  return provider;
}
