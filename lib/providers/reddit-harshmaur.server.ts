import type {
  RedditDiscoveryCandidate,
  RedditSearchLane,
} from "@/lib/domain/types";
import type { RedditSearchRequest } from "@/lib/providers/contracts";
import { naturalSearchTerms } from "@/lib/providers/reddit-natural-queries";

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
  searchSort: "new" | "relevance" | "top";
  /** Bounded acquisition; the actor stops once this many records exist. */
  maxItems: number;
  /** ISO date bounds; the actor filters server-side where supported. */
  postedAfter?: string;
  commentedAfter?: string;
}

export interface HarshmaurRunSummary {
  /** Records returned per search term, for per-term yield reporting. */
  rawByTerm: Record<string, number>;
  rawRecords: number;
  posts: number;
  comments: number;
  droppedByReason: Record<string, number>;
}

/** Exact previous-7-day bounds, used for both actor input and local checks. */
export function sevenDayWindow(now: Date = new Date()): { since: string; until: string } {
  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

export function buildHarshmaurInput(
  request: RedditSearchRequest,
  options: { maxItems: number; now?: Date; maxTerms?: number },
): HarshmaurActorInput {
  const { since } = sevenDayWindow(options.now);
  const windowStart = request.since && Number.isFinite(Date.parse(request.since))
    ? request.since
    : since;

  return {
    searchTerms: naturalSearchTerms(request, { maxTerms: options.maxTerms ?? 12 }),
    searchPosts: true,
    searchComments: true,
    // Community records are directory entries, not conversations.
    searchCommunities: false,
    // "new" keeps the window honest; relevance re-ranks across all time and
    // would quietly return records outside the seven days we asked for.
    searchSort: "new",
    maxItems: Math.max(1, Math.trunc(options.maxItems)),
    postedAfter: windowStart,
    commentedAfter: windowStart,
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
  if (!body && !title) return { candidate: null, reason: "empty_content" };

  const subreddit = subredditName(row.subreddit ?? row.community ?? row.subredditName);
  if (!subreddit) return { candidate: null, reason: "invalid_record" };

  const createdAt = isoTimestamp(row.createdAt ?? row.created ?? row.createdUtc ?? row.timestamp);
  if (!createdAt) return { candidate: null, reason: "missing_timestamp" };

  // Second guard: never trust the actor's own date filtering.
  const created = Date.parse(createdAt);
  if (created < Date.parse(options.since)) return { candidate: null, reason: "outside_window" };
  if (options.until && created > Date.parse(options.until) + 60_000) {
    return { candidate: null, reason: "outside_window" };
  }

  const permalink = permalinkFor(row.url ?? row.permalink ?? row.link);
  if (!permalink) return { candidate: null, reason: "invalid_url" };

  const author = text(row.author ?? row.username ?? row.authorName);
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
      parentExternalId: text(row.postId ?? row.parentId),
      subreddit,
      title,
      body: body || title || "",
      author,
      permalink,
      createdAt,
      metrics: {
        score: count(row.score ?? row.upVotes ?? row.upvotes),
        comments: count(row.numberOfComments ?? row.commentCount ?? row.numComments),
      },
      matchedQuery,
      matchedQueries: matchedQuery ? [matchedQuery] : [],
      discoveryLanes: options.lanes ?? [],
      provenance: {
        id: `src_reddit_${externalId}`,
        kind: "reddit",
        retrievedAt: new Date().toISOString(),
        url: permalink,
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
