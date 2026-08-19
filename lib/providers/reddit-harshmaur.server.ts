import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditDiscoveryCandidate,
  RedditSearchLane,
  RedditStructuredContext,
} from "@/lib/domain/types";
import type {
  RedditDiscoveryDiagnostics,
  RedditDiscoveryResponse,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchPlanEntry,
  RedditSearchRequest,
} from "@/lib/providers/contracts";
import { contentFingerprint } from "@/lib/intelligence/opportunity-ranking";
import { naturalSearchTerms } from "@/lib/providers/reddit-natural-queries";
import { redditQueryFamilies } from "@/lib/providers/reddit-query-families";
import { redditSearchUrl } from "@/lib/providers/reddit-search-url";

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
 * entry, matching the schema's documented "total across all inputs"
 * semantics used for `searchTerms` too. Whether the actor can starve later
 * URLs in a many-URL run under that shared budget has not been verified
 * against a live run; if a production scan shows early URLs crowding out
 * later ones, splitting into per-URL runs is the fix.
 */
export function buildHarshmaurDirectInput(
  request: RedditSearchRequest,
  options: { targetTotal: number; maxQueries?: number },
): HarshmaurDirectDiscoveryInput {
  const families = redditQueryFamilies(request, { maxQueries: options.maxQueries ?? 12 });
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
    maxPostsCount: Math.max(1, Math.trunc(options.targetTotal)),
    maxCommentsCount: 0,
    maxCommentsPerPost: 0,
    maxCommunitiesCount: 0,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
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
    this.timeoutMs = Math.max(20_000, Math.min(600_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.maxChargeUsd = Math.max(0.05, Math.min(5, input.maxChargeUsd ?? 1));
    this.enrichmentLimit = Math.max(1, Math.min(20, Math.trunc(input.enrichmentLimit ?? 8)));
    this.enrichmentComments = Math.max(1, Math.min(50, Math.trunc(input.enrichmentComments ?? 6)));
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

    const readJson = async (response: Response): Promise<unknown> => {
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Harshmaur request failed with HTTP ${response.status}.`);
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("The Harshmaur actor returned invalid JSON.");
      }
    };

    const safeGet = async (endpoint: URL): Promise<Response> => {
      const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.fetchImpl(endpoint, {
            headers,
            signal: controller.signal,
          });
          if (!retryable.has(response.status)) return response;
          await response.text().catch(() => "");
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt === 2) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
      }
      throw lastError ?? new Error("Harshmaur GET request failed.");
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

      const startResponse = await this.fetchImpl(startEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
      const started = runData(await readJson(startResponse));
      const runId = str(started.id);
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
        throw new Error(
          `The Harshmaur run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`,
        );
      }
      if (!datasetId) throw new Error("The Harshmaur run completed without a dataset.");

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
      return payload;
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
  ): Promise<RedditDiscoveryResponse> {
    // Headroom over the target so per-query rounding cannot silently
    // truncate, while still capping spend at the platform level.
    const platformMaxItems = Math.min(1_000, Math.ceil(targetTotal * 1.3));
    const payload = await this.runActor(actorInput, platformMaxItems);
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
  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const targetTotal = Math.min(this.maximumItems, Math.max(40, request.limit));

    if (this.discoveryMode === "direct-url") {
      const families = redditQueryFamilies(request, { maxQueries: this.maxQueries });
      if (families.length > 0) {
        const directInput = buildHarshmaurDirectInput(request, {
          targetTotal,
          maxQueries: this.maxQueries,
        });
        const searchPlan: RedditSearchPlanEntry[] = families.map((family) => ({
          lane: family.lane,
          query: family.query,
          seed: family.query,
        }));
        return this.runDiscovery(directInput, request, searchPlan, targetTotal);
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
    return this.runDiscovery(actorInput, request, searchPlan, targetTotal);
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
