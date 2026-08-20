import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditDiscoveryCandidate,
  RedditSearchLane,
  RedditStructuredContext,
} from "@/lib/domain/types";
import type {
  RedditDiscoverOptions,
  RedditDiscoveryDiagnostics,
  RedditDiscoveryResponse,
  RedditDiscoveryRetryNotice,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchPlanEntry,
  RedditSearchRequest,
} from "@/lib/providers/contracts";
import { contentFingerprint } from "@/lib/intelligence/opportunity-ranking";
import { naturalSearchTerms } from "@/lib/providers/reddit-natural-queries";
import { redditQueryFamilies, type RedditQueryFamily } from "@/lib/providers/reddit-query-families";
import { redditSearchUrl } from "@/lib/providers/reddit-search-url";
import { ApifyTransientError, APIFY_RETRYABLE_RUN_STATUSES, isApifyRetryableHttpStatus } from "@/lib/providers/apify-retry";
import { withRetry } from "@/lib/server/resilience";

/**
 * Adapter for the `harshmaur/reddit-scraper` Apify actor.
 *
 * This is a separate provider rather than a different `APIFY_REDDIT_ACTOR_ID`
 * because the input and output schemas differ from Trudax in kind, not degree:
 * Harshmaur takes a list of plain `searchTerms` and searches posts and comments
 * directly, returning records with their own field names and its own notion of
 * which term produced them. Both providers still emit the same normalized
 * RedditDiscoveryCandidate, so everything downstream is unchanged.
 *
 * Retrieval philosophy: search broadly on short natural phrases and let
 * DemandSift's AI classify. Reddit search is not an intent classifier.
 */

export interface HarshmaurActorInput {
  searchTerms: string[];
  searchPosts: boolean;
  searchComments: boolean;
  searchCommunities: boolean;
  searchSort: "new";
  searchTime: "week";
  /** Server-side cutoffs; our own timestamp check still runs afterwards. */
  postedAfter: string;
  commentedAfter: string;
  /** Discovery never crawls threads; enrichment is a separate, later pass. */
  crawlCommentsPerPost: false;
  includeNSFW: false;
  /**
   * Global caps across all search terms, not per term. The schema states
   * "total across all inputs", so these bound the whole run.
   */
  maxPostsCount: number;
  maxCommentsCount: number;
  maxCommentsPerPost: 0;
  maxCommunitiesCount: 0;
}

/**
 * Input for the actor's "Direct URLs" mode with per-post comment crawling.
 * A completely separate shape from `HarshmaurActorInput`: enrichment scrapes
 * specific known threads (`startUrls`) rather than searching, and turns on
 * `crawlCommentsPerPost` so each post's comments -- including nested replies,
 * distinguished by `parentKind`/`depth`/`parentId` in the returned comment
 * records -- are fetched, which is exactly the thread context deep
 * qualification needs and discovery intentionally never asked for.
 */
export interface HarshmaurEnrichmentInput {
  searchTerms: [];
  startUrls: { url: string }[];
  crawlCommentsPerPost: true;
  includeNSFW: false;
  maxPostsCount: number;
  /** Keyword-search-only field; irrelevant to startUrls, kept at 0. */
  maxCommentsCount: 0;
  maxCommentsPerPost: number;
  maxCommunitiesCount: 0;
}

/**
 * Input for Direct Reddit search-page URLs (`startUrls` + `fastMode:false`),
 * the primary discovery path.
 *
 * A manual side-by-side Apify test found this route -- Harshmaur driving an
 * actual Playwright pass over `reddit.com/search/?q=...` -- surfaced
 * substantially more relevant conversations than the plain `searchTerms`
 * path at the same post count, because it goes through Reddit's real search
 * page rather than a faster internal shortcut. `searchTerms` always uses
 * that faster path regardless of `fastMode`, which is why this is a
 * genuinely different actor mode rather than a flag on the existing one.
 *
 * `searchSort`/`searchTime`/`postedAfter`/`commentedAfter` are Keyword-
 * search-only fields per the actor's own schema and do not apply to
 * `startUrls`; the time window instead lives in each URL's own `&t=`
 * parameter, and -- as with every other retrieval path here -- is still
 * re-verified per record after scraping rather than trusted.
 *
 * Comment search is not available in this mode (`searchComments` is a
 * Keyword-search-only option too), so this is posts-only; comments still
 * arrive later through per-thread enrichment via `HarshmaurEnrichmentInput`.
 */
export interface HarshmaurDirectDiscoveryInput {
  searchTerms: [];
  searchPosts: true;
  searchComments: false;
  searchCommunities: false;
  startUrls: { url: string }[];
  fastMode: false;
  crawlCommentsPerPost: false;
  includeNSFW: false;
  maxPostsCount: number;
  maxCommentsCount: 0;
  maxCommentsPerPost: 0;
  maxCommunitiesCount: 0;
  proxy: { useApifyProxy: true; apifyProxyGroups: ["RESIDENTIAL"] };
}

export interface HarshmaurRunSummary {
  /** Records returned per search term, for per-term yield reporting. */
  rawByTerm: Record<string, number>;
  rawRecords: number;
  posts: number;
  comments: number;
  droppedByReason: Record<string, number>;
}

/**
 * Normalize an actor reference to Apify's path form. Mirrors the Trudax
 * normalizer: `username/actor` becomes `username~actor`, and anything else is
 * rejected rather than silently requested.
 */
export function harshmaurActorId(value: string): string {
  const normalized = value.trim().replace("/", "~");
  if (!/^(?:[A-Za-z0-9_-]{5,80}|[A-Za-z0-9_-]{1,80}~[A-Za-z0-9_-]{1,100})$/.test(normalized)) {
    throw new Error("HARSHMAUR_REDDIT_ACTOR_ID is invalid.");
  }
  return normalized;
}

/** Exact previous-7-day bounds, used for both actor input and local checks. */
export function sevenDayWindow(now: Date = new Date()): { since: string; until: string } {
  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

/**
 * Split a global acquisition target between posts and comments.
 *
 * `maxPostsCount` and `maxCommentsCount` are documented as totals across all
 * search results, not per-term quotas, so the target is divided by kind rather
 * than by the number of terms. An earlier version divided by term count, which
 * would have under-requested by roughly an order of magnitude and made a
 * Trudax comparison meaningless.
 *
 * Per-term yield is still measurable: every record carries its own
 * `searchTerm`, so attribution comes from the returned data rather than from
 * separate caps.
 */
export function harshmaurAcquisitionBudget(
  targetTotal: number,
): { maxPostsCount: number; maxCommentsCount: number } {
  const total = Math.max(2, Math.trunc(targetTotal));
  const posts = Math.max(1, Math.floor(total / 2));
  return { maxPostsCount: posts, maxCommentsCount: Math.max(1, total - posts) };
}

export function buildHarshmaurInput(
  request: RedditSearchRequest,
  options: { targetTotal: number; now?: Date; maxTerms?: number },
): HarshmaurActorInput {
  const { since } = sevenDayWindow(options.now);
  const windowStart = request.since && Number.isFinite(Date.parse(request.since))
    ? request.since
    : since;

  const searchTerms = naturalSearchTerms(request, { maxTerms: options.maxTerms ?? 8 });
  const { maxPostsCount, maxCommentsCount } = harshmaurAcquisitionBudget(options.targetTotal);

  return {
    searchTerms,
    searchPosts: true,
    searchComments: true,
    // Community records are directory entries, not conversations.
    searchCommunities: false,
    // "new" keeps the window honest; "relevance" re-ranks across all time and
    // would return records from outside the seven days we asked for.
    searchSort: "new",
    searchTime: "week",
    postedAfter: windowStart,
    commentedAfter: windowStart,
    crawlCommentsPerPost: false,
    includeNSFW: false,
    maxPostsCount,
    maxCommentsCount,
    maxCommentsPerPost: 0,
    maxCommunitiesCount: 0,
  };
}

/**
 * Build the Direct-URL discovery input: one Reddit search-page URL per
 * query family, each URL generated deterministically rather than ever
 * copied from Reddit's own UI (which carries extra tracking params this
 * actor build rejects -- see `redditSearchUrl`).
 *
 * `maxPostsCount` is requested as a flat total across every `startUrls`
 * entry in THIS call, matching the schema's documented "total across all
 * inputs" semantics used for `searchTerms` too -- a many-URL run can starve
 * later URLs under a shared budget. `queriesPerRun` defaults to 1 (see its
 * doc comment) specifically so each call here normally has exactly one
 * `startUrls` entry, which makes that starvation risk moot: the caller
 * multiplies `postsPerQuery` by the number of queries actually in this
 * batch, so `targetTotal` here is already sized for however many URLs are
 * about to share it.
 */
function directDiscoveryInputFromFamilies(
  families: RedditQueryFamily[],
  targetTotal: number,
): HarshmaurDirectDiscoveryInput {
  const startUrls = families.map((family) => ({ url: redditSearchUrl(family.query, { time: "week" }) }));
  return {
    searchTerms: [],
    searchPosts: true,
    searchComments: false,
    searchCommunities: false,
    startUrls,
    fastMode: false,
    crawlCommentsPerPost: false,
    includeNSFW: false,
    maxPostsCount: Math.max(1, Math.trunc(targetTotal)),
    maxCommentsCount: 0,
    maxCommentsPerPost: 0,
    maxCommunitiesCount: 0,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };
}

export function buildHarshmaurDirectInput(
  request: RedditSearchRequest,
  options: { targetTotal: number; maxQueries?: number },
): HarshmaurDirectDiscoveryInput {
  const families = redditQueryFamilies(request, { maxQueries: options.maxQueries ?? 12 });
  return directDiscoveryInputFromFamilies(families, options.targetTotal);
}

function emptyRejectionCounts(): RedditDiscoveryDiagnostics["rejectedByReason"] {
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

/**
 * Combine several independently-run query batches into one response. Simple
 * concatenation is safe: `cleanDiscoveryCandidates` downstream already
 * dedupes overlapping records across batches by content hash, permalink and
 * near-duplicate token overlap.
 */
function mergeDiscoveryResponses(
  responses: RedditDiscoveryResponse[],
  sourceMode: RedditDiscoveryResponse["sourceMode"],
): RedditDiscoveryResponse {
  const candidates: RedditDiscoveryCandidate[] = [];
  const searchPlan: RedditSearchPlanEntry[] = [];
  const rejectedByReason = emptyRejectionCounts();
  const laneQueryCounts: Partial<Record<RedditSearchLane, number>> = {};
  let queryCount = 0;
  let fetchedCandidates = 0;
  let normalizedCandidates = 0;
  let verifiedRecentCandidates = 0;
  let retryAttempts = 0;

  for (const response of responses) {
    candidates.push(...response.candidates);
    searchPlan.push(...response.searchPlan);
    queryCount += response.diagnostics.queryCount;
    fetchedCandidates += response.diagnostics.fetchedCandidates;
    normalizedCandidates += response.diagnostics.normalizedCandidates;
    verifiedRecentCandidates += response.diagnostics.verifiedRecentCandidates;
    retryAttempts += response.diagnostics.retryAttempts ?? 0;
    for (const [reason, count] of Object.entries(response.diagnostics.rejectedByReason)) {
      const key = reason as keyof typeof rejectedByReason;
      rejectedByReason[key] = (rejectedByReason[key] ?? 0) + count;
    }
    for (const [lane, count] of Object.entries(response.diagnostics.laneQueryCounts)) {
      const key = lane as RedditSearchLane;
      laneQueryCounts[key] = (laneQueryCounts[key] ?? 0) + (count ?? 0);
    }
  }

  return {
    candidates,
    searchPlan,
    sourceMode,
    diagnostics: {
      queryCount,
      fetchedCandidates,
      normalizedCandidates,
      verifiedRecentCandidates,
      rejectedByReason,
      laneQueryCounts,
      retryAttempts,
    },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Harshmaur emits epoch seconds for some record types.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function subredditName(value: unknown): string | undefined {
  const raw = text(value);
  return raw ? raw.replace(/^\/?r\//i, "") : undefined;
}

function permalinkFor(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://www.reddit.com${raw.startsWith("/") ? "" : "/"}${raw}`;
}

export interface HarshmaurParseOptions {
  /** Records older than this are discarded regardless of actor filtering. */
  since: string;
  until?: string;
  lanes?: RedditSearchLane[];
}

/**
 * Normalize one Harshmaur record.
 *
 * The actor's own `searchTerm` is preserved verbatim as the matched query so
 * per-term yield can be reported honestly; it is never reconstructed by
 * guessing which of our phrases the record resembles.
 */
export function harshmaurCandidate(
  value: unknown,
  options: HarshmaurParseOptions,
): { candidate: RedditDiscoveryCandidate | null; reason?: string } {
  if (!value || typeof value !== "object") return { candidate: null, reason: "invalid_record" };
  const row = value as Record<string, unknown>;

  const kindRaw = (text(row.type) ?? text(row.dataType) ?? "").toLowerCase();
  const looksLikeComment = kindRaw.includes("comment") || Boolean(row.postId ?? row.parentId);
  const kind: RedditDiscoveryCandidate["kind"] = looksLikeComment ? "comment" : "post";

  const externalId = text(row.id) ?? text(row.commentId) ?? text(row.postId);
  if (!externalId) return { candidate: null, reason: "invalid_record" };

  const body = text(row.body) ?? text(row.text) ?? text(row.selftext) ?? "";
  const title = text(row.title);
  if (!body && !title) return { candidate: null, reason: "invalid_record" };

  const subreddit = subredditName(
    row.subredditName ?? row.subreddit ?? row.communityName ?? row.community,
  );
  if (!subreddit) return { candidate: null, reason: "invalid_record" };

  // Harshmaur names the comment timestamp differently from the post one, so a
  // parser that only looked for `createdAt` rejected every real comment-search
  // result as missing_timestamp.
  const createdAt = isoTimestamp(
    kind === "comment"
      ? row.commentCreatedAt ?? row.createdAt ?? row.created ?? row.createdUtc ?? row.timestamp
      : row.createdAt ?? row.postCreatedAt ?? row.created ?? row.createdUtc ?? row.timestamp,
  );
  if (!createdAt) return { candidate: null, reason: "missing_timestamp" };

  // Second guard: never trust the actor's own date filtering.
  const created = Date.parse(createdAt);
  if (created < Date.parse(options.since)) return { candidate: null, reason: "outside_window" };
  if (options.until && created > Date.parse(options.until) + 60_000) {
    return { candidate: null, reason: "outside_window" };
  }

  // Comments carry `url` for the comment itself and `postUrl` for its parent
  // post. Preferring postUrl for a comment would point every piece of comment
  // evidence at the thread instead of the exact statement we qualified on.
  const permalink = permalinkFor(
    kind === "comment"
      ? row.url ?? row.permalink ?? row.postUrl ?? row.link
      : row.postUrl ?? row.url ?? row.permalink ?? row.link,
  );
  if (!permalink) return { candidate: null, reason: "invalid_url" };

  const author = text(row.authorName ?? row.author ?? row.username);
  if (author && /^(automoderator|\[deleted\])$/i.test(author)) {
    return { candidate: null, reason: "bot_author" };
  }

  // Attribution comes from the actor, verbatim.
  const matchedQuery = text(row.searchTerm ?? row.searchQuery ?? row.query);

  return {
    candidate: {
      provider: "apify-harshmaur-reddit",
      sourceMode: "live",
      externalId,
      kind,
      // `parentId` is the immediate parent, `postId` the thread root. Using
      // postId first flattened nested replies onto the post.
      parentExternalId:
        kind === "comment" ? text(row.parentId ?? row.postId) : undefined,
      subreddit,
      title,
      body: body || title || "",
      author,
      permalink,
      createdAt,
      metrics: {
        score: count(row.score ?? row.upVotes ?? row.upvotes),
        // `commentsCount` is the field the real post output uses.
        comments: count(
          row.commentsCount ?? row.numberOfComments ?? row.commentCount ?? row.numComments,
        ),
      },
      matchedQuery,
      matchedQueries: matchedQuery ? [matchedQuery] : [],
      discoveryLanes: options.lanes ?? [],
      provenance: {
        id: `reddit_harshmaur_${contentFingerprint(externalId)}`,
        kind: "reddit",
        provider: "apify-harshmaur-reddit",
        providerExternalId: externalId,
        url: permalink,
        title,
        excerpt: (body || title || "").slice(0, 280),
        contentHash: contentFingerprint(`${title ?? ""}\n${body}`),
        observedAt: new Date().toISOString(),
        isMock: false,
        metadata: {
          acquisitionMethod: "web-scraping",
          // The actor's own attribution, kept for per-term yield reporting.
          searchTerm: matchedQuery ?? null,
        },
      },
    },
    reason: undefined,
  };
}

/** Normalize a full dataset, deduplicating by external id. */
export function parseHarshmaurDataset(
  payload: readonly unknown[],
  options: HarshmaurParseOptions,
): { candidates: RedditDiscoveryCandidate[]; summary: HarshmaurRunSummary } {
  const seen = new Map<string, RedditDiscoveryCandidate>();
  const summary: HarshmaurRunSummary = {
    rawByTerm: {},
    rawRecords: payload.length,
    posts: 0,
    comments: 0,
    droppedByReason: {},
  };

  for (const value of payload) {
    const term =
      (value && typeof value === "object"
        ? text((value as Record<string, unknown>).searchTerm)
        : undefined) ?? "<unattributed>";
    summary.rawByTerm[term] = (summary.rawByTerm[term] ?? 0) + 1;

    const { candidate, reason } = harshmaurCandidate(value, options);
    if (!candidate) {
      const key = reason ?? "unknown";
      summary.droppedByReason[key] = (summary.droppedByReason[key] ?? 0) + 1;
      continue;
    }

    const existing = seen.get(candidate.externalId);
    if (existing) {
      // The same record can arrive from several terms; keep every attribution.
      for (const query of candidate.matchedQueries) {
        if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
      }
      continue;
    }
    seen.set(candidate.externalId, candidate);
    if (candidate.kind === "comment") summary.comments += 1;
    else summary.posts += 1;
  }

  return { candidates: [...seen.values()], summary };
}


/* ------------------------------------------------------------------ *
 * Thread enrichment parsing
 *
 * Harshmaur's "Direct URLs + crawlCommentsPerPost" mode returns the same
 * `post`/`comment` shapes as search, but comments additionally carry
 * `parentKind` ("post" | "comment") and `depth` (0 = top-level), so the
 * thread tree is reconstructible directly from `parentId`/`postId` without
 * guessing. This mirrors the Trudax provider's structured-context builder in
 * shape, but reads Harshmaur's own field names -- the two providers'
 * enrichment payloads differ in kind, the same reason discovery has two
 * separate parsers.
 * ------------------------------------------------------------------ */

function stripThingPrefix(value: string | undefined): string | undefined {
  return value ? value.replace(/^t[13]_/i, "") : undefined;
}

function normalizedId(value: string | undefined): string | undefined {
  const stripped = stripThingPrefix(value);
  return stripped ? stripped.toLowerCase() : undefined;
}

/** Extracts the bare post id (`comments/<id>/...`) from any Reddit permalink. */
function harshmaurPostIdFromPermalink(value: string | undefined): string | undefined {
  if (!value) return undefined;
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

/** Canonicalizes any post/comment permalink to the post-level thread URL Harshmaur's `startUrls` expects. */
function harshmaurThreadStartUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "redd.it") {
      url.hash = "";
      url.search = "";
      return url.toString();
    }
    if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    if (commentsIndex < 0 || !segments[commentsIndex + 1]) return undefined;
    const titleIndex = commentsIndex + 2;
    const end = segments[titleIndex] ? titleIndex + 1 : commentsIndex + 2;
    url.pathname = `/${segments.slice(0, end).join("/")}/`;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

interface HarshmaurThreadItem {
  message: RedditContextMessage;
  /** Bare id of the post this item belongs to, for scoping items to one thread. */
  postId: string | undefined;
}

function harshmaurThreadItem(value: unknown): HarshmaurThreadItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const dataType = (text(row.dataType ?? row.type) ?? "").toLowerCase();

  if (dataType === "post") {
    const externalId = text(row.parsedId) ?? stripThingPrefix(text(row.id));
    const body = text(row.body) ?? text(row.title);
    if (!externalId || !body || /^\[(?:deleted|removed)\]$/i.test(body)) return null;
    return {
      postId: externalId.toLowerCase(),
      message: {
        externalId,
        kind: "post",
        author: text(row.authorName),
        body,
        parentExternalId: undefined,
        createdAt: isoTimestamp(row.createdAt) ?? undefined,
      },
    };
  }

  if (dataType === "comment") {
    const externalId = text(row.id);
    const body = text(row.body);
    if (!externalId || !body || /^\[(?:deleted|removed)\]$/i.test(body)) return null;
    const postId = normalizedId(text(row.parsedPostId) ?? text(row.postId));
    const parentId = normalizedId(text(row.parsedParentId) ?? text(row.parentId));
    return {
      postId,
      message: {
        externalId,
        kind: "comment",
        author: text(row.authorName),
        body,
        parentExternalId: parentId,
        createdAt: isoTimestamp(row.commentCreatedAt) ?? undefined,
      },
    };
  }

  return null;
}

/** True when the run actually reached this candidate's thread, regardless of whether the exact matched item was re-emitted. */
function harshmaurHasThreadAnchor(candidate: RedditDiscoveryCandidate, payload: readonly unknown[]): boolean {
  const candidatePostId = harshmaurPostIdFromPermalink(candidate.permalink);
  if (!candidatePostId) return false;
  return payload.some((value) => {
    const item = harshmaurThreadItem(value);
    return Boolean(item && item.postId === candidatePostId);
  });
}

function harshmaurStructuredContext(
  candidate: RedditDiscoveryCandidate,
  payload: readonly unknown[],
): RedditStructuredContext {
  const candidatePostId = harshmaurPostIdFromPermalink(candidate.permalink);
  const items = payload.flatMap((value) => {
    const item = harshmaurThreadItem(value);
    if (!item || (candidatePostId && item.postId && item.postId !== candidatePostId)) return [];
    return [item.message];
  });
  const byId = new Map(items.map((message) => [normalizedId(message.externalId) as string, message]));
  const matched = byId.get(normalizedId(candidate.externalId) as string) ?? {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  const originalPost = items.find((message) => message.kind === "post") ??
    (candidate.kind === "post" ? matched : undefined);

  const parentChain: RedditContextMessage[] = [];
  let parentId = normalizedId(matched.parentExternalId);
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId) && parentChain.length < 6) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parentChain.unshift(parent);
    parentId = normalizedId(parent.parentExternalId);
  }

  const matchedId = normalizedId(candidate.externalId);
  const replies = items
    .filter((message) => message.kind === "comment" && normalizedId(message.parentExternalId) === matchedId)
    .slice(0, 6);
  const used = new Set([
    normalizedId(matched.externalId),
    ...parentChain.map((message) => normalizedId(message.externalId)),
    ...replies.map((message) => normalizedId(message.externalId)),
    ...(originalPost ? [normalizedId(originalPost.externalId)] : []),
  ]);
  const surroundingComments = items
    .filter((message) => message.kind === "comment" && !used.has(normalizedId(message.externalId)))
    .slice(0, 6);

  return { originalPost, matched, parentChain, replies, surroundingComments };
}

function flattenHarshmaurContext(context: RedditStructuredContext): string {
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

/** Discovery-record-only conversation, used when a thread could not be reached. */
function harshmaurDiscoveryOnlyConversation(candidate: RedditDiscoveryCandidate): EnrichedRedditConversation {
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
    threadContext: undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/**
 * Executes the Harshmaur actor and returns candidates through the shared
 * contract, so the scan workflow cannot tell which actor produced them.
 *
 * Discovery and thread enrichment are two independent actor runs against the
 * same actor: discovery searches (`searchTerms`, `crawlCommentsPerPost:
 * false`), enrichment crawls specific shortlisted threads directly
 * (`startUrls`, `crawlCommentsPerPost: true`, bounded `maxCommentsPerPost`).
 */
export class HarshmaurRedditProvider implements RedditProvider {
  readonly name = "apify-harshmaur-reddit";
  readonly sourceMode = "live" as const;
  readonly supportsThreadEnrichment = true;

  private readonly actorId: string;
  private readonly token: string;
  private readonly maximumItems: number;
  private readonly maxTerms: number;
  private readonly maxQueries: number;
  private readonly discoveryMode: "direct-url" | "search-terms";
  private readonly timeoutMs: number;
  private readonly maxChargeUsd: number;
  private readonly enrichmentLimit: number;
  private readonly enrichmentComments: number;
  private readonly fetchImpl: typeof fetch;
  /**
   * How many query families share a single actor run. A prior production
   * incident found 12 startUrls in one run hitting the actor's own internal
   * timeout partway through, having processed only ~25 posts -- queries
   * later in the list never ran at all, and that partial run was
   * indistinguishable from a clean search that found little. Splitting into
   * smaller batches, each its own retryable run, bounds how much a single
   * slow/failing batch can cost the others and is the fix that doc comment
   * on buildHarshmaurDirectInput anticipated.
   *
   * Defaults to 1 -- one query, one dedicated actor run -- rather than
   * batching several queries per run. This is the finest possible retry
   * granularity (a failing query only ever loses its own results, never a
   * batch-mate's) and removes the within-run starvation risk entirely,
   * since a single-query run has nothing else to starve.
   */
  private readonly queriesPerRun: number;
  /** Bounded retry attempts per query batch for transient Apify failures. */
  private readonly discoveryRetryAttempts: number;
  /**
   * Posts requested per query, not divided down as query count grows. A
   * scan's total Reddit post budget scales with however many queries it
   * actually runs (up to `postsPerQuery * families.length`) rather than a
   * single scan-wide total getting split thinner as more queries are added
   * -- the earlier design divided one shared total across all query
   * batches, so a scan with more (smaller, more targeted) queries ended up
   * requesting fewer posts per query, not more.
   */
  private readonly postsPerQuery: number;
  /**
   * How many query-batch chunks (each its own Apify actor run) may be in
   * flight at the same time. `queriesPerRun` defaulting to 1 means a
   * 9-query scan now wants 9 dedicated runs; firing all of them at once
   * with no cap regularly exceeded this Apify account's concurrent-run
   * limit, which queues the excess as "READY" runs rather than rejecting
   * them outright. Client-side retries (meant for genuine transient
   * failures) then kept starting fresh runs for chunks that were merely
   * queued, not failed, compounding a handful of queries into dozens of
   * runs. Chunks now run through a small worker pool instead of all at
   * once, so at most this many actor runs are ever open simultaneously
   * regardless of how many queries a scan has.
   */
  private readonly maxConcurrentDiscoveryRuns: number;

  constructor(input: {
    actorId?: string;
    token: string;
    maximumItems?: number;
    maxTerms?: number;
    maxQueries?: number;
    /**
     * "direct-url" (default) drives Harshmaur's `startUrls` + `fastMode:false`
     * Playwright search-page path, which a manual test found materially more
     * relevant than plain `searchTerms` at the same volume. "search-terms"
     * keeps the original, faster, lower-precision path as an explicit
     * operational fallback rather than deleting it -- flip this if Direct
     * URL discovery underperforms in production rather than silently
     * retrying with a second paid run on every call.
     */
    discoveryMode?: "direct-url" | "search-terms";
    timeoutMs?: number;
    maxChargeUsd?: number;
    enrichmentLimit?: number;
    enrichmentComments?: number;
    queriesPerRun?: number;
    discoveryRetryAttempts?: number;
    postsPerQuery?: number;
    maxConcurrentDiscoveryRuns?: number;
    fetchImpl?: typeof fetch;
  }) {
    // Apify's API path takes an actor id or `username~actor-name`; a slash
    // would be percent-encoded and resolve to nothing.
    this.actorId = harshmaurActorId(input.actorId?.trim() || "harshmaur~reddit-scraper");
    this.token = input.token;
    this.maximumItems = Math.max(1, Math.min(400, Math.trunc(input.maximumItems ?? 40)));
    this.maxTerms = Math.max(1, Math.min(25, Math.trunc(input.maxTerms ?? 8)));
    this.maxQueries = Math.max(1, Math.min(20, Math.trunc(input.maxQueries ?? 12)));
    this.discoveryMode = input.discoveryMode ?? "direct-url";
    this.timeoutMs = Math.max(20_000, Math.min(900_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.maxChargeUsd = Math.max(0.05, Math.min(5, input.maxChargeUsd ?? 1));
    this.enrichmentLimit = Math.max(1, Math.min(20, Math.trunc(input.enrichmentLimit ?? 8)));
    this.enrichmentComments = Math.max(1, Math.min(50, Math.trunc(input.enrichmentComments ?? 6)));
    this.queriesPerRun = Math.max(1, Math.min(this.maxQueries, Math.trunc(input.queriesPerRun ?? 1)));
    this.discoveryRetryAttempts = Math.max(1, Math.min(5, Math.trunc(input.discoveryRetryAttempts ?? 3)));
    this.postsPerQuery = Math.max(5, Math.min(100, Math.trunc(input.postsPerQuery ?? 20)));
    this.maxConcurrentDiscoveryRuns = Math.max(1, Math.min(9, Math.trunc(input.maxConcurrentDiscoveryRuns ?? 3)));
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  /**
   * Start the actor asynchronously, poll to a terminal state, then page the
   * dataset.
   *
   * `/run-sync` is deliberately not used: it returns the actor's OUTPUT record
   * rather than run metadata, so `defaultDatasetId` is absent, and holding a
   * non-idempotent POST open makes a transient gateway 502 ambiguous — a retry
   * could start and bill a second run. Once the run id exists, all waiting and
   * reading happens through retry-safe GETs. This mirrors the pattern already
   * proven in the Trudax provider.
   */
  private async runActor(
    actorInput: HarshmaurActorInput | HarshmaurEnrichmentInput | HarshmaurDirectDiscoveryInput,
    platformMaxItems: number,
  ): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    // Set once the run actually exists, so a client-side give-up (below)
    // can tell Apify to actually cancel it instead of leaving it
    // running/queued while a retry starts a second one on top of it.
    let capturedRunId = "";

    const readJson = async (response: Response): Promise<unknown> => {
      const raw = await response.text();
      if (!response.ok) {
        const message = `Harshmaur request failed with HTTP ${response.status}.`;
        throw isApifyRetryableHttpStatus(response.status)
          ? new ApifyTransientError(message)
          : new Error(message);
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("The Harshmaur actor returned invalid JSON.");
      }
    };

    const safeGet = async (endpoint: URL): Promise<Response> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.fetchImpl(endpoint, {
            headers,
            signal: controller.signal,
          });
          if (!isApifyRetryableHttpStatus(response.status)) return response;
          await response.text().catch(() => "");
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt === 2) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
      }
      throw lastError instanceof Error
        ? new ApifyTransientError(lastError.message)
        : new ApifyTransientError("Harshmaur GET request failed.");
    };

    const runData = (payload: unknown): Record<string, unknown> => {
      const data = (payload as { data?: unknown } | null)?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The Harshmaur actor returned invalid run metadata.");
      }
      return data as Record<string, unknown>;
    };

    const str = (value: unknown): string =>
      typeof value === "string" ? value.slice(0, 120) : "";

    try {
      const startEndpoint = new URL(
        `/v2/actors/${encodeURIComponent(this.actorId)}/runs`,
        "https://api.apify.com",
      );
      startEndpoint.searchParams.set("waitForFinish", "0");
      startEndpoint.searchParams.set("timeout", String(Math.ceil(this.timeoutMs / 1000)));
      // Platform-level guards. These bound cost and dataset size; they do not
      // replace the actor's own maxPostsCount/maxCommentsCount fields.
      startEndpoint.searchParams.set("maxItems", String(platformMaxItems));
      startEndpoint.searchParams.set("maxTotalChargeUsd", this.maxChargeUsd.toFixed(2));

      let startResponse: Response;
      try {
        startResponse = await this.fetchImpl(startEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(actorInput),
          signal: controller.signal,
        });
      } catch (error) {
        // No response was ever received, so no run could have been billed --
        // unlike the ambiguous-gateway-error case the module doc comment
        // warns about, this is always safe to retry.
        if (controller.signal.aborted) {
          throw new ApifyTransientError(
            `The Harshmaur actor could not be started within ${Math.ceil(this.timeoutMs / 1_000)} seconds.`,
          );
        }
        throw new ApifyTransientError(
          error instanceof Error
            ? `The Harshmaur actor could not be started: ${error.message}`
            : "The Harshmaur actor could not be started due to a network error.",
        );
      }
      const started = runData(await readJson(startResponse));
      const runId = str(started.id);
      capturedRunId = runId;
      let status = str(started.status).toUpperCase();
      let datasetId = str(started.defaultDatasetId);
      let statusMessage = str(started.statusMessage);
      if (!runId || !status) {
        throw new Error("The Harshmaur actor returned incomplete run metadata.");
      }

      const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
      while (!terminal.has(status)) {
        const statusEndpoint = new URL(
          `/v2/actor-runs/${encodeURIComponent(runId)}`,
          "https://api.apify.com",
        );
        statusEndpoint.searchParams.set("waitForFinish", "60");
        const current = runData(await readJson(await safeGet(statusEndpoint)));
        status = str(current.status).toUpperCase();
        statusMessage = str(current.statusMessage);
        datasetId = str(current.defaultDatasetId) || datasetId;
        if (!status) throw new Error("The Harshmaur actor returned incomplete run status.");
      }

      // A timed-out run that still produced records is usable; discarding it
      // would waste a paid run.
      const usablePartial = status === "TIMED-OUT" && Boolean(datasetId);
      if (status !== "SUCCEEDED" && !usablePartial) {
        const message = `The Harshmaur run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`;
        throw APIFY_RETRYABLE_RUN_STATUSES.has(status) ? new ApifyTransientError(message) : new Error(message);
      }
      if (!datasetId) throw new ApifyTransientError("The Harshmaur run completed without a dataset.");

      const pageSize = 100;
      const payload: unknown[] = [];
      for (let offset = 0; offset < platformMaxItems; offset += pageSize) {
        const limit = Math.min(pageSize, platformMaxItems - offset);
        const datasetEndpoint = new URL(
          `/v2/datasets/${encodeURIComponent(datasetId)}/items`,
          "https://api.apify.com",
        );
        datasetEndpoint.searchParams.set("clean", "true");
        datasetEndpoint.searchParams.set("format", "json");
        datasetEndpoint.searchParams.set("limit", String(limit));
        datasetEndpoint.searchParams.set("offset", String(offset));

        const page = await readJson(await safeGet(datasetEndpoint));
        if (!Array.isArray(page)) {
          throw new Error("The Harshmaur actor returned an invalid dataset.");
        }
        payload.push(...page);
        if (page.length < limit) break;
      }
      // A timed-out run whose dataset never actually received any records
      // is not a usable partial result -- it is a failed run that happened
      // to have a datasetId allocated. Treating it as success previously let
      // a full-timeout, zero-record run flow through as an ordinary
      // "searched and found nothing" result, indistinguishable from a
      // genuine zero. Mirrors the same guard already proven in the Trudax
      // provider (ApifyRedditTestProvider.runActor).
      if (usablePartial && payload.length === 0) {
        throw new ApifyTransientError(
          "The timed-out Harshmaur run did not retain any usable records.",
        );
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        if (capturedRunId) {
          // Best-effort: release the run on Apify's side so it stops
          // occupying a concurrency slot and, if it later finishes on its
          // own, doesn't bill for a run this call already gave up on and a
          // retry is about to duplicate. Never let this delay or mask the
          // real timeout error below.
          const abortEndpoint = new URL(
            `/v2/actor-runs/${encodeURIComponent(capturedRunId)}/abort`,
            "https://api.apify.com",
          );
          await this.fetchImpl(abortEndpoint, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(5_000),
          }).catch(() => {});
        }
        throw new ApifyTransientError(
          `The Harshmaur run timed out after ${Math.ceil(this.timeoutMs / 1_000)} seconds.`,
        );
      }
      if (error instanceof ApifyTransientError || error instanceof Error) throw error;
      throw new ApifyTransientError("The Harshmaur request failed with a network error.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared between both discovery modes: run the actor, parse the dataset,
   * and assemble the response the rest of the pipeline consumes. */
  private async runDiscovery(
    actorInput: HarshmaurDirectDiscoveryInput | HarshmaurActorInput,
    request: RedditSearchRequest,
    searchPlan: RedditSearchPlanEntry[],
    targetTotal: number,
    onRetry?: (notice: RedditDiscoveryRetryNotice) => void,
  ): Promise<RedditDiscoveryResponse> {
    // Headroom over the target so per-query rounding cannot silently
    // truncate, while still capping spend at the platform level.
    const platformMaxItems = Math.min(1_000, Math.ceil(targetTotal * 1.3));
    let retryAttempts = 0;
    const payload = await withRetry(() => this.runActor(actorInput, platformMaxItems), {
      attempts: this.discoveryRetryAttempts,
      initialDelayMs: 1_500,
      maximumDelayMs: 8_000,
      shouldRetry: (error) => error instanceof ApifyTransientError,
      onRetry: async (error, attempt, delayMs) => {
        retryAttempts += 1;
        await onRetry?.({
          reason: error instanceof Error ? error.message : "Reddit search hit a transient error.",
          attempt,
          maxAttempts: this.discoveryRetryAttempts,
          delayMs,
        });
      },
    });
    const window = sevenDayWindow();
    const since = request.since && Number.isFinite(Date.parse(request.since))
      ? request.since
      : window.since;
    const { candidates, summary } = parseHarshmaurDataset(payload, { since });

    const rejected: Record<string, number> = {
      invalid_record: 0,
      invalid_url: 0,
      query_mismatch: 0,
      bot_author: 0,
      deleted: 0,
      nsfw: 0,
      missing_timestamp: 0,
      outside_window: 0,
    };
    for (const [reason, value] of Object.entries(summary.droppedByReason)) {
      if (reason in rejected) rejected[reason] += value;
      else rejected.invalid_record += value;
    }

    const laneQueryCounts: Partial<Record<RedditSearchLane, number>> = {};
    for (const entry of searchPlan) {
      laneQueryCounts[entry.lane] = (laneQueryCounts[entry.lane] ?? 0) + 1;
    }

    return {
      candidates,
      searchPlan,
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: searchPlan.length,
        fetchedCandidates: summary.rawRecords,
        normalizedCandidates: candidates.length,
        verifiedRecentCandidates: candidates.length,
        rejectedByReason: rejected as RedditDiscoveryDiagnostics["rejectedByReason"],
        laneQueryCounts,
        retryAttempts,
      },
    };
  }

  /**
   * Primary discovery path: Reddit search-page URLs via `startUrls` +
   * `fastMode:false` (see `HarshmaurDirectDiscoveryInput`). Falls through to
   * the legacy `searchTerms` path only when the Discovery Profile is too
   * sparse to produce a single usable query family -- not on an actor
   * failure, which is left to propagate rather than silently doubling cost
   * with a second paid run. `discoveryMode: "search-terms"` selects the
   * legacy path outright as an operational escape hatch.
   */
  async discover(
    request: RedditSearchRequest,
    options?: RedditDiscoverOptions,
  ): Promise<RedditDiscoveryResponse> {
    const targetTotal = Math.min(this.maximumItems, Math.max(40, request.limit));

    if (this.discoveryMode === "direct-url") {
      const families = redditQueryFamilies(request, { maxQueries: this.maxQueries });
      if (families.length > 0) {
        return this.runChunkedDirectDiscovery(request, families, options?.onRetry);
      }
    }

    const actorInput = buildHarshmaurInput(request, {
      targetTotal,
      maxTerms: this.maxTerms,
    });
    if (actorInput.searchTerms.length === 0) {
      throw new Error("The company context did not produce any usable Reddit search terms.");
    }
    const searchPlan: RedditSearchPlanEntry[] = actorInput.searchTerms.map((term) => ({
      lane: "category_recommendation" as RedditSearchLane,
      query: term,
      seed: term,
    }));
    return this.runDiscovery(actorInput, request, searchPlan, targetTotal, options?.onRetry);
  }

  /**
   * Split query families across several smaller, independently-retried
   * actor runs instead of one run covering everything. This bounds how much
   * a single slow/failing batch can cost the rest (see `queriesPerRun`'s doc
   * comment) and means a batch that exhausts its retries loses only its own
   * candidates, not the whole discovery result -- other batches' results are
   * preserved rather than discarded.
   */
  private async runChunkedDirectDiscovery(
    request: RedditSearchRequest,
    families: RedditQueryFamily[],
    onRetry?: (notice: RedditDiscoveryRetryNotice) => void,
  ): Promise<RedditDiscoveryResponse> {
    const chunkSize = Math.min(families.length, this.queriesPerRun);
    const chunks: RedditQueryFamily[][] = [];
    for (let index = 0; index < families.length; index += chunkSize) {
      chunks.push(families.slice(index, index + chunkSize));
    }

    const runChunk = (chunkFamilies: RedditQueryFamily[], chunkIndex: number) => {
      // Scales with how many queries are actually in this chunk, not with
      // the overall scan-wide acquisition target -- more queries means more
      // total posts requested, not a thinner slice of a fixed pie.
      const perChunkTarget = this.postsPerQuery * chunkFamilies.length;
      const directInput = directDiscoveryInputFromFamilies(chunkFamilies, perChunkTarget);
      const searchPlan: RedditSearchPlanEntry[] = chunkFamilies.map((family) => ({
        lane: family.lane,
        query: family.query,
        seed: family.query,
      }));
      return this.runDiscovery(directInput, request, searchPlan, perChunkTarget, (notice) =>
        onRetry?.({
          ...notice,
          reason: chunks.length > 1
            ? `[query batch ${chunkIndex + 1}/${chunks.length}] ${notice.reason}`
            : notice.reason,
        }),
      );
    };

    if (chunks.length <= 1) return runChunk(families, 0);

    // Bounded worker pool rather than firing every chunk's actor-start
    // request at once: this account's Apify concurrency limit is well
    // below `chunks.length` once a scan has 6-9 queries, and starting them
    // all simultaneously queued the excess as "READY" runs which then
    // looked stuck to the client-side retry logic, which started yet more
    // runs on top of the still-queued ones. Capping concurrency keeps at
    // most `maxConcurrentDiscoveryRuns` runs open at a time; a finished
    // slot (success or retries-exhausted) picks up the next chunk.
    const outcomes: PromiseSettledResult<RedditDiscoveryResponse>[] = new Array(chunks.length);
    let nextChunkIndex = 0;
    const worker = async () => {
      while (nextChunkIndex < chunks.length) {
        const index = nextChunkIndex;
        nextChunkIndex += 1;
        try {
          outcomes[index] = { status: "fulfilled", value: await runChunk(chunks[index], index) };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    };
    const workerCount = Math.min(this.maxConcurrentDiscoveryRuns, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const succeeded: RedditDiscoveryResponse[] = [];
    const failures: unknown[] = [];
    let queriesSucceeded = 0;
    let queriesFailed = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        succeeded.push(outcome.value);
        queriesSucceeded += chunks[index].length;
      } else {
        failures.push(outcome.reason);
        queriesFailed += chunks[index].length;
      }
    });

    if (succeeded.length === 0) {
      // Every batch exhausted its retries. Surface the first failure as-is
      // -- the caller classifies it by type (ApifyTransientError vs not),
      // not by this message text.
      throw failures[0] instanceof Error
        ? failures[0]
        : new Error("Reddit discovery failed for every query batch.");
    }

    const merged = mergeDiscoveryResponses(succeeded, this.sourceMode);
    merged.diagnostics.queriesSucceeded = queriesSucceeded;
    merged.diagnostics.queriesFailed = queriesFailed;
    if (queriesFailed > 0) {
      merged.diagnostics.degraded = true;
      console.error(
        `Reddit discovery: ${failures.length} of ${chunks.length} query batches failed after ` +
          `retries; preserving ${succeeded.length} successful batch(es) rather than discarding ` +
          "the whole run.",
        failures.map((error) => (error instanceof Error ? error.message : String(error))),
      );
    }
    return merged;
  }

  /**
   * Crawls each shortlisted candidate's own thread directly via `startUrls` +
   * `crawlCommentsPerPost`, so deep qualification receives the post body plus
   * real comments and nested replies -- not just the single discovery record.
   * A candidate whose thread could not be reached falls back to a
   * discovery-only conversation rather than failing the whole batch, matching
   * the bounded-recovery philosophy the rest of the pipeline already uses.
   */
  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const candidates = request.candidates.slice(0, this.enrichmentLimit);
    if (candidates.length === 0) {
      return {
        conversations: [],
        sourceMode: this.sourceMode,
        diagnostics: { requested: 0, enriched: 0, failed: 0, fallbackUsed: 0 },
      };
    }

    const maxCommentsPerPost = Math.max(
      1,
      Math.min(50, request.maxComments ?? this.enrichmentComments),
    );
    const threadUrls = [...new Set(candidates.flatMap((candidate) => {
      const url = harshmaurThreadStartUrl(candidate.permalink);
      return url ? [url] : [];
    }))];

    if (threadUrls.length === 0) {
      return {
        conversations: candidates.map(harshmaurDiscoveryOnlyConversation),
        sourceMode: this.sourceMode,
        diagnostics: {
          requested: candidates.length,
          enriched: 0,
          failed: candidates.length,
          fallbackUsed: candidates.length,
          failureReason: "missing_reddit_thread_urls",
        },
      };
    }

    const enrichmentInput: HarshmaurEnrichmentInput = {
      searchTerms: [],
      startUrls: threadUrls.map((url) => ({ url })),
      crawlCommentsPerPost: true,
      includeNSFW: false,
      maxPostsCount: Math.max(1, threadUrls.length),
      maxCommentsCount: 0,
      maxCommentsPerPost,
      maxCommunitiesCount: 0,
    };
    // Headroom for the post itself plus its comments across every thread,
    // capped the same way discovery caps platform spend.
    const platformMaxItems = Math.min(1_000, Math.max(20, threadUrls.length * (maxCommentsPerPost + 1)));

    let payload: unknown[];
    try {
      payload = await this.runActor(enrichmentInput, platformMaxItems);
    } catch (error) {
      console.error("Harshmaur Reddit thread enrichment failed", error);
      const message = error instanceof Error ? error.message : "Unknown Harshmaur enrichment failure.";
      return {
        conversations: candidates.map(harshmaurDiscoveryOnlyConversation),
        sourceMode: this.sourceMode,
        diagnostics: {
          requested: candidates.length,
          enriched: 0,
          failed: candidates.length,
          fallbackUsed: candidates.length,
          failureReason: `actor_error:${message.slice(0, 500)}`,
        },
      };
    }

    const conversations: EnrichedRedditConversation[] = candidates.map((candidate) => {
      if (!harshmaurHasThreadAnchor(candidate, payload)) {
        return harshmaurDiscoveryOnlyConversation(candidate);
      }
      const context = harshmaurStructuredContext(candidate, payload);
      const threadContext = flattenHarshmaurContext(context);
      const contentHash = contentFingerprint(
        `${candidate.title ?? ""}
${candidate.body}
${JSON.stringify(context)}`,
      );
      return {
        ...candidate,
        threadContext: threadContext || undefined,
        structuredContext: context,
        provenance: {
          ...candidate.provenance,
          contentHash,
          observedAt: new Date().toISOString(),
          metadata: {
            ...(candidate.provenance.metadata ?? {}),
            enriched: true,
          },
        },
      };
    });

    const enrichedCount = conversations.filter(
      (conversation) => conversation.provenance.metadata?.enriched === true,
    ).length;
    const failed = candidates.length - enrichedCount;
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: candidates.length,
        enriched: enrichedCount,
        failed,
        fallbackUsed: failed,
        ...(failed > 0
          ? {
              failureReason:
                `actor_succeeded_mapping_failure:unmatched=${failed};payload_items=${payload.length}`,
            }
          : {}),
      },
    };
  }
}
