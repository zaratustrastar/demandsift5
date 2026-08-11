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
  searchComments: false;
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

/**
 * Trudax charges for at least ten initialized items and rejects smaller
 * maxItems values even when a startUrls run only opens one selected thread.
 */
export const APIFY_REDDIT_ENRICHMENT_MIN_ITEMS = 10;

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
 * Build a bounded high-recall search plan around observable demand signals.
 *
 * The website/AI layer supplies grounded search hypotheses. This layer keeps
 * Reddit syntax deterministic and deliberately avoids over-constraining those
 * hypotheses with extra "pain words".
 */
export function buildApifyRedditSearchPlan(request: RedditSearchRequest): RedditSearchPlanEntry[] {
  type DemandLane =
    | "direct_buying_intent"
    | "problem_pain"
    | "competitor_switching"
    | "category_recommendation"
    | "brand_competitor_mentions"
    | "workaround"
    | "timing";

  const cleanUnique = (values: readonly string[], maximumWords: number): string[] => {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      const cleaned = cleanSearchTerm(value);
      if (!usefulShortPhrase(cleaned, maximumWords)) return [];
      const key = normalizeSearchText(cleaned);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [cleaned];
    });
  };

  /*
   * For a natural manifestation such as "files buried in email", using every
   * word is brittle. First + last normally retain the concrete objects while
   * allowing wording between them to vary.
   */
  const manifestationExpression = (value: string): string => {
    const rawTokens = problemTokens(value).slice(0, 4);
    const filler = new Set([
      "buried",
      "missed",
      "missing",
      "unclear",
      "scattered",
      "everywhere",
      "many",
    ]);

    const meaningful = rawTokens.filter((token) => !filler.has(token));
    const tokens = meaningful.length > 0 ? meaningful : rawTokens;

    if (tokens.length === 0) return "";
    if (tokens.length === 1) return tokens[0] ?? "";
    if (tokens.length === 2) return tokens.join(" ");
    return `${tokens[0]} ${tokens[tokens.length - 1]}`;
  };

  const categoryExpression = (value: string): string => {
    const tokens = problemTokens(value).slice(0, 2);
    if (tokens.length === 0) return "";
    return tokens.join(" ");
  };

  const triggerExpression = (value: string): string => {
    const tokens = problemTokens(value).slice(0, 2);
    if (tokens.length === 0) return "";
    return tokens.join(" ");
  };

  const contextOrExpression = (value: string): string => {
    const generic = new Set([
      "keep", "keeping", "manage", "managing", "organize", "organized",
      "organizing", "coordinate", "coordinating", "use", "using",
      "help", "helps", "solve", "solves", "make", "makes",
    ]);
    const tokens = problemTokens(value)
      .filter((token) => !generic.has(token))
      .slice(0, 2);

    if (tokens.length === 0) return "";
    return tokens.join(" ");
  };

  const productTerms = cleanUnique(request.queries.productTerms, 8);
  const categories = cleanUnique(request.queries.productCategories ?? [], 6);
  const problems = cleanUnique(request.queries.customerProblems, 8);
  const jobs = cleanUnique(request.queries.jobsToBeDone ?? [], 10);
  const workarounds = cleanUnique(request.queries.workarounds ?? [], 8);
  const triggers = cleanUnique(request.queries.triggerEvents ?? [], 10);
  const competitors = cleanUnique(request.queries.competitors, 6);
  const brandTerms = cleanUnique(
    request.queries.brandTerms?.length
      ? request.queries.brandTerms
      : productTerms.slice(0, 1),
    6,
  );

  const pools: Record<DemandLane, RedditSearchPlanEntry[]> = {
    direct_buying_intent: [],
    problem_pain: [],
    competitor_switching: [],
    category_recommendation: [],
    brand_competitor_mentions: [],
    workaround: [],
    timing: [],
  };

  const seenQueries = new Set<string>();

  const push = (lane: DemandLane, query: string, seed?: string) => {
    const entry = boundedPlanEntry(lane, query, seed);
    if (!entry) return;

    const key = normalizeSearchText(entry.query);
    if (!key || seenQueries.has(key)) return;

    seenQueries.add(key);
    pools[lane].push(entry);
  };

  const categorySeed =
    categories[0] ??
    productTerms.find(
      (term) =>
        normalizeSearchText(term) !== normalizeSearchText(brandTerms[0] ?? ""),
    ) ??
    productTerms[0] ??
    "";

  const contextSeed =
    categories[0] ??
    jobs[0] ??
    problems[0] ??
    productTerms[0] ??
    "";

  const context = contextOrExpression(contextSeed);

  /* Direct buying intent and category recommendations stay separate so a
   * result can be traced back to the signal we intended to retrieve. */
  const category = categoryExpression(categorySeed);
  if (category) {
    push(
      "direct_buying_intent",
      `looking for ${category}`,
      categorySeed,
    );
    push(
      "category_recommendation",
      `${category} recommendations`,
      categorySeed,
    );
  }

  for (const seed of [...problems, ...jobs].slice(0, 8)) {
    const manifestation = manifestationExpression(seed);
    if (!manifestation) continue;

    push(
      "direct_buying_intent",
      `need help ${manifestation}`,
      seed,
    );
  }

  /*
   * PAIN
   *
   * The problem manifestation itself is evidence. Do not require a second
   * generic word such as "frustrated" or "problem".
   */
  for (const seed of problems.slice(0, 8)) {
    const manifestation = manifestationExpression(seed);
    if (manifestation) push("problem_pain", manifestation, seed);
  }

  /* Competitor switching and broader competitor-frustration discussions are
   * distinct. Only website-verified competitors reach this request. */
  for (const competitorName of competitors.slice(0, 4)) {
    const competitor = cleanSearchTerm(competitorName);
    if (!competitor) continue;

    push(
      "competitor_switching",
      `${competitor} alternative`,
      competitorName,
    );
    push(
      "brand_competitor_mentions",
      `${competitor} problem`,
      competitorName,
    );
  }

  /*
   * WORKAROUNDS
   *
   * Workaround hypotheses are allowed to be broad, but connect them to a small
   * OR-context rather than requiring an entire formal JTBD phrase.
   */
  for (const seed of workarounds.slice(0, 6)) {
    const workaround = manifestationExpression(seed);
    if (!workaround) continue;

    push(
      "workaround",
      `${workaround}${context ? ` ${context}` : ""}`,
      seed,
    );
  }

  /*
   * TIMING
   *
   * Keep only the strongest part of the trigger and connect it to broad
   * business context. Do not search an AI-written sentence verbatim.
   */
  for (const seed of triggers.slice(0, 6)) {
    const trigger = triggerExpression(seed);
    if (!trigger) continue;

    push(
      "timing",
      `${trigger}${context ? ` ${context}` : ""}`,
      seed,
    );
  }

  const quotas: Array<[DemandLane, number]> = [
    ["direct_buying_intent", 1],
    ["problem_pain", 2],
    ["competitor_switching", 1],
    ["category_recommendation", 1],
    ["brand_competitor_mentions", 1],
    ["workaround", 1],
    ["timing", 1],
  ];

  const selected: RedditSearchPlanEntry[] = [];
  const selectedKeys = new Set<string>();

  const selectEntry = (entry: RedditSearchPlanEntry | undefined): boolean => {
    if (!entry) return false;
    const key = `${entry.lane}:${normalizeSearchText(entry.query)}`;
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(entry);
    return true;
  };

  for (const [lane, quota] of quotas) {
    for (const entry of pools[lane].slice(0, quota)) selectEntry(entry);
  }

  const laneOrder: DemandLane[] = [
    "direct_buying_intent",
    "problem_pain",
    "competitor_switching",
    "category_recommendation",
    "brand_competitor_mentions",
    "workaround",
    "timing",
  ];

  while (selected.length < 8) {
    let added = false;

    for (const lane of laneOrder) {
      const next = pools[lane].find((entry) => {
        const key = `${entry.lane}:${normalizeSearchText(entry.query)}`;
        return !selectedKeys.has(key);
      });

      if (selectEntry(next)) {
        added = true;
        if (selected.length >= 8) break;
      }
    }

    if (!added) break;
  }

  return selected.slice(0, 8);
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
    const seed = normalizeSearchText(entry.seed ?? "");
    if (!seed) return [];

    const seedTokens = seed
      .split(" ")
      .filter(
        (token) =>
          token.length >= 3 &&
          !PROBLEM_TOKEN_STOP_WORDS.has(token),
      )
      .slice(0, 4);

    if (seedTokens.length === 0) return [];

    let seedScore = 0;

    if (seed.length >= 4 && text.includes(seed)) {
      seedScore = seedTokens.length + 4;
    } else {
      const matched = seedTokens.filter((token) => text.includes(token)).length;
      const required = seedTokens.length <= 2 ? seedTokens.length : 2;
      if (matched < required) return [];
      seedScore = matched;
    }

    const explicitDemandSignal =
      /\b(?:looking for|need help|recommend|recommendation|alternative|which tool|what do you use)\b/.test(text);
    const categoryRecommendationSignal =
      /\b(?:recommend|recommendation|which tool|what do you use|best tool)\b/.test(text);
    const competitorSwitchingSignal =
      /\b(?:alternative|switch|switching|replace|moving away|frustrated|expensive|overkill)\b/.test(text);
    const competitorProblemSignal =
      /\b(?:problem|issue|frustrat|hate|missing|limitation|expensive|overkill)\w*\b/.test(text);

    const requiresSignal =
      entry.lane === "direct_buying_intent" ||
      entry.lane === "explicit_demand" ||
      entry.lane === "category_recommendation" ||
      entry.lane === "competitor_switching" ||
      entry.lane === "switching" ||
      entry.lane === "brand_competitor_mentions";
    const signalMatched =
      entry.lane === "direct_buying_intent" || entry.lane === "explicit_demand"
        ? explicitDemandSignal
        : entry.lane === "category_recommendation"
          ? categoryRecommendationSignal
          : entry.lane === "competitor_switching" || entry.lane === "switching"
            ? competitorSwitchingSignal
            : entry.lane === "brand_competitor_mentions"
              ? competitorProblemSignal
              : true;

    if (requiresSignal && !signalMatched) return [];

    const signalBoost =
      explicitDemandSignal &&
      (entry.lane === "direct_buying_intent" || entry.lane === "explicit_demand")
        ? 2
        : categoryRecommendationSignal && entry.lane === "category_recommendation"
          ? 2
          : competitorSwitchingSignal &&
            (entry.lane === "competitor_switching" || entry.lane === "switching")
          ? 2
          : (entry.lane === "problem_pain" || entry.lane === "pain") &&
              /\b(?:missed|buried|scattered|struggl|frustrat|messy|manual|difficult|overwhelm|nightmare)\w*\b/.test(text)
            ? 1
            : competitorProblemSignal && entry.lane === "brand_competitor_mentions"
              ? 1
            : entry.lane === "workaround" &&
                /\b(?:spreadsheet|email|manual|workaround|copy paste)\w*\b/.test(text)
              ? 1
              : entry.lane === "timing" &&
                  /\b(?:grow|grew|growth|outgrown|outgrowing|scal|more clients|new clients)\w*\b/.test(text)
                ? 1
                : 0;

    return [{ entry, score: seedScore + signalBoost }];
  });

  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((row) => row.score));
  return scored
    .filter((row) => row.score >= Math.max(1, best - 2))
    .map((row) => row.entry);
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
  if (plan.length > 0 && matches.length === 0) return { reason: "query_mismatch" };
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
    query_mismatch: 0,
    bot_author: 0,
    deleted: 0,
    nsfw: 0,
    missing_timestamp: 0,
    outside_window: 0,
  };
}

function boundedSearchTime(
  configured: ApifySearchActorInput["time"],
  since: string | undefined,
  now = Date.now(),
): ApifySearchActorInput["time"] {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(sinceMs) || sinceMs > now) return configured;

  const ageDays = (now - sinceMs) / 86_400_000;
  const requested: ApifySearchActorInput["time"] =
    ageDays <= 1.25 ? "day" : ageDays <= 8 ? "week" : ageDays <= 32 ? "month" : configured;
  const order: ApifySearchActorInput["time"][] = ["day", "week", "month", "year", "all"];
  return order.indexOf(requested) < order.indexOf(configured) ? requested : configured;
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
    this.timeoutMs = Math.max(20_000, Math.min(600_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.timeRange = input.timeRange ?? "month";
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async runActor(actorInput: ApifyRedditActorInput): Promise<unknown[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };

    const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
      const declaredBytes = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
        throw new Error("The Apify Reddit test response exceeded the size limit.");
      }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
        throw new Error("The Apify Reddit test response exceeded the size limit.");
      }
      if (!response.ok) {
        throw new Error(`Apify Reddit test request failed with HTTP ${response.status}.`);
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("The Apify Reddit test provider returned invalid JSON.");
      }
    };

    const runData = (payload: unknown): Record<string, unknown> => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("The Apify Reddit test provider returned invalid run metadata.");
      }
      const data = (payload as { data?: unknown }).data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The Apify Reddit test provider returned invalid run metadata.");
      }
      return data as Record<string, unknown>;
    };

    try {
      const startEndpoint = new URL(
        `/v2/actors/${encodeURIComponent(this.actorId)}/runs`,
        "https://api.apify.com",
      );
      startEndpoint.searchParams.set("waitForFinish", "60");
      startEndpoint.searchParams.set("timeout", String(Math.ceil(this.timeoutMs / 1_000)));
      startEndpoint.searchParams.set("maxItems", String(Math.min(100, actorInput.maxItems)));
      startEndpoint.searchParams.set("maxTotalChargeUsd", "0.50");

      const startResponse = await this.fetchImpl(startEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
      const started = runData(await readJson(startResponse, 1_000_000));
      const runId = stringValue(started.id, 120);
      let status = stringValue(started.status, 40).toUpperCase();
      let statusMessage = stringValue(started.statusMessage, 500);
      let datasetId = stringValue(started.defaultDatasetId, 120);
      if (!runId || !status) {
        throw new Error("The Apify Reddit test provider returned incomplete run metadata.");
      }

      const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
      while (!terminalStatuses.has(status)) {
        const statusEndpoint = new URL(
          `/v2/actor-runs/${encodeURIComponent(runId)}`,
          "https://api.apify.com",
        );
        statusEndpoint.searchParams.set("waitForFinish", "60");
        const statusResponse = await this.fetchImpl(statusEndpoint, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const current = runData(await readJson(statusResponse, 1_000_000));
        status = stringValue(current.status, 40).toUpperCase();
        statusMessage = stringValue(current.statusMessage, 500);
        datasetId = stringValue(current.defaultDatasetId, 120) || datasetId;
        if (!status) {
          throw new Error("The Apify Reddit test provider returned incomplete run status.");
        }
      }

      if (status !== "SUCCEEDED") {
        throw new Error(
          `The Apify Reddit test run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`,
        );
      }
      if (!datasetId) {
        throw new Error("The Apify Reddit test run completed without a dataset.");
      }

      const datasetEndpoint = new URL(
        `/v2/datasets/${encodeURIComponent(datasetId)}/items`,
        "https://api.apify.com",
      );
      datasetEndpoint.searchParams.set("clean", "true");
      datasetEndpoint.searchParams.set("format", "json");
      datasetEndpoint.searchParams.set("limit", String(Math.min(100, actorInput.maxItems)));

      const datasetResponse = await this.fetchImpl(datasetEndpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const payload = await readJson(datasetResponse, 5_000_000);
      if (!Array.isArray(payload)) {
        throw new Error("The Apify Reddit test provider returned an invalid dataset.");
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("The Apify Reddit test run timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      sort: "relevance",
      time: boundedSearchTime(this.timeRange, request.since),
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

    const candidates = [...byKey.values()].slice(0, maxItems).map((candidate) => {
      const normalized = { ...candidate };
      Reflect.deleteProperty(normalized, "item");
      return normalized;
    });
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
      maxItems: Math.min(
        100,
        Math.max(
          APIFY_REDDIT_ENRICHMENT_MIN_ITEMS,
          candidates.length * (maxComments + 1),
        ),
      ),
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
      timeoutMs: positiveInteger(env.APIFY_REDDIT_TIMEOUT_MS, 360_000, 20_000, 600_000),
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
